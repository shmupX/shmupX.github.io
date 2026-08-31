// The compression the PS2 export needs, on the platform's own streams: zlib
// for PNG chunks, gzip for the AthenaEnv release tarball. Nothing to install.

/**
 * A byte buffer backed by a plain ArrayBuffer. Spelling it out keeps the
 * stream APIs — which refuse a possibly-shared buffer — happy without casts.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

async function pump(
  bytes: Bytes,
  stream: {
    writable: WritableStream<BufferSource>;
    readable: ReadableStream<Uint8Array>;
  },
): Promise<Bytes> {
  const writer = stream.writable.getWriter();
  const written = writer.write(bytes).then(() => writer.close());
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const part of stream.readable) {
    chunks.push(part);
    total += part.length;
  }
  await written;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of chunks) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Inflate a zlib stream — the form a PNG IDAT holds. */
export const inflate = (bytes: Bytes): Promise<Bytes> =>
  pump(bytes, new DecompressionStream("deflate"));

/** Deflate to a zlib stream. */
export const deflate = (bytes: Bytes): Promise<Bytes> =>
  pump(bytes, new CompressionStream("deflate"));

/** Inflate a gzip stream. */
export const ungzip = (bytes: Bytes): Promise<Bytes> =>
  pump(bytes, new DecompressionStream("gzip"));

/**
 * Deflate to a RAW stream — no zlib header, no adler32. That is the only
 * shape a ZIP entry's method-8 payload may take.
 */
export const deflateRaw = (bytes: Bytes): Promise<Bytes> =>
  pump(bytes, new CompressionStream("deflate-raw"));
