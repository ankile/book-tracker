// Enrichment migration: backfill the ISBN-derived metadata fields
// (coverUrl, publisher, publishedDate, subjects, fiction — shapes in
// src/lib/utils/bookMetadata.ts) on every book doc, looking each stored
// ISBN up in Open Library. Books whose ISBN is empty, invalid, or unknown
// to Open Library get the empty defaults, so the fields are uniformly
// present afterward; misses are REPORTed for a human pass. A valid ISBN
// stored in a non-canonical form (ISBN-10, hyphens) is rewritten as the
// bare ISBN-13 in the same patch.
//
// Idempotent: guarded on any metadata field being absent, so a re-run
// after a clean pass performs 0 fetches and 0 writes. This script — not
// migrate-normalize-books.ts — owns these fields' defaults: if normalize
// ever backfilled them first, the guard here would see a complete schema
// and skip the actual enrichment.
//
// Dry runs fetch for real so every line previews the actual values.
//
//   node migrate-enrich-books.ts                    # emulator dry-run
//   node migrate-enrich-books.ts --apply            # emulator apply
//   node migrate-enrich-books.ts --prod             # prod dry-run
//   node migrate-enrich-books.ts --prod --apply     # prod apply (typed confirm)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseFlags, connect, batcher } from './migrate-lib.ts';
import { normalizeIsbn } from './src/lib/utils/isbn.ts';
import {
  parseOpenLibraryBook,
  EMPTY_METADATA,
  METADATA_FIELDS,
} from './src/lib/utils/bookMetadata.ts';
import type { BookLookupResult, BookMetadata } from './src/lib/interfaces/metadata.ts';
import { openLibraryRecord } from './migration-api-envelopes.ts';

// Open Library asks polite bulk users to identify themselves.
const USER_AGENT = 'book-tracker enrichment script (https://book.ankile.com)';
// Rehearsal 2026-08-23: 220 requests at a 600ms gap followed by a second
// pass got the IP soft-blocked (resets/timeouts) for the better part of an
// hour. This is a background trickle, not an interactive tool, so pace it
// like one — 2 requests/minute clears the whole library in ~2h — and back
// off in escalating steps sized to ride a block out. Each retry is logged
// so nothing fails silently; exhausting the waits on one ISBN still
// crashes the run, and a re-run resumes from the cache.
const REQUEST_GAP_MS = 30_000;
const RETRY_GAPS_MS = [60_000, 300_000, 900_000];

// Lookup results (parsed metadata, or null for an ISBN Open Library
// doesn't know) persist in ol-cache.json across runs, so the dry-run,
// apply, and prod passes fetch each ISBN once between them. A cached miss
// is never re-asked — delete the file to force a fresh sweep.
const CACHE_PATH = './ol-cache.json';
const cache: Record<string, BookLookupResult | null> = existsSync(CACHE_PATH)
  ? JSON.parse(readFileSync(CACHE_PATH, 'utf8'))
  : {};
let fetches = 0;

async function lookupOpenLibrary(isbn13: string): Promise<BookLookupResult | null> {
  if (isbn13 in cache) return cache[isbn13];
  let response: Response;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await fetch(
        `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn13}&format=json&jscmd=data`,
        { headers: { 'User-Agent': USER_AGENT } }
      );
      break;
    } catch (error) {
      const fetchError = error as Error & { cause?: { code?: string } };
      console.log(`RETRY ${isbn13} attempt ${attempt + 1} failed: ${fetchError.cause?.code ?? fetchError.message}`);
      if (attempt === RETRY_GAPS_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_GAPS_MS[attempt]));
    }
  }
  if (!response.ok) throw new Error(`Open Library ${response.status} for ${isbn13}`);
  const payload: unknown = await response.json();
  const record = openLibraryRecord(payload, isbn13);
  fetches += 1;
  cache[isbn13] = record === undefined ? null : parseOpenLibraryBook(record);
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 1));
  await new Promise((resolve) => setTimeout(resolve, REQUEST_GAP_MS));
  return cache[isbn13];
}

const flags = parseFlags(process.argv.slice(2));
const { db } = await connect({ ...flags, confirmWrite: flags.apply });
const writes = batcher(db, { apply: flags.apply });

let enriched = 0;
let defaulted = 0;

const users = await db.collection('users').get();
for (const user of users.docs) {
  const books = await user.ref.collection('books').get();
  for (const book of books.docs) {
    const b = book.data();
    if (METADATA_FIELDS.every((field) => b[field] !== undefined)) continue;

    const normalized = b.isbn ? normalizeIsbn(b.isbn) : null;
    if (b.isbn && normalized === null) {
      console.log(`REPORT ${book.ref.path} isbn "${b.isbn}" is not a valid ISBN — defaults only`);
    }

    let meta = null;
    if (normalized !== null) {
      meta = await lookupOpenLibrary(normalized);
      if (meta === null) console.log(`REPORT ${book.ref.path} no Open Library record for ${normalized}`);
    }

    const patch: Partial<BookMetadata> & { isbn?: string } = {};
    for (const field of METADATA_FIELDS) {
      if (b[field] === undefined) {
        setMetadataField(patch, field, meta ? meta[field] : EMPTY_METADATA[field]);
      }
    }
    if (normalized !== null && normalized !== b.isbn) patch.isbn = normalized;

    if (meta) enriched += 1;
    else defaulted += 1;
    const label = meta ? `"${b.title}" fiction=${meta.fiction} cover=${meta.coverUrl !== '' ? 'yes' : 'no'} subjects=${meta.subjects.length}` : `"${b.title}" defaults`;
    console.log(`${flags.apply ? 'UPDATE' : 'DRY'} ${book.ref.path} ${Object.keys(patch).sort().join(',')} ${label}`);
    await writes.update(book.ref, patch);
    // The default batcher only commits every 500 ops; flushing every 25
    // keeps the fetch work done so far if a later lookup crashes the run
    // (the missing-fields guard makes the re-run resume past it).
    if (writes.count() % 25 === 0) await writes.flush();
  }
}
await writes.flush();
console.log(`${writes.count()} book updates ${flags.apply ? 'applied' : '(dry run, nothing written)'} — ${enriched} enriched, ${defaulted} defaults-only, ${fetches} live fetches`);

function setMetadataField<K extends keyof BookMetadata>(
  target: Partial<BookMetadata>,
  field: K,
  value: BookMetadata[K],
): void {
  target[field] = value;
}
