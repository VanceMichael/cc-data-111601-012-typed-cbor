import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';

const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = await startProvider();
const service = await startService({ source: provider.url, directory });
const post = (path, body) => fetch(`${service.url}${path}`, { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
try {
  console.log(JSON.stringify({ source: provider.url, product: service.url }));
  console.log('来源目录', await (await fetch(`${provider.url}/catalog`)).json());

  const response = await post('/sequence-intakes', { path: '/sequence' });
  if (response.status !== 201) throw new Error(await response.text());
  const record = await response.json();
  console.log('序列接收：顶层值数量', record.parsed.representation.items.length,
    '摘要', record.digest.slice(0, 12));

  const numeric = await (await fetch(
    `${service.url}/documents/${record.digest}/entries?keyType=uint&key=1`)).json();
  console.log('整数键 1 命中（不与文本键 "1" 折叠，重复键全部保留）',
    numeric.entries.map(entry => entry.value.value));

  const textual = await (await fetch(
    `${service.url}/documents/${record.digest}/entries?keyType=text&key=1`)).json();
  console.log('文本键 "1" 命中', textual.entries.map(entry => entry.value.value));

  const ranged = await (await fetch(
    `${service.url}/documents/${record.digest}/entries?keyMin=0&keyMax=5`)).json();
  console.log('整数范围 0..5 命中', ranged.count);

  const bytes = await fetch(`${service.url}/objects/${record.digest}`,
    { headers: { range: 'bytes=19-29' } });
  console.log('原件 bytes 范围', bytes.status, bytes.headers.get('content-range'));

  const truncated = await post('/sequence-intakes', { path: '/truncated' });
  console.log('截断记录拒收', truncated.status, await truncated.json());

  console.log('已保存资料', (await (await fetch(`${service.url}/records`)).json()).map(item => item.id));
} finally {
  await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true });
}
