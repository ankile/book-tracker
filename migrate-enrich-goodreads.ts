// Enrichment migration, pass 4 and last resort: fill whatever passes 1-3
// (Open Library, Google Books, Nasjonalbiblioteket) could not, from
// Goodreads book pages.
//
// Read the tradeoff before running this. Goodreads retired its API in
// December 2020 and its Terms of Service disallow automated access, so
// this is a deliberate, hand-run exception rather than infrastructure:
//   - it is NOT wired into the app, and never should be (no CORS headers,
//     so a browser cannot call it regardless);
//   - it runs only over books the three open sources left empty, which is
//     a few dozen requests across the whole library;
//   - it requests /book/isbn/<isbn>, which robots.txt permits, and NOT
//     /search, which robots.txt disallows;
//   - it identifies itself, waits REQUEST_GAP_MS between requests, and
//     stops the run on the first sign of blocking rather than hammering;
//   - results are cached, so a re-run costs zero requests.
// Data is read from the page's schema.org JSON-LD, which is far more
// stable than the surrounding markup, plus the genre list.
//
//   node migrate-enrich-goodreads.ts                    # emulator dry-run
//   node migrate-enrich-goodreads.ts --apply            # emulator apply
//   node migrate-enrich-goodreads.ts --prod             # prod dry-run
//   node migrate-enrich-goodreads.ts --prod --apply     # prod apply (typed confirm)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseFlags, connect, batcher } from './migrate-lib.ts';
import { normalizeIsbn } from './src/lib/utils/isbn.ts';
import { EMPTY_METADATA, METADATA_FIELDS } from './src/lib/utils/bookMetadata.ts';
import { mergeMetadata } from './src/lib/utils/googleBooks.ts';
import { goodreadsIsbnUrl, parseGoodreadsHtml } from './src/lib/utils/goodreads.ts';
import type { BookLookupResult, BookMetadataPatch } from './src/lib/interfaces/metadata.ts';
import { bookLookupCache } from './migration-api-envelopes.ts';

// A real browser UA: Goodreads serves a JS shell to unknown agents, and
// the JSON-LD this reads would be absent. The contact URL is the honest
// part — it says who is asking and where to complain.
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 (+https://book.ankile.com personal library backfill)';
const REQUEST_GAP_MS = 5000;

const CACHE_PATH = './gr-cache.json';
const cache: Record<string, BookLookupResult | null> = existsSync(CACHE_PATH)
  ? bookLookupCache(JSON.parse(readFileSync(CACHE_PATH, 'utf8')), CACHE_PATH)
  : {};
let fetches = 0;

async function lookupGoodreads(isbn13: string): Promise<BookLookupResult | null> {
  if (isbn13 in cache) return cache[isbn13];

  const response = await fetch(goodreadsIsbnUrl(isbn13), {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    redirect: 'follow',
  });

  // 404 is a normal answer (no such book); 403/429 mean we are being told
  // to stop, and the run ends there rather than retrying into a ban.
  if (response.status === 404) {
    cache[isbn13] = null;
    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 1));
    return null;
  }
  if (response.status === 403 || response.status === 429) {
    throw new Error(`Goodreads answered ${response.status} — stopping. Re-run later; ${Object.keys(cache).length} lookups are cached.`);
  }
  if (!response.ok) throw new Error(`Goodreads ${response.status} for ${isbn13}`);

  fetches += 1;
  cache[isbn13] = parseGoodreadsHtml(await response.text());
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

    const hasGap = Object.keys(EMPTY_METADATA).some((field) => {
      const v = b[field];
      return Array.isArray(v) ? v.length === 0 : v === '' || v === null || v === undefined;
    });
    if (!hasGap) { skippedComplete += 1; continue; }

    const normalized = b.isbn ? normalizeIsbn(b.isbn) : null;
    if (normalized === null) continue;

    const gr = await lookupGoodreads(normalized);
    if (gr === null) {
      console.log(`REPORT ${book.ref.path} no Goodreads book for ${normalized}`);
      nothingToAdd += 1;
      continue;
    }

    const patch = mergeMetadata({
      coverUrl: b.coverUrl,
      publisher: b.publisher,
      publishedDate: b.publishedDate,
      subjects: b.subjects,
      fiction: b.fiction,
    }, gr);
    if (Object.keys(patch).length === 0) {
      nothingToAdd += 1;
      continue;
    }

    filled += 1;
    const detail = formatMetadataPatch(patch);
    console.log(`${flags.apply ? 'UPDATE' : 'DRY'} ${book.ref.path} "${b.title}" ${detail}`);
    await writes.update(book.ref, patch);
  }
}
await writes.flush();
console.log(`${writes.count()} book updates ${flags.apply ? 'applied' : '(dry run, nothing written)'} — ${filled} improved, ${nothingToAdd} nothing to add, ${skippedComplete} already complete, ${fetches} live lookups`);

function formatMetadataPatch(patch: BookMetadataPatch): string {
  return METADATA_FIELDS
    .filter((field) => patch[field] !== undefined)
    .toSorted()
    .map((field) => {
      if (field === 'subjects') return `subjects=${patch.subjects?.length ?? 0}`;
      return `${field}=${JSON.stringify(patch[field])!.slice(0, 40)}`;
    })
    .join(' ');
}
