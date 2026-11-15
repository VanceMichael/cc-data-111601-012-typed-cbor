import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect, decodeSimple } from '../src/reader.mjs';
const primary=await readFile(new URL('../fixtures/primary.bin',import.meta.url));
const manifest=JSON.parse(await readFile(new URL('../fixtures/upstream.json',import.meta.url),'utf8'));
async function resource(path) {
  const item=manifest.resources[path];
  return item.file ? readFile(new URL(`../fixtures/${item.file}`,import.meta.url)) : Buffer.from(item.body);
}

test('受支持的单值类型保持原数据',()=>{
  const result=inspect(primary);assert.equal(result.value.name,'sensor');assert.equal(result.value.value,10);
  assert.deepEqual(decodeSimple(Buffer.from([0x82,1,2])).value,[1,2]);
});
test('简单读取器对不支持的键类型明确拒绝而非折叠',()=>{
  assert.throws(()=>inspect(Buffer.from([0xa1,1,2])));assert.throws(()=>inspect(Buffer.from([0x61,0xff])));
});
test('序列样例含重复映射与大整数，不冒充已支持',async()=>{
  const sequence=await resource('/sequence');assert.equal(sequence[0],0xa3);
  assert.ok(sequence.includes(Buffer.from([0xc2,0x49])));assert.throws(()=>inspect(sequence));
  assert.throws(()=>decodeSimple(Buffer.from([0x19,1])));
});
