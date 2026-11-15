export function decodeSimple(bytes, start = 0) {
  if (start >= bytes.length) throw new Error('cbor_short');
  let offset = start;
  const initial = bytes[offset++]; const major = initial >> 5; const additional = initial & 31;
  let length;
  if (additional < 24) length = additional;
  else if (additional === 24) { if (offset >= bytes.length) throw new Error('cbor_short_length'); length = bytes[offset++]; }
  else if (additional === 25) { if (offset + 2 > bytes.length) throw new Error('cbor_short_length'); length = bytes.readUInt16BE(offset); offset += 2; }
  else throw new Error('simple_cbor_length_unsupported');
  if (major === 0 || major === 1) return { value: major === 0 ? length : -1 - length, offset };
  if (major === 3) {
    if (offset + length > bytes.length) throw new Error('cbor_short_text');
    return { value: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, offset + length)), offset: offset + length };
  }
  if (major === 4 || major === 5) {
    const value = major === 4 ? [] : {};
    for (let index = 0; index < length; index++) {
      const first = decodeSimple(bytes, offset); offset = first.offset;
      if (major === 4) value.push(first.value);
      else {
        if (typeof first.value !== 'string' || Object.hasOwn(value, first.value)) throw new Error('simple_cbor_map_key');
        const second = decodeSimple(bytes, offset); offset = second.offset;
        Object.defineProperty(value, first.value, { value: second.value, enumerable: true });
      }
    }
    return { value, offset };
  }
  if (major === 7 && [20, 21, 22].includes(additional)) return { value: [false, true, null][additional - 20], offset };
  throw new Error('simple_cbor_type_unsupported');
}
export function inspect(bytes) {
  const decoded = decodeSimple(bytes);
  if (decoded.offset !== bytes.length) throw new Error('simple_cbor_trailing');
  return { kind: 'simple-cbor-value', value: decoded.value };
}
