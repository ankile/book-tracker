// Google Books volume parsing, the secondary metadata source. Open Library
// stays primary (richer subject lists, stable cover URLs); Google Books
// fills what it left empty — see mergeMetadata below.
//
// Its value over Open Library is the fiction/non-fiction axis: categories
// are BISAC top-level headings ("Business & Economics", "Science"), which
// classify a book even when Open Library's free-form subjects don't.
import type { BookLookupResult, BookMetadata, BookMetadataPatch } from '../interfaces/metadata.ts';
import { METADATA_FIELDS } from './bookMetadata.ts';

export const GOOGLE_BOOKS_URL = 'https://books.googleapis.com/books/v1/volumes';

// BISAC top-level headings that are non-fiction. A category outside this
// list and not matching the fiction test leaves the verdict unknown rather
// than guessing — Google occasionally emits odd values ("Texas").
const NONFICTION_CATEGORIES = new Set([
  'antiques & collectibles', 'architecture', 'art', 'bibles',
  'biography', 'biography & autobiography', 'body, mind & spirit',
  'business & economics', 'computers', 'cooking', 'crafts & hobbies',
  'design', 'education', 'family & relationships', 'games & activities',
  'gardening', 'health & fitness', 'history', 'house & home', 'humor',
  'language arts & disciplines', 'law', 'literary criticism',
  'mathematics', 'medical', 'music', 'nature', 'performing arts', 'pets',
  'philosophy', 'photography', 'political science', 'psychology',
  'reference', 'religion', 'science', 'self-help', 'social science',
  'sports & recreation', 'study aids', 'technology & engineering',
  'transportation', 'travel', 'true crime',
]);

// Returns the metadata fields Google Books can answer, plus title/authors/
// pageCount for the modal. Fields it has nothing for come back empty, so a
// caller can merge without special-casing absence.
export interface GoogleVolume {
  title?: string;
  authors?: string[];
  publisher?: string;
  publishedDate?: string;
  pageCount?: number;
  categories?: string[];
  imageLinks?: { thumbnail?: string };
}

type Data = Record<string, unknown>;

function isRecord(value: unknown): value is Data {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown): Data {
  if (!isRecord(value)) {
    throw new TypeError('Google Books volume must be an object.');
  }
  return value;
}

function optionalRecord(value: unknown): Data | undefined {
  return isRecord(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalPageCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export function parseGoogleVolume(value: unknown): BookLookupResult {
  const volume = requireRecord(value);
  const categories = strings(volume.categories).map((category) => category.trim()).filter((category) => category !== '');
  const imageLinks = optionalRecord(volume.imageLinks);
  return {
    title: optionalString(volume.title) ?? '',
    authorNames: strings(volume.authors),
    pageCount: optionalPageCount(volume.pageCount),
    // Google serves some thumbnails over http; force https or the browser
    // blocks them as mixed content on the deployed site.
    coverUrl: (optionalString(imageLinks?.thumbnail) ?? '').replace(/^http:/, 'https:'),
    publisher: optionalString(volume.publisher) ?? '',
    publishedDate: optionalString(volume.publishedDate) ?? '',
    subjects: categories,
    fiction: deriveFictionFromCategories(categories),
  };
}

// "Fiction", "Juvenile Fiction", "Fiction / Fantasy / Epic" -> true;
// a known non-fiction heading -> false; anything else -> null (unknown).
export function deriveFictionFromCategories(categories: readonly string[]): boolean | null {
  let sawNonfiction = false;
  for (const category of categories) {
    const lower = category.toLowerCase();
    if (/\bfiction\b/.test(lower) && !lower.includes('nonfiction') && !lower.includes('non-fiction')) {
      return true;
    }
    // Sub-headings arrive slash-joined; the top-level part is the verdict.
    if (NONFICTION_CATEGORIES.has(lower.split('/')[0].trim())) sawNonfiction = true;
  }
  return sawNonfiction ? false : null;
}

// Gap-fill only: an existing non-empty value always wins, because Open
// Library wrote it and it is the better source for that field. Returns the
// patch (changed fields only), so an all-empty result means nothing to do.
export function mergeMetadata(
  existing: BookMetadata,
  incoming: BookMetadata,
): BookMetadataPatch {
  const patch: BookMetadataPatch = {};
  for (const field of METADATA_FIELDS) {
    const current = existing[field];
    const filled = Array.isArray(current) ? current.length > 0 : current !== '' && current !== null && current !== undefined;
    if (filled) continue;
    const next = incoming[field];
    const hasValue = Array.isArray(next) ? next.length > 0 : next !== '' && next !== null && next !== undefined;
    if (hasValue) setMetadataField(patch, field, next);
  }
  return patch;
}

function setMetadataField<K extends keyof BookMetadata>(
  target: BookMetadataPatch,
  field: K,
  value: BookMetadata[K],
): void {
  target[field] = value;
}
