// Google Books volume parsing, the secondary metadata source. Open Library
// stays primary (richer subject lists, stable cover URLs); Google Books
// fills what it left empty — see mergeMetadata below.
//
// Its value over Open Library is the fiction/non-fiction axis: categories
// are BISAC top-level headings ("Business & Economics", "Science"), which
// classify a book even when Open Library's free-form subjects don't.
import { EMPTY_METADATA } from './bookMetadata.js';

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
export function parseGoogleVolume(volume) {
  const categories = (volume.categories ?? []).map((c) => c.trim()).filter((c) => c !== '');
  return {
    title: volume.title ?? '',
    authorNames: volume.authors ?? [],
    pageCount: volume.pageCount,
    // Google serves some thumbnails over http; force https or the browser
    // blocks them as mixed content on the deployed site.
    coverUrl: (volume.imageLinks?.thumbnail ?? '').replace(/^http:/, 'https:'),
    publisher: volume.publisher ?? '',
    publishedDate: volume.publishedDate ?? '',
    subjects: categories,
    fiction: deriveFictionFromCategories(categories),
  };
}

// "Fiction", "Juvenile Fiction", "Fiction / Fantasy / Epic" -> true;
// a known non-fiction heading -> false; anything else -> null (unknown).
export function deriveFictionFromCategories(categories) {
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
export function mergeMetadata(existing, incoming) {
  const patch = {};
  for (const field of Object.keys(EMPTY_METADATA)) {
    const current = existing[field];
    const filled = Array.isArray(current) ? current.length > 0 : current !== '' && current !== null && current !== undefined;
    if (filled) continue;
    const next = incoming[field];
    const hasValue = Array.isArray(next) ? next.length > 0 : next !== '' && next !== null && next !== undefined;
    if (hasValue) patch[field] = next;
  }
  return patch;
}
