import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CborSequenceDecoder, decodeSingle, decodeSequence, isIncomplete,
} from '../src/cbor.mjs';
import { canonicalKey, parseKeyQuery } from '../src/model.mjs';
import { TypedInbox, splitSequence } from '../src/store.mjs';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';

const query = string => parseKeyQuery(new URLSearchParams(string));

const hex = text => Buffer.from(text.replace(/\s+/g, ''), 'hex');
const SEQUENCE = 'a301636e756d6131637478740165616761696ec2490100000000000000005f4201024103ff';

function nodeByKey(value, type, text) {
  return value.entries.find(entry => entry.key.type === type && entry.key.value === text);
}

test('映射保留键类型、重复条目和来源顺序', () => {
  const [first] = decodeSequence(hex(SEQUENCE));
  assert.equal(first.value.type, 'map');
  const keys = first.value.entries.map(entry => [entry.key.type, entry.key.value ?? entry.key.base64]);
  assert.deepEqual(keys, [['uint', '1'], ['text', '1'], ['uint', '1']]);
  // Duplicate integer keys are two entries with distinct values, not a merge.
  const duplicates = first.value.entries.filter(entry => entry.key.type === 'uint');
  assert.deepEqual(duplicates.map(entry => entry.value.value), ['num', 'again']);
  assert.notEqual(canonicalKey(nodeByKey(first.value, 'uint', '1').key),
    canonicalKey(nodeByKey(first.value, 'text', '1').key));
});

test('二进制、标签和浮点保留原始位型', () => {
  const [, tagged, sequenceBytes] = decodeSequence(hex(SEQUENCE));
  assert.equal(tagged.value.type, 'tag');
  assert.equal(tagged.value.tag, '2');
  assert.equal(tagged.value.value.base64, 'AQAAAAAAAAAA');
  assert.equal(sequenceBytes.value.base64, 'AQID');
  assert.equal(sequenceBytes.value.length, 3);

  const bignum = decodeSingle(hex('c249010000000000000000')).value;
  assert.equal(BigInt(`0x${Buffer.from(bignum.value.base64, 'base64').toString('hex')}`),
    2n ** 64n);
  const float = decodeSingle(hex('fb7ff8000000000001')).value;
  assert.equal(float.special, 'nan');
  assert.equal(float.bits, '7ff8000000000001');
  const negativeZero = decodeSingle(hex('f98000')).value;
  assert.equal(negativeZero.negativeZero, true);
  assert.equal(Object.is(negativeZero.value, -0), false);
});

test('序列解码按任意块边界增量切分，不把块当记录', () => {
  const bytes = hex(SEQUENCE);
  const decoder = new CborSequenceDecoder();
  const items = [];
  for (let index = 0; index < bytes.length; index++) {
    items.push(...decoder.feed(bytes.subarray(index, index + 1)));
  }
  assert.equal(items.length, 3);
  assert.deepEqual(items.map(item => [item.ordinal, item.offset, item.length]),
    [[0, 0, 19], [1, 19, 11], [2, 30, 7]]);
  assert.equal(decoder.end().pending, null);
});

test('截断尾值等待续收，不扫描后续字节猜测新记录', () => {
  const decoder = new CborSequenceDecoder();
  assert.deepEqual(decoder.feed(hex('a20181616d02a1')), []);
  const tail = decoder.end().pending;
  assert.equal(tail.offset, 0);
  assert.equal(tail.length, 7);
  // The remaining bytes complete the truncated nested map; they are not a
  // fresh record of their own.
  const completed = decoder.feed(hex('616b01'));
  assert.equal(completed.length, 1);
  assert.deepEqual(completed[0].value.entries.map(entry => entry.key.value), ['1', '2']);
  assert.deepEqual(completed[0].value.entries[1].value.entries.map(entry => entry.key.value), ['k']);
  assert.equal(decoder.end().pending, null);

  // A tail that would parse as an item if scanned from a later offset stays
  // pending: `02` is the second map key, not a new top-level integer.
  const suffix = new CborSequenceDecoder();
  assert.deepEqual(suffix.feed(hex('a20181616d02')), []);
  assert.equal(suffix.end().pending.length, 6);
  const split = splitSequence(hex('a20181616d02'));
  assert.equal(split.records.length, 0);
  assert.equal(split.pending.length, 6);
});

test('结构损坏显式失败并停止该来源', () => {
  const decoder = new CborSequenceDecoder();
  assert.throws(() => decoder.feed(hex('a201ff')), error => error.code === 'cbor_break_after_map_key');
  assert.throws(() => decoder.feed(hex('01')), error => !isIncomplete(error));
  assert.throws(() => decodeSingle(hex('a161ff00')), error => error.code === 'cbor_invalid_utf8');
  assert.throws(() => decodeSingle(hex('5f6100ff')), error => error.code === 'cbor_indefinite_chunk_type');
  assert.throws(() => decodeWith(hex('8181'), { maxDepth: 0 }), error => error.code === 'cbor_depth_exceeded');
  assert.ok(isIncomplete(capture(() => decodeSingle(hex('a2')))));
});

function decodeWith(bytes, options) {
  return decodeSingle(bytes, options);
}
function capture(operation) {
  try { operation(); return null; } catch (error) { return error; }
}

test('查询按键类型区分 1 与 "1"，重复键返回全部条目', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'typed-inbox-'));
  const inbox = await new TypedInbox(directory).initialize();
  try {
    await inbox.acceptSequence(hex(SEQUENCE), 'memory:/sequence');
    const uintEntries = await inbox.entries({ query: query('keyType=uint&key=1') });
    assert.deepEqual(uintEntries.map(entry => entry.value.value), ['num', 'again']);
    assert.deepEqual(uintEntries.map(entry => entry.path.at(-1).index), [0, 2]);
    const textEntries = await inbox.entries({ query: query('keyType=text&key=1') });
    assert.deepEqual(textEntries.map(entry => entry.value.value), ['txt']);
    assert.deepEqual((await inbox.entries({ query: query('keyType=uint') })).length, 2);
    assert.deepEqual((await inbox.entries({ query: query(
      `key=${encodeURIComponent(JSON.stringify({ type: 'uint', value: '1' }))}`) })).length, 2);
    assert.equal((await inbox.entries({ query: query('keyType=uint&key=01') })).length, 2);
    // Three map entries plus the bare tag and byte-string top-level roots.
    assert.equal((await inbox.entries({})).length, 5);
    assert.equal((await inbox.entries({ query: query('valueType=bytes') }))[0].path.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('记录可按 span 取回原始字节，重开索引保持', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'typed-span-'));
  const bytes = hex(SEQUENCE);
  try {
    const inbox = await new TypedInbox(directory).initialize();
    const accepted = await inbox.acceptSequence(bytes, 'memory:/sequence');
    assert.deepEqual(accepted.records.map(record => record.span),
      [{ start: 0, end: 19 }, { start: 19, end: 30 }, { start: 30, end: 37 }]);
    assert.deepEqual(accepted.records.map(record => record.digest),
      [accepted.digest, accepted.digest, accepted.digest]);
    const reaccepted = await inbox.acceptSequence(bytes, 'memory:/sequence');
    assert.deepEqual(reaccepted.records.map(record => record.id),
      accepted.records.map(record => record.id));

    const reopened = await new TypedInbox(directory).initialize();
    const records = await reopened.records({ kind: 'sequence' });
    assert.equal(records.length, 3);
    for (const record of records) {
      assert.deepEqual(await reopened.recordObject(record), bytes.subarray(
        record.span.start, record.span.end));
    }
    assert.deepEqual(await reopened.object(accepted.digest), bytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('服务按来源真实分块接收序列并支持类型化查询', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'typed-service-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const response = await fetch(`${service.url}/sequences`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/sequence' }) });
    assert.equal(response.status, 201);
    const accepted = await response.json();
    assert.equal(accepted.records.length, 3);
    assert.equal(accepted.pending, null);

    const queried = await (await fetch(`${service.url}/records?keyType=uint&key=1`)).json();
    assert.deepEqual(queried.entries.map(entry => entry.value.value), ['num', 'again']);
    const text = await (await fetch(`${service.url}/records?keyType=text&key=1`)).json();
    assert.deepEqual(text.entries.map(entry => entry.value.value), ['txt']);
    const bytes = await (await fetch(`${service.url}/records?valueType=bytes`)).json();
    assert.equal(bytes.entries.length, 1);
    assert.equal((await (await fetch(`${service.url}/records`)).json()).length, 3);

    const record = accepted.records[1];
    const exact = Buffer.from(await (await fetch(
      `${service.url}/records/${record.id}/bytes`)).arrayBuffer());
    assert.deepEqual(exact, hex(SEQUENCE).subarray(record.span.start, record.span.end));
    assert.deepEqual(await (await fetch(
      `${service.url}/objects/${record.object}`)).arrayBuffer().then(Buffer.from), hex(SEQUENCE));

    const truncated = await fetch(`${service.url}/sequences`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/truncated' }) });
    assert.equal(truncated.status, 409);
    const pending = await truncated.json();
    assert.equal(pending.error, 'cbor_incomplete');
    assert.deepEqual(pending.pending, { offset: 0, length: 7 });
    assert.equal((await (await fetch(`${service.url}/records`)).json()).length, 3);

    const partial = await fetch(`${service.url}/sequences`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/truncated', allowPending: true }) });
    assert.equal(partial.status, 202);
    assert.deepEqual((await partial.json()).pending, { offset: 0, length: 7 });
  } finally {
    await service.close(); await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});
