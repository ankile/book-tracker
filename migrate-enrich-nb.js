// Enrichment migration, pass 3: fill remaining gaps from Nasjonalbiblioteket
// (passes 1 and 2 are Open Library and Google Books).
//
// This is the pass that knows Norwegian books. Its catalogue records carry
// MODS genres — "Romaner", "Skuespill", and the explicit "notfiction"
// marker — which classify titles the other two sources have never heard
// of. Policy lives in src/lib/utils/nasjonalbiblioteket.js.
//
// Gap-fill only, same rule as pass 2: an existing value always wins.
// Covers are special-cased — the scanned cover of an in-copyright book is
// restricted, so the candidate URL is verified with a HEAD request before
// it is ever stored. Storing a 403 would render as a broken image.
//
// Free and key-less, but a public good: requests are paced and identified.
//
//   node migrate-enrich-nb.js                    # emulator dry-run
//   node migrate-enrich-nb.js --apply            # emulator apply
//   node migrate-enrich-nb.js --prod             # prod dry-run
//   node migrate-enrich-nb.js --prod --apply     # prod apply (typed confirm)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseFlags, connect, batcher } from './migrate-lib.js';
import { normalizeIsbn } from './src/lib/utils/isbn.js';
import { EMPTY_METADATA } from './src/lib/utils/bookMetadata.js';
import { mergeMetadata } from './src/lib/utils/googleBooks.js';
import { nbSearchUrl, nbModsUrl, nbCoverCandidate, parseNbItem, extractModsGenres } from './src/lib/utils/nasjonalbiblioteket.js';

const USER_AGENT = 'book-tracker enrichment script (https://book.ankile.com)';
const REQUEST_GAP_MS = 1000;

const CACHE_PATH = './nb-cache.json';
const cache = existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, 'utf8')) : {};
let fetches = 0;

const get = (url) => fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });

async function lookupNb(isbn13) {
  if (isbn13 in cache) return cache[isbn13];

  const response = await get(nbSearchUrl(isbn13));
  if (!response.ok) throw new Error(`Nasjonalbiblioteket ${response.status} for ${isbn13}`);
  const item = (await response.json())._embedded?.items?.[0];
  fetches += 1;

  let parsed = null;
  if (item !== undefined) {
    // Genres live in the MODS record, not the JSON summary.
    const modsResponse = await get(nbModsUrl(item.id));
    if (!modsResponse.ok) throw new Error(`Nasjonalbiblioteket MODS ${modsResponse.status} for ${isbn13}`);
    parsed = parseNbItem(item, extractModsGenres(await modsResponse.text()));

    // Verify the scanned cover before trusting it: restricted for
    // in-copyright titles, which is most of them.
    const candidate = nbCoverCandidate(parsed.urn);
    if (candidate !== '') {
      const head = await fetch(candidate, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT } });
      if (head.ok) parsed.coverUrl = candidate;
    }
    delete parsed.urn;
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

    const patch = mergeMetadata(b, nb);
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
console.log(`${writes.count()} book updates ${flags.apply ? 'applied' : '(dry run, nothing written)'} — ${filled} improved, ${nothingToAdd} nothing to add, ${skippedComplete} already complete, ${fetches} live lookups`);
