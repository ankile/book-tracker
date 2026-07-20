import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

const chunksDirectory = 'public/_app/immutable';
const javascriptFiles = readdirSync(chunksDirectory, { recursive: true })
  .filter((file) => file.endsWith('.js'))
  .map((file) => join(chunksDirectory, file));

test('the production JavaScript bundle stays within its transfer budget', () => {
  const gzipSizes = javascriptFiles.map((file) => ({
    file: basename(file),
    bytes: gzipSync(readFileSync(file)).byteLength
  }));
  const totalBytes = gzipSizes.reduce((total, chunk) => total + chunk.bytes, 0);
  const largestChunk = gzipSizes.toSorted((a, b) => b.bytes - a.bytes)[0];

  assert.ok(
    totalBytes <= 230 * 1024,
    `Expected at most 230 KiB of compressed JavaScript, received ${(totalBytes / 1024).toFixed(1)} KiB`
  );
  assert.ok(
    largestChunk.bytes <= 145 * 1024,
    `Largest compressed chunk is ${largestChunk.file} at ${(largestChunk.bytes / 1024).toFixed(1)} KiB`
  );
});
