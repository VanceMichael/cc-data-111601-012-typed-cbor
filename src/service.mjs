import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { TypedInbox } from './store.mjs';
import { acquire, acquireStream } from './transport.mjs';
import { inspect } from './reader.mjs';
import { CborSequenceDecoder } from './cbor.mjs';
import { parseKeyQuery } from './model.mjs';

async function readBody(request, limit) {
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function startService({ source, directory, port = 0 }) {
  const inbox = await new TypedInbox(directory).initialize();
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health') return response.end(JSON.stringify({ ready: true }));

      if (url.pathname === '/records' && request.method === 'GET') {
        const query = parseKeyQuery(url.searchParams);
        const kind = url.searchParams.get('kind');
        const digest = url.searchParams.get('digest');
        // Additive query form: with no query parameters at all, the legacy
        // array shape above is preserved.
        if (query === null && kind === null && digest === null) {
          return response.end(JSON.stringify(await inbox.list()));
        }
        return response.end(JSON.stringify({
          records: await inbox.records({ kind, digest, query }),
          entries: await inbox.entries({ query, kind, digest }),
        }));
      }

      if (url.pathname.startsWith('/objects/') && request.method === 'GET') {
        response.setHeader('Content-Type', 'application/octet-stream');
        return response.end(await inbox.object(url.pathname.slice(9)));
      }

      // Exact bytes of one record, sliced from its stored source object.
      if (url.pathname.startsWith('/records/') && request.method === 'GET'
        && url.pathname.endsWith('/bytes')) {
        const id = url.pathname.slice(9, -6);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
          throw new Error('invalid_record_id');
        }
        response.setHeader('Content-Type', 'application/octet-stream');
        return response.end(await inbox.recordObject(await inbox.record(id)));
      }

      // Compatibility intake: unchanged behavior and record shape.
      if (url.pathname === '/intakes' && request.method === 'POST') {
        const payload = JSON.parse((await readBody(request, 16384)).toString());
        if (typeof payload.path !== 'string') throw new Error('path_required');
        const result = await acquire(source, payload.path);
        const parsed = inspect(result.bytes);
        const record = await inbox.accept(result.bytes, new URL(payload.path, source).href, parsed);
        response.statusCode = 201;
        return response.end(JSON.stringify(record));
      }

      // Sequence intake. Chunks are fed to the decoder as they arrive; block
      // boundaries are unrelated to value boundaries and an incomplete tail
      // is reported, never guessed into records.
      if (url.pathname === '/sequences' && request.method === 'POST') {
        const payload = JSON.parse((await readBody(request, 16384)).toString());
        if (typeof payload.path !== 'string') throw new Error('path_required');
        if (payload.allowPending !== undefined && typeof payload.allowPending !== 'boolean') {
          throw new Error('allowPending_must_be_boolean');
        }
        const decoder = new CborSequenceDecoder();
        const items = [];
        let sourceError = null;
        const result = await acquireStream(source, payload.path, {
          onChunk: piece => {
            try {
              for (const item of decoder.feed(piece)) items.push(item);
            } catch (error) {
              // Stop decoding once the stream is structurally corrupt. No
              // later bytes are scanned for a parseable restart point, and
              // this intake is rejected without creating records.
              sourceError = error;
            }
          },
        });
        if (sourceError) {
          // The decoder is stopped; its pending offset is no longer a
          // trustworthy value boundary, so only the error code is reported.
          // Complete items seen before the fault already carry their source
          // span in the saved object, so nothing is guessed about the rest.
          response.statusCode = 422;
          return response.end(JSON.stringify({ error: sourceError.code ?? sourceError.message }));
        }
        const tail = decoder.end();
        let accepted;
        try {
          accepted = await inbox.acceptSequenceItems(result.bytes, new URL(payload.path, source).href, {
            items, pending: tail.pending, allowPending: payload.allowPending === true,
          });
        } catch (error) {
          if (error.code === 'cbor_incomplete') {
            response.statusCode = 409;
            return response.end(JSON.stringify({ error: 'cbor_incomplete', pending: error.pending }));
          }
          throw error;
        }
        response.statusCode = accepted.records.length === 0 && accepted.pending ? 202 : 201;
        return response.end(JSON.stringify({
          digest: accepted.digest,
          source: new URL(payload.path, source).href,
          object: accepted.digest,
          records: accepted.records,
          pending: accepted.pending
            ? { offset: accepted.pending.offset, length: accepted.pending.length }
            : null,
        }));
      }

      response.writeHead(404); response.end(JSON.stringify({ error: 'not_found' }));
    } catch (error) { response.statusCode = 422; response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, inbox, store: inbox, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)) };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.SOURCE_URL) throw new Error('SOURCE_URL_required');
  const service = await startService({ source: process.env.SOURCE_URL,
    directory: process.env.DATA_DIR ?? './data', port: Number(process.env.PORT ?? 4102) });
  console.log(JSON.stringify({ product: service.url }));
}
