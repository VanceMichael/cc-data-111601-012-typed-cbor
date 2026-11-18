import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';

// 测试专用桩来源：以固定小块发送任意字节，用于构造截断与损坏序列。
function startStub(payload, chunkSize = 1) {
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/octet-stream');
    for (let offset = 0; offset < payload.length; offset += chunkSize)
      response.write(payload.subarray(offset, offset + chunkSize));
    response.end();
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () =>
    resolve({ server, url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise(done => server.close(done)) })));
}

async function withHarness(t, source) {
  const directory = await mkdtemp(join(tmpdir(), 'typed-inbox-'));
  const service = await startService({ source, directory });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, directory };
}

test('CBOR sequence 流式接收：分块边界任意，异构键不折叠、重复键不消解', async t => {
  const provider = await startProvider();
  t.after(() => provider.close());
  const { service } = await withHarness(t, provider.url);
  const response = await fetch(`${service.url}/sequence-intakes`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/sequence' }) });
  assert.equal(response.status, 201);
  const record = await response.json();
  assert.equal(record.parsed.kind, 'cbor-sequence');
  const rep = record.parsed.representation;
  assert.equal(rep.items.length, 3);
  const mapNode = rep.items[0].node;
  assert.equal(mapNode.entries.length, 3);
  assert.deepEqual(mapNode.entries.map(e => e.key.kind), ['uint', 'text', 'uint']);
  assert.deepEqual(mapNode.entries.map(e => e.value.value), ['num', 'txt', 'again']);
  assert.deepEqual(rep.items[1].node, { kind: 'tag', tag: '2',
    content: { kind: 'bytes', value: 'AQAAAAAAAAAA' } });

  // 重领同 source 同摘要返回原 id
  const again = await (await fetch(`${service.url}/sequence-intakes`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/sequence' }) })).json();
  assert.equal(again.id, record.id);
  assert.equal((await (await fetch(`${service.url}/records`)).json()).length, 1);
});

test('结构化文档与类型化条目查询保持键类型区分和整数范围约定', async t => {
  const provider = await startProvider();
  t.after(() => provider.close());
  const { service } = await withHarness(t, provider.url);
  const record = await (await fetch(`${service.url}/sequence-intakes`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/sequence' }) })).json();

  const document = await (await fetch(`${service.url}/documents/${record.digest}`)).json();
  assert.equal(document.itemCount, 3);
  assert.ok(document.items[0].span.end > document.items[0].span.start);

  const numeric = await (await fetch(
    `${service.url}/documents/${record.digest}/entries?keyType=uint&key=1`)).json();
  assert.equal(numeric.count, 2);
  assert.deepEqual(numeric.entries.map(e => e.value.value), ['num', 'again']);

  const textual = await (await fetch(
    `${service.url}/documents/${record.digest}/entries?keyType=text&key=1`)).json();
  assert.equal(textual.count, 1);
  assert.equal(textual.entries[0].value.value, 'txt');

  const ranged = await (await fetch(
    `${service.url}/documents/${record.digest}/entries?keyMin=0&keyMax=2`)).json();
  assert.equal(ranged.count, 2);

  const invalidKey = await fetch(
    `${service.url}/documents/${record.digest}/entries?keyType=uint&key=x`);
  assert.equal(invalidKey.status, 422);
  assert.equal((await invalidKey.json()).error, 'invalid_key');

  assert.equal((await fetch(`${service.url}/documents/${'a'.repeat(64)}`)).status, 404);
});

test('原件 bytes 范围按交换约定处理，非法范围 416 而非猜测', async t => {
  const provider = await startProvider();
  t.after(() => provider.close());
  const { service } = await withHarness(t, provider.url);
  const record = await (await fetch(`${service.url}/sequence-intakes`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/sequence' }) })).json();
  const fixture = await readFile(new URL('../fixtures/resource-01.bin', import.meta.url));

  const ranged = await fetch(`${service.url}/objects/${record.digest}`, { headers: { range: 'bytes=19-29' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes 19-29/${fixture.length}`);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), fixture.subarray(19, 30));

  const full = await fetch(`${service.url}/objects/${record.digest}`);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), fixture);

  const bad = await fetch(`${service.url}/objects/${record.digest}`, { headers: { range: 'bytes=99-100' } });
  assert.equal(bad.status, 416);
  const openEnded = await fetch(`${service.url}/objects/${record.digest}`, { headers: { range: 'bytes=0-' } });
  assert.equal(openEnded.status, 416); // 只支持闭合的单一 bytes 范围
});

test('截断的顶层尾值显式拒收，不登记、不把后续字节猜成新记录', async t => {
  const truncated = await readFile(new URL('../fixtures/resource-02.bin', import.meta.url));
  // 截断数据后附加一个完全合法的顶层值，验证不会被当成新记录救回
  const payload = Buffer.concat([truncated, Buffer.from([0x01])]);
  const stub = await startStub(payload, 1);
  t.after(() => stub.close());
  const { service } = await withHarness(t, stub.url);

  const response = await fetch(`${service.url}/sequence-intakes`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/x' }) });
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.error, 'cbor_sequence_truncated');
  assert.deepEqual(await (await fetch(`${service.url}/records`)).json(), []);
});

test('结构损坏毒化来源：后续合法前缀也不扫描恢复', async t => {
  // 声明 1 个条目的 map，键却是非法 UTF-8 文本，后面再跟一个合法 uint
  const payload = Buffer.from([0xa1, 0x61, 0xff, 0x01]);
  const stub = await startStub(payload, 1);
  t.after(() => stub.close());
  const { service } = await withHarness(t, stub.url);

  const response = await fetch(`${service.url}/sequence-intakes`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/x' }) });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error, 'cbor_invalid_utf8');
  assert.deepEqual(await (await fetch(`${service.url}/records`)).json(), []);
});

test('不定长容器来源与兼容入口共存：旧记录不冒充类型化表示', async t => {
  const provider = await startProvider();
  t.after(() => provider.close());
  const { service } = await withHarness(t, provider.url);

  const nested = await (await fetch(`${service.url}/sequence-intakes`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/nested' }) })).json();
  assert.equal(nested.parsed.representation.items[0].node.entries[1].value.kind, 'null');

  const legacy = await (await fetch(`${service.url}/intakes`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/primary' }) })).json();
  assert.equal(legacy.parsed.kind, 'simple-cbor-value');
  const conflict = await fetch(`${service.url}/documents/${legacy.digest}`);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, 'not_typed_representation');
});
