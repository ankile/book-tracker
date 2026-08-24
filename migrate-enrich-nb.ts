// Enrichment migration, pass 3: fill remaining gaps from Nasjonalbiblioteket
// (passes 1 and 2 are Open Library and Google Books).
//
// This is the pass that knows Norwegian books. Its catalogue records carry
// MODS genres — "Romaner", "Skuespill", and the explicit "notfiction"
// marker — which classify titles the other two sources have never heard
// of. Policy lives in src/lib/utils/nasjonalbiblioteket.ts.
//
// Gap-fill only, same rule as pass 2: an existing value always wins.
// Covers are special-cased — the scanned cover of an in-copyright book is
// restricted, so the candidate URL is verified with a HEAD request before
// it is ever stored. Storing a 403 would render as a broken image.
//
// Free and key-less, but a public good: requests are paced and identified.
//
//   node migrate-enrich-nb.ts                    # emulator dry-run
//   node migrate-enrich-nb.ts --apply            # emulator apply
//   node migrate-enrich-nb.ts --prod             # prod dry-run
//   node migrate-enrich-nb.ts --prod --apply     # prod apply (typed confirm)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseFlags, connect, batcher } from './migrate-lib.ts';
import { normalizeIsbn } from './src/lib/utils/isbn.ts';
import { EMPTY_METADATA, METADATA_FIELDS } from './src/lib/utils/bookMetadata.ts';
import { mergeMetadata } from './src/lib/utils/googleBooks.ts';
import {
  nbSearchUrl,
  nbModsUrl,
  nbCoverCandidate,
  parseNbItem,
  extractModsGenres,
} from './src/lib/utils/nasjonalbiblioteket.ts';
import type { BookLookupResult, BookMetadataPatch } from './src/lib/interfaces/metadata.ts';
import { nbSearchItem } from './migration-api-envelopes.ts';

const USER_AGENT = 'book-tracker enrichment script (https://book.ankile.com)';
const REQUEST_GAP_MS = 1000;

const CACHE_PATH = './nb-cache.json';
const cache: Record<string, BookLookupResult | null> = existsSync(CACHE_PATH)
  ? JSON.parse(readFileSync(CACHE_PATH, 'utf8'))
  : {};
let fetches = 0;

const get = (url: string): Promise<Response> => (
  fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } })
);

async function lookupNb(isbn13: string): Promise<BookLookupResult | null> {
  if (isbn13 in cache) return cache[isbn13];

  const response = await get(nbSearchUrl(isbn13));
  if (!response.ok) throw new Error(`Nasjonalbiblioteket ${response.status} for ${isbn13}`);
  const payload: unknown = await response.json();
  const item = nbSearchItem(payload);
  fetches += 1;

  let parsed: BookLookupResult | null = null;
  if (item !== undefined) {
    // Genres live in the MODS record, not the JSON summary.
    const modsResponse = await get(nbModsUrl(item.id));
    if (!modsResponse.ok) throw new Error(`Nasjonalbiblioteket MODS ${modsResponse.status} for ${isbn13}`);
    const raw = parseNbItem(item.record, extractModsGenres(await modsResponse.text()));

    // Verify the scanned cover before trusting it: restricted for
    // in-copyright titles, which is most of them.
    const candidate = nbCoverCandidate(raw.urn);
    const { urn: _urn, ...metadata } = raw;
    parsed = metadata;
    if (candidate !== '') {
      const head = await fetch(candidate, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT } });
      if (head.ok) parsed.coverUrl = candidate;
    }
  }

  cache[isbn13] = parsed;
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 1));
  await new Promise((resolve) => setTimeout(resolve, REQUEST_GAP_MS));
  return parsed;
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
    if (normalized === null) continue; // no usable ISBN; pass 1 reported it

    const nb = await lookupNb(normalized);
    if (nb === null) {
      console.log(`REPORT ${book.ref.path} not in Nasjonalbiblioteket: ${normalized}`);
      nothingToAdd += 1;
      continue;
    }

    const patch = mergeMetadata({
      coverUrl: b.coverUrl,
      publisher: b.publisher,
      publishedDate: b.publishedDate,
      subjects: b.subjects,
      fiction: b.fiction,
    }, nb);
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
