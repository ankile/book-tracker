import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

const chunksDirectory = 'public/_app/immutable';
const javascriptFiles = readdirSync(chunksDirectory, { recursive: true })
  .filter((file): file is string => typeof file === 'string' && file.endsWith('.js'))
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
  // Total raised 261 -> 268 KiB for public profiles: the anonymous
  // /profiles/<username> route, the Me page share card + payload sync, and
  // the profile Database methods (~4 KiB), plus ~3 KiB headroom.
  // Total raised 268 -> 275 KiB for profile handles + the all-time
  // heatmap: nine svelte-awesome icon paths, the links editor/renderer,
  // and the per-year grid stack (~5 KiB), plus ~2 KiB headroom.
  // Total raised 275 -> 290 KiB for the Me-page analytics: the session
  // stats module, hand-rolled bar/line chart primitives, and six section
  // components (speed, clock, cadence, in-progress, authors, records,
  // ~7 KiB), plus headroom.
  // Total raised 290 -> 292 KiB for signed-in app prefetch: the idle
  // lifecycle and dynamic prefetch entry add just under 1 KiB.
  // Total raised 292 -> 298 KiB for the strict TypeScript boundary work:
  // Firestore/API runtime decoders and explicit uncertain Toggl lifecycle
  // UI add 5.3 KiB compressed. These checks are executable validation,
  // not erased type annotations, so the transfer cost is intentional.
  // Total raised 298 -> 299 KiB for runtime validation of the server-owned
  // Toggl queue expiry field. The check adds under 0.1 KiB; the one-byte
  // headroom at 298 KiB could not accommodate a new persisted field safely.
  // Total raised 299 -> 303 KiB for the reviewed correctness fixes that keep
  // corrupt author/admin records repairable, surface authentication failures,
  // preserve offline reading writes, and serialize timer lifecycle claims.
  // A build at the prior budget-setting commit measures 298.0 KiB; the timer
  // claim work itself adds under 1 KiB and the complete reviewed set adds 3.9 KiB.
  // Total raised 303 -> 305 KiB for profile search opt-in: the owner-only
  // marker listener/decoder, two atomic write paths, and the Me-page switch
  // add 0.3 KiB compressed, with the remainder retained as explicit headroom.
  // Total raised 305 -> 306 KiB for the explicit finishedAt: the stamp on
  // every finishing write path and the finished list/stats reading it
  // land 51 bytes over the old cap.
  assert.ok(
    totalBytes <= 306 * 1024,
    `Expected at most 306 KiB of compressed JavaScript, received ${(totalBytes / 1024).toFixed(1)} KiB`
  );
  assert.ok(
    largestChunk.bytes <= 170 * 1024,
    `Largest compressed chunk is ${largestChunk.file} at ${(largestChunk.bytes / 1024).toFixed(1)} KiB`
  );
});
