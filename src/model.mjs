// Typed keys and typed query filters.
//
// Key identity preserves CBOR type: integer 1, text "1", bytes 0x01, tag(1)
// and simple(1) are five different keys. Integers compare by mathematical
// value, so 0x01 and 0x18 0x01 match. Floats compare by numeric value plus
// NaN/-0, independent of encoding width. Compound keys keep their source
// order and duplicate entries; this layer never deduplicates.
//
// Canonical keys are JSON strings, never JS object property names, so a
// "__proto__" text key cannot touch Object.prototype and no key coercion
// (e.g. 1 -> "1") can happen.

import { CborError } from './cbor.mjs';

export const KEY_TYPES = new Set([
  'uint', 'nint', 'bytes', 'text', 'array', 'map', 'tag',
  'bool', 'null', 'undefined', 'simple', 'float',
]);

const UINT64_MAX = 2n ** 64n - 1n;
const NINT64_MIN = -(2n ** 64n);

function badQuery(code = 'invalid_key_query') {
  return new CborError(code);
}

function decimal(value, { negative = false } = {}) {
  if (typeof value !== 'string' || !/^-?[0-9]+$/.test(value)) throw badQuery();
  let parsed;
  try { parsed = BigInt(value); } catch { throw badQuery(); }
  if (negative) {
    if (parsed > -1n || parsed < NINT64_MIN) throw badQuery('integer_out_of_range');
  } else if (parsed < 0n || parsed > UINT64_MAX) {
    throw badQuery('integer_out_of_range');
  }
  return parsed.toString();
}

function canonicalBase64(value) {
  if (typeof value !== 'string') throw badQuery();
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw badQuery();
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw badQuery('invalid_base64');
  return decoded.toString('base64');
}

function canonicalFloat(value, extra = {}) {
  if (extra.special === 'nan') return 'nan';
  if (extra.special === 'infinity') return 'infinity';
  if (extra.special === '-infinity') return '-infinity';
  if (extra.negativeZero) return '-0';
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) throw badQuery();
  if (Object.is(number, -0)) return '-0';
  return String(number);
}

function floatNodeFrom(value, extra) {
  if (extra.special !== undefined) {
    if (!['nan', 'infinity', '-infinity'].includes(extra.special)) throw badQuery();
    return { type: 'float', value: null, special: extra.special };
  }
  if (extra.negativeZero) return { type: 'float', value: 0, negativeZero: true };
  const number = Number(value);
  if (!Number.isFinite(number)) throw badQuery();
  return Object.is(number, -0)
    ? { type: 'float', value: 0, negativeZero: true }
    : { type: 'float', value: number };
}

export function canonicalKey(node) {
  switch (node.type) {
    case 'uint': return JSON.stringify(['uint', decimal(node.value)]);
    case 'nint': return JSON.stringify(['nint', decimal(node.value, { negative: true })]);
    case 'bytes': return JSON.stringify(['bytes', canonicalBase64(node.base64)]);
    case 'text': return JSON.stringify(['text', String(node.value)]);
    case 'bool': return JSON.stringify(['bool', Boolean(node.value)]);
    case 'null': return JSON.stringify(['null']);
    case 'undefined': return JSON.stringify(['undefined']);
    case 'simple': return JSON.stringify(['simple', Number(node.value)]);
    case 'float': return JSON.stringify(['float', canonicalFloat(node.value, node)]);
    case 'tag': return JSON.stringify(['tag', decimal(node.tag), canonicalKey(node.value)]);
    case 'array': return JSON.stringify(['array', node.items.map(canonicalKey)]);
    case 'map': return JSON.stringify(['map',
      node.entries.map(entry => [canonicalKey(entry.key), canonicalKey(entry.value)])]);
    default: throw badQuery('unsupported_key_type');
  }
}

// Typed node JSON accepted by ?key=<json>. Spans are ignored; integer values
// may be decimal strings (or safe JS integers, for convenience).
export function keyNodeFromJson(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw badQuery();
  if (!KEY_TYPES.has(input.type)) throw badQuery('unsupported_key_type');
  switch (input.type) {
    case 'uint': return { type: 'uint', value: decimal(String(input.value)) };
    case 'nint': return { type: 'nint', value: decimal(String(input.value), { negative: true }) };
    case 'bytes': return { type: 'bytes', base64: canonicalBase64(input.base64) };
    case 'text': return { type: 'text', value: String(input.value) };
    case 'bool': return { type: 'bool', value: Boolean(input.value) };
    case 'null': return { type: 'null' };
    case 'undefined': return { type: 'undefined' };
    case 'simple': return { type: 'simple', value: Number(input.value) };
    case 'float': return floatNodeFrom(input.value, input);
    case 'tag': return { type: 'tag', tag: decimal(String(input.tag)), value: keyNodeFromJson(input.value) };
    case 'array': {
      if (!Array.isArray(input.items)) throw badQuery();
      return { type: 'array', items: input.items.map(keyNodeFromJson) };
    }
    case 'map': {
      if (!Array.isArray(input.entries)) throw badQuery();
      return { type: 'map', entries: input.entries.map(entry => {
        if (!entry || typeof entry !== 'object') throw badQuery();
        return { key: keyNodeFromJson(entry.key), value: keyNodeFromJson(entry.value) };
      }) };
    }
    default: throw badQuery('unsupported_key_type');
  }
}

function floatFromShorthand(raw) {
  if (raw === 'nan' || raw === 'NaN') return { special: 'nan' };
  if (raw === 'inf' || raw === '+inf' || raw === 'Infinity' || raw === '+Infinity') {
    return { special: 'infinity' };
  }
  if (raw === '-inf' || raw === '-Infinity') return { special: '-infinity' };
  if (raw === '-0') return { negativeZero: true };
  const number = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(number)) throw badQuery();
  return { value: number };
}

function typed(node) {
  return { canonical: canonicalKey(node), node };
}

// Query forms, combinable:
//   ?keyType=uint&key=1          exact typed key
//   ?keyType=text&key=1          text "1", distinct from integer 1
//   ?keyType=uint                any integer-keyed entry
//   ?key={"type":"tag","tag":"1","value":{...}}   arbitrary typed key
//   ?keyType=tag&key=2           any entry whose key is tag 2
//   ?tag=2                       any entry with tag 2 as key or value
//   ?valueType=bytes             filter by value type
// No key-related parameters means "all entries in source order".
export function parseKeyQuery(searchParams) {
  const keyType = searchParams.get('keyType');
  const raw = searchParams.get('key');
  const valueType = searchParams.get('valueType');
  const tag = searchParams.get('tag');
  if (keyType === null && raw === null && valueType === null && tag === null) return null;
  if (keyType !== null && !KEY_TYPES.has(keyType)) throw badQuery('unsupported_key_type');
  if (valueType !== null && !KEY_TYPES.has(valueType)) throw badQuery('unsupported_value_type');

  const query = {
    keyType: null, canonical: null, keyTag: null, valueType: null, tag: null,
  };
  if (keyType !== null) query.keyType = keyType;
  if (valueType !== null) query.valueType = valueType;
  if (tag !== null) query.tag = decimal(tag);

  if (raw !== null) {
    let node;
    if (keyType === 'tag') {
      // Shorthand matches a tag key by its tag number only. Use
      // ?key=<typed json> to also pin the tag content.
      query.keyTag = decimal(raw);
      return query;
    }
    if (keyType !== null) {
      node = shorthandKey(keyType, raw);
    } else {
      let parsed;
      try { parsed = JSON.parse(raw); } catch { throw badQuery(); }
      node = keyNodeFromJson(parsed);
      query.keyType = node.type;
    }
    query.canonical = canonicalKey(node);
    return query;
  }
  return query;
}

function shorthandKey(type, raw) {
  switch (type) {
    case 'uint': return { type: 'uint', value: decimal(raw) };
    case 'nint': return { type: 'nint', value: decimal(raw, { negative: true }) };
    case 'bytes': return { type: 'bytes', base64: canonicalBase64(raw) };
    case 'text': return { type: 'text', value: raw };
    case 'bool':
      if (raw !== 'true' && raw !== 'false') throw badQuery();
      return { type: 'bool', value: raw === 'true' };
    case 'null': return { type: 'null' };
    case 'undefined': return { type: 'undefined' };
    case 'simple': {
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0 || value > 255) throw badQuery();
      return { type: 'simple', value };
    }
    case 'float': return { type: 'float', ...floatFromShorthand(raw) };
    default:
      // array/map keys have no shorthand: use ?key=<typed json>.
      throw badQuery('key_json_required');
  }
}

export function keyMatches(node, query) {
  if (!query) return true;
  // Non-map top-level values have no map key; only value-side filters can
  // match them, never a key filter.
  if (node === null) return query.keyType === null && query.keyTag === null
    && query.canonical === null;
  if (query.keyType !== null && node.type !== query.keyType) return false;
  if (query.keyTag !== null && (node.type !== 'tag' || node.tag !== query.keyTag)) return false;
  if (query.canonical !== null && canonicalKey(node) !== query.canonical) return false;
  return true;
}

// Tag filters look at the key or the value, because callers do not always
// know which side carries the business tag number.
export function entryMatches(entry, query) {
  if (!query) return true;
  if (!keyMatches(entry.key, query)) return false;
  if (query.valueType !== null && entry.value.type !== query.valueType) return false;
  if (query.tag !== null) {
    const keyTag = entry.key?.type === 'tag' ? entry.key.tag : null;
    const valueTag = entry.value.type === 'tag' ? entry.value.tag : null;
    if (keyTag !== query.tag && valueTag !== query.tag) return false;
  }
  return true;
}
