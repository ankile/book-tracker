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

  // Budgets raised 230/145 -> 255/170 KiB when Firestore offline persistence
  // (persistentLocalCache) was enabled; it adds ~16 KiB to the Firestore chunk.
  // Total raised 255 -> 258 KiB for the authors entity (autocomplete
  // component + name utilities, ~1 KiB) — the old budget had <1 KiB headroom.
  // Total raised 258 -> 261 KiB for id-only author refs: the chips input
  // and client-side join fit inside the old budget (the legacy write path
  // they replaced paid for them), the ~2 KiB is the /authors management
  // route (rename/merge/sortName) and its author mutations.
  assert.ok(
    totalBytes <= 261 * 1024,
    `Expected at most 261 KiB of compressed JavaScript, received ${(totalBytes / 1024).toFixed(1)} KiB`
  );
  assert.ok(
    largestChunk.bytes <= 170 * 1024,
    `Largest compressed chunk is ${largestChunk.file} at ${(largestChunk.bytes / 1024).toFixed(1)} KiB`
  );
});
