// RFC 8949 交换子集的无损解码器。
// 解释结果一律使用 JSON 安全的带类型节点，不依赖 JS 对象键的字符串化，
// 因此整数键 1、文本键 "1"、标签键、重复键与条目顺序全部可区分、可回溯。

export const DEFAULT_LIMITS = Object.freeze({
  maxDepth: 128,           // 容器嵌套深度，显式失败
  maxNodes: 200_000,       // 一次解析产生的节点总数
  maxBytes: 8 * 1024 * 1024
});

// 结构损坏：更多字节也无法修复，来源应停止而非寻找下一个同步点。
export class CborError extends Error {
  constructor(code) { super(code); this.name = 'CborError'; this.code = code; }
}
// 只是当前缓冲不足：续收字节后可在同一偏移重试。
export class CborShortError extends Error {
  constructor(code) { super(code); this.name = 'CborShortError'; this.code = code; }
}

const textDecoder = new TextDecoder('utf-8', { fatal: true });

function readHead(bytes, offset, depth, limits) {
  if (depth > limits.maxDepth) throw new CborError('cbor_depth_exceeded');
  if (offset >= bytes.length) throw new CborShortError('cbor_short_head');
  const initial = bytes[offset++];
  const major = initial >> 5;
  const additional = initial & 31;
  if (additional < 24) return { major, additional, length: BigInt(additional), indefinite: false, offset };
  // additional 28..30 为保留值；31 在 major 7 是 break，其余是不定长容器头。
  if (additional >= 28) {
    if (additional !== 31) throw new CborError('cbor_additional_reserved');
    return { major, additional, length: 0n, indefinite: true, offset };
  }
  // major 7：24=one-byte simple，25..27=float，由 decodeNode 解读，不做长度解析。
  if (major === 7) return { major, additional, length: 0n, indefinite: false, offset };
  if (additional === 24) {
    if (offset + 1 > bytes.length) throw new CborShortError('cbor_short_length');
    return { major, additional, length: BigInt(bytes[offset]), indefinite: false, offset: offset + 1 };
  }
  if (additional === 25) {
    if (offset + 2 > bytes.length) throw new CborShortError('cbor_short_length');
    return { major, additional, length: BigInt(bytes.readUInt16BE(offset)), indefinite: false, offset: offset + 2 };
  }
  if (additional === 26) {
    if (offset + 4 > bytes.length) throw new CborShortError('cbor_short_length');
    return { major, additional, length: BigInt(bytes.readUInt32BE(offset)), indefinite: false, offset: offset + 4 };
  }
  if (offset + 8 > bytes.length) throw new CborShortError('cbor_short_length');
  return { major, additional, length: bytes.readBigUInt64BE(offset), indefinite: false, offset: offset + 8 };
}

function need(offset, length, bytes, code) {
  if (length > BigInt(bytes.length - offset)) throw new CborShortError(code);
}

function decodeText(bytes, start, length) {
  try { return textDecoder.decode(bytes.subarray(start, start + length)); }
  catch { throw new CborError('cbor_invalid_utf8'); }
}

function readF16(bytes, offset) {
  const half = bytes.readUInt16BE(offset);
  const sign = half & 0x8000 ? -1 : 1;
  const exponent = (half >> 10) & 0x1f;
  const fraction = half & 0x3ff;
  let value;
  if (exponent === 0) value = (fraction / 1024) * 2 ** -14;
  else if (exponent === 31) value = fraction === 0 ? Infinity : NaN;
  else value = (1 + fraction / 1024) * 2 ** (exponent - 15);
  return sign * value;
}

// 非有限浮点不能交给 JSON.stringify（会变成 null 丢失），用显式字符串标记保真。
function floatNode(value) {
  if (Number.isNaN(value)) return { kind: 'float', nonFinite: 'NaN', value: 'NaN' };
  if (value === Infinity) return { kind: 'float', nonFinite: 'Infinity', value: 'Infinity' };
  if (value === -Infinity) return { kind: 'float', nonFinite: '-Infinity', value: '-Infinity' };
  const node = { kind: 'float', value: Object.is(value, -0) ? 0 : value };
  if (Object.is(value, -0)) node.negativeZero = true;
  return node;
}

function decodeNode(bytes, start, depth, limits, counter) {
  const head = readHead(bytes, start, depth, limits);
  const major = head.major;
  let offset = head.offset;
  counter.count += 1;
  if (counter.count > limits.maxNodes) throw new CborError('cbor_nodes_exceeded');

  if (major === 0) return { node: { kind: 'uint', value: head.length.toString() }, offset };
  if (major === 1) return { node: { kind: 'nint', value: (-1n - head.length).toString() }, offset };

  if (major === 2) {
    if (head.indefinite) {
      const pieces = [];
      for (;;) {
        if (offset >= bytes.length) throw new CborShortError('cbor_short_indefinite');
        if (bytes[offset] === 0xff) { offset += 1; break; }
        const chunk = decodeNode(bytes, offset, depth + 1, limits, counter);
        if (chunk.node.kind !== 'bytes') throw new CborError('cbor_indefinite_chunk_type');
        pieces.push(Buffer.from(chunk.node.value, 'base64'));
        offset = chunk.offset;
      }
      return { node: { kind: 'bytes', value: Buffer.concat(pieces).toString('base64') }, offset };
    }
    need(offset, head.length, bytes, 'cbor_short_bytes');
    const length = Number(head.length);
    const node = { kind: 'bytes', value: bytes.subarray(offset, offset + length).toString('base64') };
    return { node, offset: offset + length };
  }

  if (major === 3) {
    if (head.indefinite) {
      const pieces = [];
      for (;;) {
        if (offset >= bytes.length) throw new CborShortError('cbor_short_indefinite');
        if (bytes[offset] === 0xff) { offset += 1; break; }
        const chunk = decodeNode(bytes, offset, depth + 1, limits, counter);
        if (chunk.node.kind !== 'text') throw new CborError('cbor_indefinite_chunk_type');
        pieces.push(chunk.node.value);
        offset = chunk.offset;
      }
      const joined = pieces.join('');
      // UTF-8 序列可以跨越 chunk 边界，拼接后做整体严格校验。
      try { textDecoder.decode(Buffer.from(joined)); } catch { throw new CborError('cbor_invalid_utf8'); }
      return { node: { kind: 'text', value: joined }, offset };
    }
    need(offset, head.length, bytes, 'cbor_short_text');
    const length = Number(head.length);
    return { node: { kind: 'text', value: decodeText(bytes, offset, length) }, offset: offset + length };
  }

  if (major === 4) {
    const items = [];
    if (head.indefinite) {
      for (;;) {
        if (offset >= bytes.length) throw new CborShortError('cbor_short_indefinite');
        if (bytes[offset] === 0xff) { offset += 1; break; }
        const child = decodeNode(bytes, offset, depth + 1, limits, counter);
        items.push(child.node); offset = child.offset;
      }
    } else {
      for (let i = 0n; i < head.length; i += 1n) {
        const child = decodeNode(bytes, offset, depth + 1, limits, counter);
        items.push(child.node); offset = child.offset;
      }
    }
    return { node: { kind: 'array', items }, offset };
  }

  if (major === 5) {
    const entries = [];
    if (head.indefinite) {
      for (;;) {
        if (offset >= bytes.length) throw new CborShortError('cbor_short_indefinite');
        if (bytes[offset] === 0xff) { offset += 1; break; }
        const key = decodeNode(bytes, offset, depth + 1, limits, counter);
        offset = key.offset;
        const value = decodeNode(bytes, offset, depth + 1, limits, counter);
        offset = value.offset;
        // 不做键去重、不按类型折叠，保留重复键与原始顺序。
        entries.push({ key: key.node, value: value.node });
      }
    } else {
      for (let i = 0n; i < head.length; i += 1n) {
        const key = decodeNode(bytes, offset, depth + 1, limits, counter);
        offset = key.offset;
        const value = decodeNode(bytes, offset, depth + 1, limits, counter);
        offset = value.offset;
        entries.push({ key: key.node, value: value.node });
      }
    }
    return { node: { kind: 'map', entries }, offset };
  }

  if (major === 6) {
    if (head.indefinite) throw new CborError('cbor_indefinite_unsupported');
    const content = decodeNode(bytes, offset, depth + 1, limits, counter);
    // 不解读业务 tag 语义，只保留 tag 号与内容。
    return { node: { kind: 'tag', tag: head.length.toString(), content: content.node }, offset: content.offset };
  }

  // major 7：简单值、break 与浮点。
  if (head.additional === 31) throw new CborError('cbor_unexpected_break'); // 0xff 只在容器内合法
  if (head.additional < 24) {
    const simple = head.additional;
    if (simple === 20) return { node: { kind: 'bool', value: false }, offset };
    if (simple === 21) return { node: { kind: 'bool', value: true }, offset };
    if (simple === 22) return { node: { kind: 'null' }, offset };
    if (simple === 23) return { node: { kind: 'undefined' }, offset };
    // RFC 8949 §3.3：simple 0..19 保留，不得出现。
    if (simple <= 19) throw new CborError('cbor_simple_reserved');
    return { node: { kind: 'simple', value: simple }, offset };
  }
  if (head.additional === 24) {
    // RFC 8949 §3.3：one-byte simple 中 0..19 与 32 保留，不得出现。
    if (offset >= bytes.length) throw new CborShortError('cbor_short_simple');
    const simple = bytes[offset++];
    if (simple <= 19 || simple === 32) throw new CborError('cbor_simple_reserved');
    return { node: { kind: 'simple', value: simple }, offset };
  }
  if (head.additional === 25) {
    if (offset + 2 > bytes.length) throw new CborShortError('cbor_short_float');
    return { node: floatNode(readF16(bytes, offset)), offset: offset + 2 };
  }
  if (head.additional === 26) {
    if (offset + 4 > bytes.length) throw new CborShortError('cbor_short_float');
    return { node: floatNode(bytes.readFloatBE(offset)), offset: offset + 4 };
  }
  if (head.additional === 27) {
    if (offset + 8 > bytes.length) throw new CborShortError('cbor_short_float');
    return { node: floatNode(bytes.readDoubleBE(offset)), offset: offset + 8 };
  }
  throw new CborError('cbor_type_unsupported');
}

// 解析单个完整 CBOR 数据项；尾部多余字节属于结构问题，显式失败。
export function decodeOne(bytes, limits = DEFAULT_LIMITS) {
  const counter = { count: 0 };
  const result = decodeNode(bytes, 0, 0, limits, counter);
  if (result.offset !== bytes.length) throw new CborError('cbor_trailing_bytes');
  return result.node;
}

// 一次性解码 CBOR sequence（连续顶层数据项，无长度前缀）。
export function decodeSequence(bytes, limits = DEFAULT_LIMITS) {
  const parser = createSequenceParser(limits);
  parser.push(bytes);
  return parser.finish();
}

// 增量解析器：分块位置不保证落在值边界。
// 短错误只保留尾部待续；结构损坏后进入 poisoned 状态，不扫描后续字节猜测新记录。
export function createSequenceParser(limits = DEFAULT_LIMITS) {
  const effective = { ...DEFAULT_LIMITS, ...limits };
  const chunks = [];
  let pending = Buffer.alloc(0);
  let base = 0;                 // pending[0] 在整条原件中的绝对偏移
  let buffered = 0;
  let poisoned = null;
  let finished = false;
  const items = [];
  const counter = { count: 0 };

  return {
    get items() { return items; },
    get poisoned() { return poisoned; },
    push(chunk) {
      if (finished) throw new CborError('cbor_parser_finished');
      if (poisoned) throw poisoned;
      const part = Buffer.from(chunk);
      buffered += part.length;
      if (buffered > effective.maxBytes) throw new CborError('cbor_bytes_exceeded');
      chunks.push(part);
      let data = pending.length ? Buffer.concat([pending, part]) : part;
      let local = 0;
      for (;;) {
        if (local >= data.length) break;
        const itemStart = local;
        try {
          const result = decodeNode(data, local, 0, effective, counter);
          items.push({ node: result.node, span: { start: base + itemStart, end: base + result.offset } });
          local = result.offset;
        } catch (error) {
          if (!(error instanceof CborShortError)) {
            poisoned = error;
            pending = Buffer.alloc(0);
            throw error;
          }
          break; // 等待续收，绝不跳过字节寻找下一个可解析前缀
        }
      }
      pending = data.subarray(local);
      base += local;
    },
    finish() {
      finished = true;
      if (poisoned) throw poisoned;
      if (pending.length) throw new CborShortError('cbor_sequence_truncated');
      return { items, bytes: Buffer.concat(chunks) };
    }
  };
}

function integerValue(node) {
  if (node?.kind === 'uint' || node?.kind === 'nint') return BigInt(node.value);
  return null;
}

function sameKey(actual, requested) {
  if (actual.kind !== requested.kind) return false;
  if (actual.kind === 'tag') {
    if (actual.tag !== requested.tag) return false;
    return sameKey(actual.content, requested.content);
  }
  if (actual.kind === 'uint' || actual.kind === 'nint') return actual.value === requested.value;
  if (actual.kind === 'text' || actual.kind === 'bytes') return actual.value === requested.value;
  if (actual.kind === 'bool') return actual.value === requested.value;
  if (actual.kind === 'null' || actual.kind === 'undefined') return true;
  if (actual.kind === 'simple') return actual.value === requested.value;
  if (actual.kind === 'float') {
    if (actual.nonFinite || requested.nonFinite) return actual.nonFinite === requested.nonFinite;
    return actual.value === requested.value;
  }
  return false;
}

// 按类型化的键查询映射条目：键按完整节点（含 tag/整数类型）匹配，
// 重复键返回全部条目并保持原始顺序；keyMin/keyMax 按项目整数约定（BigInt 数值）比较。
export function selectEntries(root, { keyType, key, keyMin, keyMax, tag } = {}) {
  const requested = buildKeyQuery({ keyType, key, tag });
  let min = null; let max = null;
  if (keyMin !== undefined) {
    if (!/^-?\d+$/.test(String(keyMin))) throw new CborError('invalid_integer_range');
    min = BigInt(String(keyMin));
  }
  if (keyMax !== undefined) {
    if (!/^-?\d+$/.test(String(keyMax))) throw new CborError('invalid_integer_range');
    max = BigInt(String(keyMax));
  }
  if (min !== null && max !== null && min > max) throw new CborError('invalid_integer_range');

  const matches = [];
  const walk = (node, path, item) => {
    if (node.kind === 'array') {
      node.items.forEach((child, index) => walk(child, [...path, index], item));
    } else if (node.kind === 'map') {
      node.entries.forEach((entry, index) => {
        const entryPath = [...path, index];
        if (keyMatches(entry.key, requested, min, max)) {
          matches.push({ item, path: entryPath, key: entry.key, value: entry.value });
        }
        walk(entry.value, [...entryPath, 'value'], item);
      });
    } else if (node.kind === 'tag') {
      walk(node.content, [...path, 'content'], item);
    }
  };
  for (const item of root.items) walk(item.node, [], item);
  return matches;
}

function keyMatches(actual, requested, min, max) {
  const candidates = actual.kind === 'tag' ? [actual, actual.content] : [actual];
  for (const candidate of candidates) {
    if (requested && sameKey(candidate, requested)) return true;
    if (min === null && max === null) continue;
    const numeric = integerValue(candidate);
    if (numeric === null) continue;
    if (min !== null && numeric < min) continue;
    if (max !== null && numeric > max) continue;
    return true;
  }
  return false;
}

function buildKeyQuery({ keyType, key, tag }) {
  if (keyType === undefined && key === undefined && tag === undefined) return null;
  if (tag !== undefined) {
    if (!/^\d+$/.test(String(tag))) throw new CborError('invalid_tag');
    if (keyType === undefined || key === undefined) throw new CborError('tag_key_requires_key');
    return { kind: 'tag', tag: String(tag), content: buildKeyQuery({ keyType, key }) };
  }
  if (keyType === undefined) throw new CborError('key_type_required');
  if (key === undefined) throw new CborError('key_required');
  const text = String(key);
  if (keyType === 'uint' || keyType === 'nint') {
    if (!/^-?\d+$/.test(text)) throw new CborError('invalid_key');
    const negative = text.startsWith('-');
    if (keyType === 'uint' && negative) throw new CborError('invalid_key');
    if (keyType === 'nint' && !negative) throw new CborError('invalid_key');
    return { kind: keyType, value: negative ? (-BigInt(text.slice(1))).toString() : BigInt(text).toString() };
  }
  if (keyType === 'text') return { kind: 'text', value: text };
  if (keyType === 'bytes') {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new CborError('invalid_key');
    return { kind: 'bytes', value: text };
  }
  if (keyType === 'bool') return { kind: 'bool', value: text === 'true' };
  if (keyType === 'null') return { kind: 'null' };
  if (keyType === 'undefined') return { kind: 'undefined' };
  if (keyType === 'simple') {
    if (!/^\d+$/.test(text)) throw new CborError('invalid_key');
    return { kind: 'simple', value: Number(text) };
  }
  throw new CborError('unsupported_key_type');
}
