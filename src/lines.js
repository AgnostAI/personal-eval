import fs from 'node:fs';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';

const HEAD = 512;
const MAX_LINE = 256 * 1024 * 1024;

/**
 * Stream a (possibly zstd-compressed) JSONL file line by line.
 *
 * - Splits on "\n" bytes only. node:readline also splits on U+2028/U+2029,
 *   which appear raw inside JSON strings in real agent logs.
 * - Works on Buffers so multi-megabyte lines are joined once, not re-scanned
 *   per chunk.
 * - `skip(head)` sees the first 512 bytes of each line; returning true drops the
 *   line without decoding the rest (agent logs have huge lines we never need).
 */
export async function* readLines(file, { skip } = {}) {
  const stream = openStream(file);
  let parts = [];
  let size = 0;
  let skipping = false;
  let decided = false;

  const decide = (buf) => {
    decided = true;
    skipping = !!(skip && skip(buf.subarray(0, HEAD).toString('utf8')));
  };

  for await (const chunk of stream) {
    let start = 0;
    let nl;
    while ((nl = chunk.indexOf(10, start)) !== -1) {
      const piece = chunk.subarray(start, nl);
      start = nl + 1;
      if (!parts.length) {
        if (!decided) decide(piece);
        if (!skipping && piece.length) yield piece.toString('utf8');
      } else {
        if (!decided) decide(Buffer.concat([...parts, piece]));
        if (!skipping) {
          parts.push(piece);
          const buf = Buffer.concat(parts, size + piece.length);
          if (buf.length <= MAX_LINE) yield buf.toString('utf8');
        }
      }
      parts = [];
      size = 0;
      skipping = false;
      decided = false;
    }
    if (start < chunk.length) {
      const tail = chunk.subarray(start);
      if (!decided && (size + tail.length >= HEAD)) decide(parts.length ? Buffer.concat([...parts, tail]) : tail);
      if (!skipping) {
        parts.push(tail);
        size += tail.length;
        if (size > MAX_LINE) skipping = true;
      } else if (!parts.length) {
        parts.push(Buffer.alloc(0)); // remember we're mid-line
      }
    }
  }
  if (parts.length && !skipping && size) {
    const buf = Buffer.concat(parts, size);
    if (!decided) decide(buf);
    if (!skipping) yield buf.toString('utf8');
  }
}

function openStream(file) {
  if (!file.endsWith('.zst')) return fs.createReadStream(file, { highWaterMark: 1 << 20 });
  if (typeof zlib.createZstdDecompress === 'function') {
    return fs.createReadStream(file, { highWaterMark: 1 << 20 }).pipe(zlib.createZstdDecompress());
  }
  // Older Node without built-in zstd: fall back to the zstd CLI if present.
  const child = spawn('zstd', ['-dc', file], { stdio: ['ignore', 'pipe', 'ignore'] });
  child.on('error', () => child.stdout.destroy(new Error('zstd not available (needs Node 22.15+ or the zstd CLI)')));
  return child.stdout;
}

/** Parse a JSON line, returning null on failure. */
export function tryJSON(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
