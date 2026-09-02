// Goodreads — the last-resort source, used only by migrate-enrich-goodreads.ts
// for books the other three could not fill. Deliberately NOT wired into the
// app: Goodreads sends no CORS headers (a browser cannot call it at all),
// its Terms of Service disallow automated access, and the markup is
// unversioned. Keeping it in a hand-run backfill confines the fragility and
// the volume to a few dozen requests over the owner's own library.
//
// Requests go to /book/isbn/<isbn>, which redirects to the book page.
// That path is not disallowed by robots.txt, unlike /search.
//
// Data comes from the page's schema.org JSON-LD (stable, machine-intended)
// rather than from scraped markup; only the genre list, which JSON-LD
// omits, is read out of the embedded page state.
const NONFICTION_GENRES = new Set([
  'memoir', 'biography', 'history', 'science', 'self help', 'business',
  'psychology', 'philosophy', 'politics', 'economics', 'travel', 'health',
  'true crime', 'essays', 'autobiography', 'reference', 'religion',
]);

import type { BookLookupResult } from '../interfaces/metadata.ts';

interface GoodreadsBookData {
  name: string;
  authorNames: string[];
  numberOfPages: number | undefined;
  image: string;
}

type Data = Record<string, unknown>;

function isRecord(value: unknown): value is Data {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function goodreadsIsbnUrl(isbn13: string): string {
  return `https://www.goodreads.com/book/isbn/${isbn13}`;
}

export function parseGoodreadsHtml(html: string): BookLookupResult | null {
  const linkedData = extractJsonLd(html);
  if (linkedData === null) return null;
  const genres = extractGenres(html);
  return {
    title: linkedData.name,
    authorNames: linkedData.authorNames,
    pageCount: linkedData.numberOfPages,
    // Goodreads cover images are served from Amazon's CDN over https.
    coverUrl: linkedData.image,
    publisher: '',
    publishedDate: '',
    subjects: genres,
    fiction: deriveFictionFromGenres(genres),
    language: '',
  };
}

function extractJsonLd(html: string): GoodreadsBookData | null {
  const match = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s);
  if (match === null) return null;
  const data: unknown = JSON.parse(match[1]);
  return decodeGoodreadsBookData(data);
}

function decodeGoodreadsBookData(value: unknown): GoodreadsBookData | null {
  if (!isRecord(value)) return null;
  const data = value;
  if (data['@type'] !== 'Book') return null;

  const rawAuthors = Array.isArray(data.author)
    ? data.author
    : data.author === undefined || data.author === null
      ? []
      : [data.author];
  const authorNames = rawAuthors.flatMap((author) => {
    if (!isRecord(author)) return [];
    const name = author.name;
    return typeof name === 'string' ? [name] : [];
  });

  return {
    name: typeof data.name === 'string' ? data.name : '',
    authorNames,
    numberOfPages:
      typeof data.numberOfPages === 'number' &&
        Number.isSafeInteger(data.numberOfPages) && data.numberOfPages > 0
        ? data.numberOfPages
        : undefined,
    image: typeof data.image === 'string' ? data.image : '',
  };
}

// Genres appear in the embedded page state as {"name":X,"webUrl":".../genres/..."}.
export function extractGenres(html: string): string[] {
  return [...new Set(
    [...html.matchAll(/"name":"([^"]{2,40})","webUrl":"https:\/\/www\.goodreads\.com\/genres\//g)]
      .map((match) => match[1])
  )];
}

// Goodreads tags non-fiction explicitly and consistently, so "Nonfiction"
// is a stronger signal here than any topic guess; a plain "Fiction" tag
// settles the other direction. ("Nonfiction" cannot match the \bfiction\b
// test — there is no word boundary inside it.)
export function deriveFictionFromGenres(genres: readonly string[]): boolean | null {
  let sawNonfiction = false;
  for (const genre of genres) {
    const lower = genre.toLowerCase();
    if (/\bnon-?fiction\b/.test(lower)) sawNonfiction = true;
    else if (/\bfiction\b/.test(lower)) return true;
    else if (NONFICTION_GENRES.has(lower)) sawNonfiction = true;
  }
  return sawNonfiction ? false : null;
}
