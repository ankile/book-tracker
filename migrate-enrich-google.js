// Enrichment migration, pass 2: fill the metadata gaps Open Library left
// (migrate-enrich-books.js is pass 1) from Google Books.
//
// Gap-fill only — an existing non-empty value always wins, because pass 1
// wrote it and Open Library is the better source for covers and subject
// lists. Google Books earns its place on the fiction/non-fiction axis: its
// categories are BISAC top-level headings, which classify books Open
// Library's free-form subjects leave unknown. Policy in
// src/lib/utils/googleBooks.js (parseGoogleVolume + mergeMetadata).
//
// Idempotent: a book with no empty fields is never looked up, and a book
// Google Books cannot improve produces an empty patch and no write. Both
// dry-run and apply serve from gb-cache.json, so re-runs cost 0 fetches.
//
// The API key lives in the FUNCTIONS_CONFIG_EXPORT secret (same one the
// booksapi function reads) and must be passed in explicitly:
//
//   export GOOGLE_BOOKS_KEY=$(gcloud secrets versions access latest \
//     --secret=FUNCTIONS_CONFIG_EXPORT --project book-tracker-d8f24 \
//     --account=lars.ankile@gmail.com \
//     | python3 -c "import json,sys;print(json.load(sys.stdin)['booksapi']['key'])")
//
//   node migrate-enrich-google.js                    # emulator dry-run
//   node migrate-enrich-google.js --apply            # emulator apply
//   node migrate-enrich-google.js --prod             # prod dry-run
//   node migrate-enrich-google.js --prod --apply     # prod apply (typed confirm)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseFlags, connect, batcher } from './migrate-lib.js';
import { normalizeIsbn } from './src/lib/utils/isbn.js';
import { EMPTY_METADATA } from './src/lib/utils/bookMetadata.js';
import { parseGoogleVolume, mergeMetadata, GOOGLE_BOOKS_URL } from './src/lib/utils/googleBooks.js';

const KEY = process.env.GOOGLE_BOOKS_KEY;
if (!KEY) throw new Error('GOOGLE_BOOKS_KEY is not set (see the header comment)');

// Google Books tolerates far more throughput than Open Library, but it
// does emit transient 503s (~10% of calls during the 2026-08-24 probe),
// so every request gets a short retry ladder.
const REQUEST_GAP_MS = 500;
const RETRY_GAPS_MS = [2_000, 10_000, 30_000];

const CACHE_PATH = './gb-cache.json';
const cache = existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, 'utf8')) : {};
let fetches = 0;

// country is required: without it Google geolocates the caller and can
// answer 403 for volumes it will happily serve with an explicit market.
async function lookupGoogleBooks(isbn13) {
  if (isbn13 in cache) return cache[isbn13];
  let payload;
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetch(`${GOOGLE_BOOKS_URL}?key=${KEY}&q=isbn:${isbn13}&country=NO`);
    } catch (error) {
      console.log(`RETRY ${isbn13} attempt ${attempt + 1} failed: ${error.cause?.code ?? error.message}`);
      if (attempt === RETRY_GAPS_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_GAPS_MS[attempt]));
      continue;
    }
    if (response.ok) {
      payload = await response.json();
      break;
    }
    // 5xx is transient; a 4xx means the key or query is wrong and no
    // amount of waiting fixes it.
    if (response.status < 500 || attempt === RETRY_GAPS_MS.length) {
      throw new Error(`Google Books ${response.status} for ${isbn13}`);
    }
    console.log(`RETRY ${isbn13} attempt ${attempt + 1} failed: HTTP ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_GAPS_MS[attempt]));
  }
  const volume = payload.items?.[0]?.volumeInfo;
  fetches += 1;
  cache[isbn13] = volume === undefined ? null : parseGoogleVolume(volume);
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 1));
  await new Promise((resolve) => setTimeout(resolve, REQUEST_GAP_MS));
  return cache[isbn13];
}

const flags = parseFlags(process.argv.slice(2));
const { db } = await connect({ ...flags, confirmWrite: flags.apply });
const writes = batcher(db, { apply: flags.apply });

let filled = 0;
let nothingToAdd = 0;
let skippedComplete = 0;

const users = await db.collection('users').get();
for (const user of users.docs) {
  const books = await user.ref.collection('books').get();
  for (const book of books.docs) {
    const b = book.data();

    // Nothing empty means nothing to ask about — the cheap re-run guard.
    const hasGap = Object.keys(EMPTY_METADATA).some((field) => {
      const v = b[field];
      return Array.isArray(v) ? v.length === 0 : v === '' || v === null || v === undefined;
    });
    if (!hasGap) { skippedComplete += 1; continue; }

    const normalized = b.isbn ? normalizeIsbn(b.isbn) : null;
    if (normalized === null) continue; // no usable ISBN; pass 1 already reported it

    const gb = await lookupGoogleBooks(normalized);
    if (gb === null) {
      console.log(`REPORT ${book.ref.path} no Google Books volume for ${normalized}`);
      nothingToAdd += 1;
      continue;
    }

    const patch = mergeMetadata(b, gb);
    if (Object.keys(patch).length === 0) {
      nothingToAdd += 1;
      continue;
    }

    filled += 1;
    const detail = Object.keys(patch).sort().map((f) => (f === 'subjects' ? `subjects=${patch.subjects.length}` : `${f}=${JSON.stringify(patch[f]).slice(0, 40)}`)).join(' ');
    console.log(`${flags.apply ? 'UPDATE' : 'DRY'} ${book.ref.path} "${b.title}" ${detail}`);
    await writes.update(book.ref, patch);
  }
}
await writes.flush();
console.log(`${writes.count()} book updates ${flags.apply ? 'applied' : '(dry run, nothing written)'} — ${filled} improved, ${nothingToAdd} nothing to add, ${skippedComplete} already complete, ${fetches} live fetches`);
