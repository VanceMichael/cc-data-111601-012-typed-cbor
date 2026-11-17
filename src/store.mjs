// Lossless intake records and typed querying.
//
// A single-item intake stores one lossless node tree; a CBOR-sequence intake
// stores one record per complete top-level item. Every record keeps the exact
// source object (`object` digest) and its `span` into that object, so the
// original bytes can be recovered with recordObject(). Values are never
// flattened into JS objects: maps stay ordered entry arrays, duplicate keys
// stay duplicate entries, and every key keeps its CBOR type.
//
// Sequence chunks may split values at arbitrary offsets, so decoding is
// incremental (CborSequenceDecoder). An incomplete tail is reported as
// `pending`; it is never scanned for a parseable suffix and never becomes a
// record.

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CborSequenceDecoder, decodeSingle } from './cbor.mjs';
import { canonicalKey, entryMatches } from './model.mjs';

function digestOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Split a whole byte sequence only at complete top-level item boundaries.
export function splitSequence(bytes, options = {}) {
  const decoder = new CborSequenceDecoder(options);
  const records = decoder.feed(bytes);
  const tail = decoder.end();
  return { records, pending: tail.pending, source: bytes };
}

export class TypedInbox {
  constructor(directory) {
    this.directory = directory;
    this.pending = Promise.resolve();
  }

  async initialize() {
    await mkdir(join(this.directory, 'objects'), { recursive: true });
    try { await this.list(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.saveIndex([]);
    }
    return this;
  }

  async saveIndex(records) {
    const temporary = join(this.directory, `index-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(records));
    await rename(temporary, join(this.directory, 'index.json'));
  }

  async list() {
    return JSON.parse(await readFile(join(this.directory, 'index.json'), 'utf8'));
  }

  // Compatibility intake: the whole object is one record. The existing
  // /intakes contract and its (source URL, digest) idempotency are unchanged.
  async accept(bytes, source, parsed) {
    const digest = digestOf(bytes);
    return this.serialize(async () => {
      const records = await this.list();
      const existing = records.find(record => record.digest === digest && record.source === source);
      if (existing) return existing;
      await writeFile(join(this.directory, 'objects', digest), bytes);
      const record = {
        id: randomUUID(), digest, source, bytes: bytes.length, kind: 'single',
        object: digest, span: { start: 0, end: bytes.length },
        value: decodeSingle(bytes).value,
        parsed,
      };
      records.push(record);
      await this.saveIndex(records);
      return record;
    });
  }

  // Convenience for callers that already hold the whole source.
  async acceptSequence(bytes, source, options = {}) {
    const { records: items, pending } = splitSequence(bytes);
    return this.acceptSequenceItems(bytes, source, { items, pending, ...options });
  }

  // Register already-decoded complete top-level items. Same (source, object
  // digest) yields the same record ids. A pending tail is reported but not
  // registered; it only succeeds with allowPending, which answers 202 when
  // there are no complete records.
  async acceptSequenceItems(bytes, source, { items, pending = null, allowPending = false } = {}) {
    const digest = digestOf(bytes);
    return this.serialize(async () => {
      const records = await this.list();
      const existing = records.filter(record => record.kind === 'sequence'
        && record.object === digest && record.source === source);
      // An already-registered object is returned as-is even if this call did
      // not opt into a pending tail, so retries stay idempotent.
      if (existing.length > 0) return { records: existing, pending, digest };
      if (pending && !allowPending) {
        const error = new Error('cbor_incomplete');
        error.code = 'cbor_incomplete';
        error.pending = { offset: pending.offset, length: pending.length };
        throw error;
      }
      if (items.length > 0) await writeFile(join(this.directory, 'objects', digest), bytes);
      const created = items.map(item => ({
        id: randomUUID(), digest, source, bytes: item.length, kind: 'sequence',
        ordinal: item.ordinal, object: digest,
        span: { start: item.offset, end: item.offset + item.length },
        value: item.value,
      }));
      records.push(...created);
      await this.saveIndex(records);
      return { records: created, pending, digest };
    });
  }

  // All records, optionally filtered to one kind or object digest. With a
  // query, also keep records whose root value or any nested entry matches.
  async records({ kind = null, digest = null, query = null } = {}) {
    const records = (await this.list())
      .filter(record => kind === null || record.kind === kind)
      .filter(record => digest === null || record.digest === digest);
    if (query === null) return records;
    return records.filter(record => record.value !== undefined
      && recordContains(record.value, query));
  }

  async record(id) {
    const found = (await this.list()).find(record => record.id === id);
    if (!found) throw new Error('record_not_found');
    return found;
  }

  // Query map entries with a typed key. Without `query`, every entry of every
  // map is returned in source order. Duplicate keys yield every entry, never
  // only the last value. Omitted keys stay omitted; this is not a JSON merge.
  async entries({ query = null, kind = null, digest = null, ordinal = null } = {}) {
    const records = (await this.records({ kind, digest }))
      .filter(record => ordinal === null || record.ordinal === ordinal)
      // Index records written before typed nodes existed have no lossless
      // value; they remain readable through /records and /objects.
      .filter(record => record.value !== undefined);
    const result = [];
    for (const record of records) {
      for (const entry of walkRecord(record.value)) {
        if (!entryMatches(entry, query)) continue;
        result.push(describe(record, entry));
      }
    }
    return result;
  }

  // Exact bytes of one record, sliced from the stored source object.
  async recordObject(record) {
    const source = await this.object(record.object);
    return source.subarray(record.span.start, record.span.end);
  }

  async object(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid_digest');
    return readFile(join(this.directory, 'objects', digest));
  }

  serialize(operation) {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }
}

// The root of a non-map top-level value (a bare tag, byte string, integer,
// array, ...) is queryable as an entry with `key: null` and path []. Map
// roots are expanded into their own entries in source order.
function* walkRecord(value) {
  if (value.type !== 'map') yield { path: [], key: null, value };
  yield* walkEntries(value, []);
}

function recordContains(value, query) {
  for (const entry of walkRecord(value)) {
    if (entryMatches(entry, query)) return true;
  }
  return false;
}

function describe(record, entry) {
  return {
    id: record.id, digest: record.digest, source: record.source,
    kind: record.kind, ordinal: record.ordinal ?? 0,
    object: record.object, span: record.span,
    path: entry.path,
    key: entry.key, value: entry.value,
    entry: { key: entry.key, value: entry.value },
  };
}

// Depth-first walk in source order. Each map entry is yielded before walking
// into its value, so outer entries precede nested ones. `path` disambiguates
// duplicate keys by their position in the containing map or array, which
// distinguishes a tag key from a tag value and two identical filtered value
// tag siblings.
function* walkEntries(value, path) {
  if (value.type === 'map') {
    for (let index = 0; index < value.entries.length; index++) {
      const entry = value.entries[index];
      const segment = { key: canonicalKey(entry.key), index };
      yield { path: [...path, segment], key: entry.key, value: entry.value };
      yield* walkEntries(entry.value, [...path, segment]);
    }
  } else if (value.type === 'array') {
    for (let index = 0; index < value.items.length; index++) {
      yield* walkEntries(value.items[index], [...path, { index }]);
    }
  } else if (value.type === 'tag') {
    yield* walkEntries(value.value, [...path, { tag: value.tag }]);
  }
}

// Backwards-compatible name for callers of the original storage module.
export { TypedInbox as Store };
