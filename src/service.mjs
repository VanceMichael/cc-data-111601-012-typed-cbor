import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { acquire, streamAcquire } from './transport.mjs';
import { inspect } from './reader.mjs';
import { createSequenceParser, selectEntries, CborError, CborShortError } from './cbor.mjs';
import { startProvider } from './provider.mjs';

// 交换约定的单一 bytes 范围：bytes=start-end，不支持开放式/多区间。
function parseSingleRange(header, size) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(header);
  if (!match) return { error: 'invalid_range' };
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start > end || end >= size) return { error: 'invalid_range' };
  return { start, end };
}

async function readJsonBody(request) {
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 16384) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

export async function startService({ source, directory, port = 0 }) {
  const store = await new Store(directory).initialize();
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      const url = new URL(request.url, 'http://localhost');

      if (url.pathname === '/health') return response.end(JSON.stringify({ ready: true }));

      if (url.pathname === '/records' && request.method === 'GET')
        return response.end(JSON.stringify(await store.list()));

      // GET /objects/{digest}：读取原件；支持交换约定的单一 bytes 范围。
      const objectMatch = /^\/objects\/([a-f0-9]{64})$/.exec(url.pathname);
      if (objectMatch && request.method === 'GET') {
        const digest = objectMatch[1];
        const full = await store.object(digest);
        response.setHeader('Content-Type', 'application/octet-stream');
        response.setHeader('Accept-Ranges', 'bytes');
        const rangeHeader = request.headers.range;
        if (rangeHeader) {
          const parsed = parseSingleRange(rangeHeader, full.length);
          if (parsed.error) { response.writeHead(416); return response.end(JSON.stringify({ error: parsed.error })); }
          response.writeHead(206, { 'Content-Range': `bytes ${parsed.start}-${parsed.end}/${full.length}` });
          return response.end(full.subarray(parsed.start, parsed.end + 1));
        }
        return response.end(full);
      }

      // GET /documents/{digest}：类型化无损表示（含顶层值字节跨度）。
      const documentMatch = /^\/documents\/([a-f0-9]{64})$/.exec(url.pathname);
      if (documentMatch && request.method === 'GET') {
        const record = await store.find(documentMatch[1]);
        if (!record) { response.writeHead(404); return response.end(JSON.stringify({ error: 'not_found' })); }
        if (record.parsed.kind !== 'cbor-sequence') {
          response.writeHead(409);
          return response.end(JSON.stringify({ error: 'not_typed_representation', parsed: record.parsed }));
        }
        const representation = record.parsed.representation;
        return response.end(JSON.stringify({
          digest: record.digest, source: record.source, bytes: record.bytes,
          itemCount: representation.items.length, items: representation.items
        }));
      }

      // GET /documents/{digest}/entries?keyType=&key=&keyMin=&keyMax=&tag=
      const entryMatch = /^\/documents\/([a-f0-9]{64})\/entries$/.exec(url.pathname);
      if (entryMatch && request.method === 'GET') {
        const record = await store.find(entryMatch[1]);
        if (!record) { response.writeHead(404); return response.end(JSON.stringify({ error: 'not_found' })); }
        if (record.parsed.kind !== 'cbor-sequence') {
          response.writeHead(409); return response.end(JSON.stringify({ error: 'not_typed_representation' }));
        }
        const parameters = Object.fromEntries(url.searchParams);
        const entries = selectEntries(record.parsed.representation, parameters);
        return response.end(JSON.stringify({ digest: record.digest, count: entries.length, entries }));
      }

      // 兼容入口：简单字符串键映射单值，解释失败不登记。
      if (url.pathname === '/intakes' && request.method === 'POST') {
        const payload = await readJsonBody(request);
        if (typeof payload.path !== 'string') throw new Error('path_required');
        const result = await acquire(source, payload.path);
        const parsed = inspect(result.bytes);
        const record = await store.accept(result.bytes, new URL(payload.path, source).href, parsed);
        response.statusCode = 201;
        return response.end(JSON.stringify(record));
      }

      // 类型化入口：流式接收 CBOR sequence，分块边界与值边界无关。
      if (url.pathname === '/sequence-intakes' && request.method === 'POST') {
        const payload = await readJsonBody(request);
        if (typeof payload.path !== 'string') throw new Error('path_required');
        const href = new URL(payload.path, source).href;
        const parser = createSequenceParser();
        await streamAcquire(source, payload.path, chunk => parser.push(chunk));
        // 截断尾值或结构损坏都显式失败，不登记、不扫描猜测后续字节。
        const finished = parser.finish();
        const record = await store.acceptTyped(finished.bytes, href, { items: finished.items });
        response.statusCode = 201;
        return response.end(JSON.stringify(record));
      }

      response.writeHead(404);
      return response.end(JSON.stringify({ error: 'not_found' }));
    } catch (error) {
      response.writeHead(422);
      return response.end(JSON.stringify({ error: error.code ?? error.message }));
    }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return {
    server, store, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const provider = process.env.SOURCE_URL ? null : await startProvider();
  const source = process.env.SOURCE_URL ?? provider.url;
  let service;
  try {
    service = await startService({ source, directory: process.env.DATA_DIR ?? './data',
      port: Number(process.env.PORT ?? 4102) });
  } catch (error) {
    if (provider) await provider.close();
    throw error;
  }
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await service.close();
    if (provider) await provider.close();
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  console.log(JSON.stringify({ product: service.url, source }));
}
