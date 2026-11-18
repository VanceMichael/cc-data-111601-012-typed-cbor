import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  decodeOne, decodeSequence, createSequenceParser, selectEntries,
  CborError, CborShortError, DEFAULT_LIMITS
} from '../src/cbor.mjs';

// 测试用最小 CBOR 编码器，仅用于构造输入。
const enc = {
  uint: n => {
    const v = BigInt(n);
    if (v < 24n) return Buffer.from([Number(v)]);
    if (v < 256n) return Buffer.from([24, Number(v)]);
    if (v < 65536n) { const b = Buffer.alloc(3); b[0] = 25; b.writeUInt16BE(Number(v), 1); return b; }
    if (v < 4294967296n) { const b = Buffer.alloc(5); b[0] = 26; b.writeUInt32BE(Number(v), 1); return b; }
    const b = Buffer.alloc(9); b[0] = 27; b.writeBigUInt64BE(v, 1); return b;
  },
  nint: n => { const u = enc.uint(-BigInt(n) - 1n); return Buffer.from([0x20 | u[0], ...u.subarray(1)]); },
  text: s => { const body = Buffer.from(s, 'utf8'); return Buffer.concat([head(3, body.length), body]); },
  bytes: b => Buffer.concat([head(2, b.length), b]),
  array: items => Buffer.concat([head(4, items.length), ...items]),
  map: pairs => Buffer.concat([head(5, pairs.length), ...pairs.flat()]),
  tag: (tag, content) => Buffer.concat([head(6, tag), content])
};
function head(major, length) {
  const l = BigInt(length);
  if (l < 24n) return Buffer.from([(major << 5) | Number(l)]);
  if (l < 256n) return Buffer.from([(major << 5) | 24, Number(l)]);
  if (l < 65536n) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(Number(l), 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(Number(l), 1); return b;
}

test('整数范围：uint64/nint64 以十进制字符串保真，不丢精度', () => {
  const big = 18446744073709551615n;
  assert.deepEqual(decodeOne(enc.uint(big)), { kind: 'uint', value: big.toString() });
  assert.deepEqual(decodeOne(enc.nint(-18446744073709551616n)), { kind: 'nint', value: '-18446744073709551616' });
  assert.deepEqual(decodeOne(Buffer.from([0x00])), { kind: 'uint', value: '0' });
  assert.deepEqual(decodeOne(Buffer.from([0x20])), { kind: 'nint', value: '-1' });
});

test('二进制值与不定长 byte string 拼接后仍可还原原件', () => {
  const node = decodeOne(Buffer.from([0x5f, 0x42, 1, 2, 0x41, 3, 0xff]));
  assert.deepEqual(node, { kind: 'bytes', value: Buffer.from([1, 2, 3]).toString('base64') });
  assert.deepEqual(Buffer.from(node.value, 'base64'), Buffer.from([1, 2, 3]));
  assert.equal(decodeOne(Buffer.from([0x43, 1, 2, 3])).kind, 'bytes');
});

test('tag 保留 tag 号与内容，不解读业务语义', () => {
  const node = decodeOne(enc.tag(2, enc.bytes(Buffer.from([1, 2]))));
  assert.deepEqual(node, { kind: 'tag', tag: '2', content: { kind: 'bytes', value: Buffer.from([1, 2]).toString('base64') } });
});

test('数字 1、文本 "1"、标签键不折叠；重复键保留顺序与全部值', () => {
  const taggedKey = enc.tag(0, enc.uint(1));
  const input = enc.map([
    [enc.uint(1), enc.text('num')],
    [enc.text('1'), enc.text('txt')],
    [taggedKey, enc.text('labelled')],
    [enc.uint(1), enc.text('again')]
  ]);
  const node = decodeOne(input);
  assert.equal(node.entries.length, 4);
  assert.deepEqual(node.entries.map(e => e.key.kind), ['uint', 'text', 'tag', 'uint']);
  assert.deepEqual(node.entries.map(e => e.value.value), ['num', 'txt', 'labelled', 'again']);
  const numeric = selectEntries({ items: [{ node }] }, { keyType: 'uint', key: '1' });
  // 标签键的内容也是整数 1，按类型化匹配一并命中；重复的整数键两条均保留
  assert.equal(numeric.length, 3);
  assert.deepEqual(numeric.map(m => m.value.value), ['num', 'labelled', 'again']);
  const textual = selectEntries({ items: [{ node }] }, { keyType: 'text', key: '1' });
  assert.equal(textual.length, 1);
  assert.equal(textual[0].value.value, 'txt');
  const tagged = selectEntries({ items: [{ node }] }, { keyType: 'uint', key: '1', tag: '0' });
  assert.equal(tagged.length, 1);
  assert.equal(tagged[0].value.value, 'labelled');
});

test('整数范围查询按 BigInt 数值比较，覆盖有符号与标签内容', () => {
  const input = enc.map([
    [enc.uint(10), enc.text('a')], [enc.uint(100), enc.text('b')],
    [enc.nint(-5), enc.text('c')], [enc.text('10'), enc.text('d')]
  ]);
  const root = { items: [{ node: decodeOne(input) }] };
  const ranged = selectEntries(root, { keyMin: '-10', keyMax: '10' });
  assert.deepEqual(ranged.map(m => m.value.value).sort(), ['a', 'c']);
  assert.throws(() => selectEntries(root, { keyMin: '9', keyMax: '1' }), /invalid_integer_range/);
});

test('映射条目顺序与嵌套路径可回溯', () => {
  const inner = enc.map([[enc.uint(7), enc.uint(8)]]);
  const outer = decodeOne(enc.map([[enc.text('k'), enc.array([inner])]]));
  const found = selectEntries({ items: [{ node: outer }] }, { keyType: 'uint', key: '7' });
  assert.deepEqual(found[0].path, [0, 'value', 0, 0]);
  assert.deepEqual(found[0].value, { kind: 'uint', value: '8' });
});

test('float16/32/64、非有限浮点与 -0 均为 JSON 安全表示', () => {
  assert.equal(decodeOne(Buffer.from([0xf9, 0x3c, 0x00])).value, 1);
  const nan = decodeOne(Buffer.from([0xf9, 0x7e, 0x00]));
  assert.equal(nan.nonFinite, 'NaN');
  assert.doesNotThrow(() => JSON.stringify(nan));
  const negZero = decodeOne(Buffer.from([0xf9, 0x80, 0x00]));
  assert.equal(negZero.value, 0);
  assert.equal(negZero.negativeZero, true);
});

test('简单值、bool/null/undefined 各自区分', () => {
  assert.deepEqual(decodeOne(Buffer.from([0xf4])), { kind: 'bool', value: false });
  assert.deepEqual(decodeOne(Buffer.from([0xf5])), { kind: 'bool', value: true });
  assert.deepEqual(decodeOne(Buffer.from([0xf6])), { kind: 'null' });
  assert.deepEqual(decodeOne(Buffer.from([0xf7])), { kind: 'undefined' });
  assert.deepEqual(decodeOne(Buffer.from([0xf8, 33])), { kind: 'simple', value: 33 });
  assert.deepEqual(decodeOne(Buffer.from([0xf8, 99])), { kind: 'simple', value: 99 });
  assert.throws(() => decodeOne(Buffer.from([0xf8, 19])), /simple_reserved/);
  assert.throws(() => decodeOne(Buffer.from([0xf8, 32])), /simple_reserved/);
});

test('严格 UTF-8 校验与显式深度/规模限制', () => {
  assert.throws(() => decodeOne(Buffer.from([0x61, 0xff])), CborError);
  const deep = enc.array([enc.array([enc.array([enc.uint(1)])])]);
  assert.throws(() => decodeOne(deep, { ...DEFAULT_LIMITS, maxDepth: 2 }), /depth_exceeded/);
  assert.throws(() => decodeOne(Buffer.from([0x82, 1])), CborShortError);
  assert.throws(() => decodeOne(Buffer.from([0x19, 1])), CborShortError);
  assert.throws(() => decodeOne(Buffer.from([0x7f, 1])), CborError); // 不定长容器不允许跨类型 chunk
});

test('序列解析：分块位置任意，顶层值跨度可切回原件', async () => {
  const sequence = await readFile(new URL('../fixtures/resource-01.bin', import.meta.url));
  const parsed = decodeSequence(sequence);
  assert.equal(parsed.items.length, 3);
  for (const item of parsed.items) {
    const slice = sequence.subarray(item.span.start, item.span.end);
    assert.doesNotThrow(() => decodeOne(slice));
  }
  for (const split of [1, 2, 3, 5, 13]) {
    const parser = createSequenceParser();
    for (let offset = 0; offset < sequence.length; offset += split) parser.push(sequence.subarray(offset, offset + split));
    const finished = parser.finish();
    assert.equal(finished.items.length, 3);
    assert.ok(finished.bytes.equals(sequence));
  }
});

test('结构不完整：等待续收，续收后成功；最终截断显式失败', async () => {
  const sequence = await readFile(new URL('../fixtures/resource-01.bin', import.meta.url));
  const parser = createSequenceParser();
  parser.push(sequence.subarray(0, 21)); // 切在第二个顶层值中间
  assert.equal(parser.items.length, 1);
  parser.push(sequence.subarray(21));
  assert.equal(parser.finish().items.length, 3);

  const truncated = await readFile(new URL('../fixtures/resource-02.bin', import.meta.url));
  assert.throws(() => decodeSequence(truncated), CborShortError);
});

test('结构损坏后毒化来源，不把后续可解析字节猜成新记录', () => {
  // 0xa1 声明一个 map 条目，但键位置是非法 UTF-8 文本
  const corrupted = Buffer.concat([Buffer.from([0xa1, 0x61, 0xff]), enc.uint(42)]);
  const parser = createSequenceParser();
  assert.throws(() => parser.push(corrupted), CborError);
  assert.ok(parser.poisoned instanceof CborError);
  assert.throws(() => parser.push(enc.uint(1)), CborError);
  assert.throws(() => parser.finish(), CborError);
  // 另一种损坏：不定长容器给出跨类型 chunk，之后即便出现合法前缀也不得跳过
  assert.throws(() => decodeSequence(Buffer.from([0x7f, 1, 0xff, 1])), CborError);
});

test('查询键类型必须与声明一致，整数范围参数显式校验', () => {
  assert.throws(() => selectEntries({ items: [] }, { keyType: 'nint', key: '5' }), /invalid_key/);
  assert.throws(() => selectEntries({ items: [] }, { keyType: 'uint', key: '-1' }), /invalid_key/);
  assert.throws(() => selectEntries({ items: [] }, { keyType: 'uint' }), /key_required/);
  assert.throws(() => selectEntries({ items: [] }, { key: '1.5' }), /key_type_required/);
  assert.throws(() => selectEntries({ items: [] }, { tag: '2' }), /tag_key_requires_key/);
});

test('tag 不接受不定长头，simple 保留值与非法长度头显式失败', () => {
  assert.throws(() => decodeOne(Buffer.from([0xdf, 0x01])), CborError); // 不定长 tag 头非法
  assert.throws(() => decodeOne(Buffer.from([0xe0])), CborError);      // 保留 simple 0
  assert.throws(() => decodeOne(Buffer.from([0x1c])), CborError);      // 保留 additional
});

test('来源样例整体可解释且与约定一致', async () => {
  const sequence = await readFile(new URL('../fixtures/resource-01.bin', import.meta.url));
  const { items } = decodeSequence(sequence);
  assert.ok(sequence.includes(Buffer.from([0xc2, 0x49])));
  assert.equal(items[1].node.tag, '2');
  const nested = decodeSequence(await readFile(new URL('../fixtures/resource-03.bin', import.meta.url)));
  assert.equal(nested.items[0].node.entries[1].value.kind, 'null');
});