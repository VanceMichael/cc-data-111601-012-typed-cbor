// Lossless RFC 8949 decoding for the exchange subset described in docs/upstream.md.
//
// Decoded values are plain JSON-safe nodes. Nothing is collapsed:
//   - integers stay decimal strings (uint64 / nint64 range is not narrowed)
//   - byte strings stay base64 (with their byte length)
//   - maps are ordered arrays of { key, value } entries, duplicates included
//   - tags keep their number and content
//   - floats keep their exact bit pattern, including NaN payloads and -0
//
// Every node carries `start`/`end`: the byte span it occupied in the decoded
// source (record-relative when read through CborSequenceDecoder). Spans are
// provenance, not identity; see model.canonicalNode / nodeDigest.
//
// A CborError with `incomplete === true` means "more bytes may complete this
// item". Every other CborError is a structural failure. The sequence decoder
// never scans past an incomplete top-level item looking for a fresh start.

export class CborError extends Error {
  constructor(code, { incomplete = false, cause } = {}) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'CborError';
    this.code = code;
    this.incomplete = incomplete;
  }
}

export function isIncomplete(error) {
  return error instanceof CborError && error.incomplete;
}

function needMore() {
  return new CborError('cbor_incomplete', { incomplete: true });
}

function fail(code) {
  return new CborError(code);
}

function readHead(bytes, offset) {
  if (offset >= bytes.length) throw needMore();
  const initial = bytes[offset++];
  const major = initial >> 5;
  const additional = initial & 31;
  let argument = null;
  if (additional < 24) {
    argument = BigInt(additional);
  } else if (additional === 24) {
    if (offset >= bytes.length) throw needMore();
    argument = BigInt(bytes[offset++]);
  } else if (additional === 25) {
    if (offset + 2 > bytes.length) throw needMore();
    argument = BigInt(bytes.readUInt16BE(offset));
    offset += 2;
  } else if (additional === 26) {
    if (offset + 4 > bytes.length) throw needMore();
    argument = BigInt(bytes.readUInt32BE(offset));
    offset += 4;
  } else if (additional === 27) {
    if (offset + 8 > bytes.length) throw needMore();
    argument = bytes.readBigUInt64BE(offset);
    offset += 8;
  } else if (additional === 31) {
    argument = null; // indefinite container or break
  } else {
    throw fail('cbor_reserved_additional');
  }
  return { major, additional, argument, offset };
}

function lengthOf(argument, limit, code) {
  if (argument > BigInt(limit)) throw fail(code);
  return Number(argument);
}

function decodeDefiniteBytes(bytes, head, options) {
  const length = lengthOf(head.argument, options.maxItemBytes, 'cbor_item_too_large');
  if (head.offset + length > bytes.length) throw needMore();
  return {
    value: bytes.subarray(head.offset, head.offset + length),
    offset: head.offset + length,
  };
}

function decodeTextChunk(bytes, head, options) {
  const chunk = decodeDefiniteBytes(bytes, head, options);
  try {
    return {
      value: new TextDecoder('utf-8', { fatal: true }).decode(chunk.value),
      offset: chunk.offset,
    };
  } catch (cause) {
    throw new CborError('cbor_invalid_utf8', { cause });
  }
}

function halfToNumber(bits) {
  const sign = (bits & 0x8000) ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x03ff;
  if (exponent === 0) return sign * (fraction / 1024) * 2 ** -14;
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : NaN;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

function floatNode(additional, argument) {
  const width = additional === 25 ? 16 : additional === 26 ? 32 : 64;
  const binary = Buffer.alloc(width / 8);
  if (width === 16) binary.writeUInt16BE(Number(argument), 0);
  else if (width === 32) binary.writeUInt32BE(Number(argument), 0);
  else binary.writeBigUInt64BE(argument, 0);
  const value = width === 16
    ? halfToNumber(binary.readUInt16BE(0))
    : width === 32 ? binary.readFloatBE(0) : binary.readDoubleBE(0);
  const node = { type: 'float', width, bits: binary.toString('hex') };
  if (Number.isFinite(value)) {
    if (Object.is(value, -0)) {
      node.value = 0;
      node.negativeZero = true;
    } else {
      node.value = value;
    }
  } else {
    node.value = null;
    node.special = Number.isNaN(value) ? 'nan'
      : value > 0 ? 'infinity' : '-infinity';
  }
  return node;
}

function node(type, start, end, fields) {
  return { type, start, end, ...fields };
}

function decodeItem(bytes, offset, options, depth, spanBase) {
  if (depth > options.maxDepth) throw fail('cbor_depth_exceeded');
  const start = spanBase + offset;
  const head = readHead(bytes, offset);
  const { major, additional } = head;
  offset = head.offset;
  const end = () => spanBase + offset;

  if (major === 0) {
    if (additional === 31) throw fail('cbor_indefinite_integer');
    return {
      value: node('uint', start, end(), { value: head.argument.toString() }),
      offset,
    };
  }
  if (major === 1) {
    if (additional === 31) throw fail('cbor_indefinite_integer');
    return {
      value: node('nint', start, end(), { value: (-1n - head.argument).toString() }),
      offset,
    };
  }

  if (major === 2) {
    if (additional === 31) {
      const chunks = [];
      let total = 0;
      for (;;) {
        if (offset >= bytes.length) throw needMore();
        if (bytes[offset] === 0xff) { offset++; break; }
        const chunkHead = readHead(bytes, offset);
        offset = chunkHead.offset;
        if (chunkHead.major !== 2) throw fail('cbor_indefinite_chunk_type');
        if (chunkHead.additional === 31) throw fail('cbor_indefinite_chunk_indefinite');
        const chunk = decodeDefiniteBytes(bytes, chunkHead, options);
        total += chunk.value.length;
        if (total > options.maxItemBytes) throw fail('cbor_item_too_large');
        chunks.push(chunk.value);
        offset = chunk.offset;
      }
      const value = Buffer.concat(chunks, total);
      return {
        value: node('bytes', start, end(), {
          base64: value.toString('base64'), length: value.length,
        }),
        offset,
      };
    }
    const chunk = decodeDefiniteBytes(bytes, head, options);
    offset = chunk.offset;
    return {
      value: node('bytes', start, end(), {
        base64: chunk.value.toString('base64'), length: chunk.value.length,
      }),
      offset,
    };
  }

  if (major === 3) {
    if (additional === 31) {
      let value = '';
      for (;;) {
        if (offset >= bytes.length) throw needMore();
        if (bytes[offset] === 0xff) { offset++; break; }
        const chunkHead = readHead(bytes, offset);
        offset = chunkHead.offset;
        if (chunkHead.major !== 3) throw fail('cbor_indefinite_chunk_type');
        if (chunkHead.additional === 31) throw fail('cbor_indefinite_chunk_indefinite');
        const chunk = decodeTextChunk(bytes, chunkHead, options);
        value += chunk.value;
        offset = chunk.offset;
      }
      return { value: node('text', start, end(), { value }), offset };
    }
    const chunk = decodeTextChunk(bytes, head, options);
    offset = chunk.offset;
    return { value: node('text', start, end(), { value: chunk.value }), offset };
  }

  if (major === 4) {
    const items = [];
    if (additional === 31) {
      for (;;) {
        if (offset >= bytes.length) throw needMore();
        if (bytes[offset] === 0xff) { offset++; break; }
        if (items.length >= options.maxEntries) throw fail('cbor_container_limit_exceeded');
        const item = decodeItem(bytes, offset, options, depth + 1, spanBase);
        items.push(item.value);
        offset = item.offset;
      }
    } else {
      const length = lengthOf(head.argument, options.maxEntries, 'cbor_container_limit_exceeded');
      for (let index = 0; index < length; index++) {
        const item = decodeItem(bytes, offset, options, depth + 1, spanBase);
        items.push(item.value);
        offset = item.offset;
      }
    }
    return { value: node('array', start, end(), { items }), offset };
  }

  if (major === 5) {
    const entries = [];
    if (additional === 31) {
      for (;;) {
        if (offset >= bytes.length) throw needMore();
        if (bytes[offset] === 0xff) { offset++; break; }
        if (entries.length >= options.maxEntries) throw fail('cbor_container_limit_exceeded');
        const key = decodeItem(bytes, offset, options, depth + 1, spanBase);
        offset = key.offset;
        if (offset >= bytes.length) throw needMore();
        if (bytes[offset] === 0xff) throw fail('cbor_break_after_map_key');
        const value = decodeItem(bytes, offset, options, depth + 1, spanBase);
        offset = value.offset;
        entries.push({ key: key.value, value: value.value });
      }
    } else {
      const length = lengthOf(head.argument, options.maxEntries, 'cbor_container_limit_exceeded');
      for (let index = 0; index < length; index++) {
        const key = decodeItem(bytes, offset, options, depth + 1, spanBase);
        offset = key.offset;
        if (offset < bytes.length && bytes[offset] === 0xff) {
          throw fail('cbor_break_after_map_key');
        }
        const value = decodeItem(bytes, offset, options, depth + 1, spanBase);
        offset = value.offset;
        entries.push({ key: key.value, value: value.value });
      }
    }
    return { value: node('map', start, end(), { entries }), offset };
  }

  if (major === 6) {
    if (additional === 31) throw fail('cbor_indefinite_tag');
    const item = decodeItem(bytes, offset, options, depth + 1, spanBase);
    return {
      value: node('tag', start, spanBase + item.offset, {
        tag: head.argument.toString(), value: item.value,
      }),
      offset: item.offset,
    };
  }

  // Major type 7: simple values, bool/null/undefined, floats and break.
  if (additional === 31) throw fail('cbor_unexpected_break');
  if (additional < 20) return { value: node('simple', start, end(), { value: Number(head.argument) }), offset };
  // additional 24 carries simple values 32..255; 24..31 stay reserved and
  // 0..23 must use the immediate encoding.

  if (additional === 20) return { value: node('bool', start, end(), { value: false }), offset };
  if (additional === 21) return { value: node('bool', start, end(), { value: true }), offset };
  if (additional === 22) return { value: node('null', start, end(), {}), offset };
  if (additional === 23) return { value: node('undefined', start, end(), {}), offset };
  if (additional === 24) {
    if (head.argument < 32n) throw fail('cbor_invalid_simple');
    return { value: node('simple', start, end(), { value: Number(head.argument) }), offset };
  }
  if (additional === 25 || additional === 26 || additional === 27) {
    return { value: node('float', start, end(), floatNode(additional, head.argument)), offset };
  }
  throw fail('cbor_reserved_additional');
}

export const DEFAULT_LIMITS = Object.freeze({
  maxDepth: 64,
  maxEntries: 1000000,
  maxItemBytes: 8 * 1024 * 1024,
});

function normalizeOptions(options = {}) {
  return { ...DEFAULT_LIMITS, ...options };
}

export function decodeSingle(bytes, options = {}) {
  const buffer = Buffer.from(bytes);
  const limits = normalizeOptions(options);
  const decoded = decodeItem(buffer, 0, limits, 0, 0);
  if (decoded.offset !== buffer.length) throw fail('cbor_trailing');
  return { value: decoded.value, offset: 0, length: decoded.offset };
}

export function decodeSequence(bytes, options = {}) {
  const decoder = new CborSequenceDecoder(options);
  const items = decoder.feed(bytes);
  const end = decoder.end();
  if (end.pending) throw new CborError('cbor_incomplete', { incomplete: true });
  return items;
}

export class CborSequenceDecoder {
  constructor(options = {}) {
    this.options = normalizeOptions(options);
    this.buffer = Buffer.alloc(0);
    this.baseOffset = 0;
    this.nextOrdinal = 0;
    this.received = 0;
    this.stopped = false;
    this.failure = null;
  }

  // Feed arbitrary chunks. Returns every top-level item that became complete.
  // An incomplete tail stays buffered; it is never searched for a later start.
  feed(chunk) {
    if (this.stopped) throw this.failure ?? fail('cbor_decoder_stopped');
    const piece = Buffer.from(chunk);
    this.received += piece.length;
    if (this.buffer.length === 0) this.buffer = piece;
    else this.buffer = Buffer.concat([this.buffer, piece]);
    if (this.buffer.length > this.options.maxItemBytes) {
      this.stopped = true;
      this.failure = fail('cbor_pending_too_large');
      throw this.failure;
    }
    const items = [];
    for (;;) {
      if (this.buffer.length === 0) break;
      let decoded;
      try {
        decoded = decodeItem(this.buffer, 0, this.options, 0, this.baseOffset);
      } catch (error) {
        if (isIncomplete(error)) break;
        this.stopped = true;
        this.failure = error;
        throw error;
      }
      items.push({
        ordinal: this.nextOrdinal++,
        offset: this.baseOffset,
        length: decoded.offset,
        value: decoded.value,
      });
      this.baseOffset += decoded.offset;
      this.buffer = this.buffer.subarray(decoded.offset);
    }
    return items;
  }

  // At end of source there may be a buffered incomplete item. It is reported,
  // never promoted to a record by scanning for a later parseable suffix.
  end() {
    if (this.stopped) throw this.failure ?? fail('cbor_decoder_stopped');
    return {
      pending: this.buffer.length === 0 ? null : {
        offset: this.baseOffset,
        length: this.buffer.length,
        bytes: this.buffer,
      },
    };
  }
}
