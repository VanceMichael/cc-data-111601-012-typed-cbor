const MAX_BYTES = 8 * 1024 * 1024;

export async function acquire(base, path, headers = {}) {
  return acquireStream(base, path, { headers });
}

// Same-origin, no-redirect acquisition that hands every network chunk to
// `onChunk` as it arrives. CBOR sequence block boundaries are not value
// boundaries, so callers must decode incrementally instead of assuming each
// response chunk is one record.
export async function acquireStream(base, path, { headers = {}, onChunk, maxBytes = MAX_BYTES } = {}) {
  const origin = new URL(base);
  const target = new URL(path, origin);
  if (target.origin !== origin.origin) throw new Error('outside_source');
  const response = await fetch(target, { headers, redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`source_status_${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    const piece = Buffer.from(chunk);
    size += piece.length;
    if (size > maxBytes) throw new Error('source_too_large');
    if (onChunk) onChunk(piece);
    chunks.push(piece);
  }
  return { bytes: Buffer.concat(chunks), headers: Object.fromEntries(response.headers), status: response.status };
}
