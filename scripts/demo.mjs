import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = await startProvider();
const service = await startService({ source: provider.url, directory });
try {
  console.log(JSON.stringify({ source: provider.url, product: service.url }));
  console.log('来源目录', await (await fetch(`${provider.url}/catalog`)).json());
  const response = await fetch(`${service.url}/intakes`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/primary' }) });
  if (response.status !== 201) throw new Error(await response.text());
  console.log('接收结果', await response.json());
  console.log('已保存资料', await (await fetch(`${service.url}/records`)).json());

  const sequence = await fetch(`${service.url}/sequences`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/sequence' }) });
  if (sequence.status !== 201) throw new Error(await sequence.text());
  const accepted = await sequence.json();
  console.log('序列接收', { digest: accepted.digest,
    spans: accepted.records.map(record => record.span) });
  const typed = await (await fetch(`${service.url}/records?keyType=uint&key=1`)).json();
  console.log('整数键 1 的条目', typed.entries.map(entry => entry.value));
  const text = await (await fetch(`${service.url}/records?keyType=text&key=1`)).json();
  console.log('文本键 "1" 的条目', text.entries.map(entry => entry.value));
} finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
