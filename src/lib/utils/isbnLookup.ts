import type { BookLookupResult } from '../interfaces/metadata.ts';
import { parseOpenLibraryBook } from './bookMetadata.ts';
import { parseGoogleVolume } from './googleBooks.ts';
import {
  extractModsCoverUrl,
  extractModsGenres,
  extractModsLanguage,
  nbModsUrl,
  nbSearchUrl,
  parseNbItem,
} from './nasjonalbiblioteket.ts';

// The three ISBN sources the add-book form and the catalog console ask,
// each answering what it knows or null: Open Library (open, from the
// browser), the national library (open, from the browser; its genres,
// language and any public cover live in a second MODS request), and
// Google Books (through a callable that holds the metered key, passed in
// so this module owns no Firebase). The sources' field precedence is
// selectLookupMetadata's business.
export interface IsbnSources {
  openLibrary: BookLookupResult | null;
  google: BookLookupResult | null;
  nb: BookLookupResult | null;
}

export interface IsbnLookupDeps {
  google: (isbn13: string) => Promise<{ volume: unknown }>;
  fetch?: typeof fetch;
}

type Data = Record<string, unknown>;

function requireRecord(value: unknown, context: string): Data {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${context} must be an object.`);
  }
  return value as Data;
}

function optionalRecord(value: unknown): Data | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Data) : undefined;
}

export async function fetchOpenLibrary(isbn13: string, fetchImpl: typeof fetch): Promise<BookLookupResult | null> {
  const response = await fetchImpl(
    `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn13}&format=json&jscmd=data`,
  );
  if (!response.ok) throw new Error('Network error');
  const data = requireRecord(await response.json(), 'Open Library response');
  const record = data[`ISBN:${isbn13}`];
  return record === undefined ? null : parseOpenLibraryBook(record);
}

// A failure here degrades to "no answer" rather than throwing: the other
// sources' answers are still worth having.
export async function fetchNasjonalbiblioteket(isbn13: string, fetchImpl: typeof fetch): Promise<BookLookupResult | null> {
  try {
    const response = await fetchImpl(nbSearchUrl(isbn13));
    if (!response.ok) throw new Error(`Nasjonalbiblioteket ${response.status}`);
    const body = requireRecord(await response.json(), 'Nasjonalbiblioteket response');
    const embedded = optionalRecord(body._embedded);
    const items = embedded?.items;
    const item = Array.isArray(items) ? items[0] : undefined;
    if (item === undefined) return null;
    const itemData = requireRecord(item, 'Nasjonalbiblioteket item');
    if (typeof itemData.id !== 'string') throw new Error('Nasjonalbiblioteket item id must be a string.');
    const mods = await fetchImpl(nbModsUrl(itemData.id));
    if (!mods.ok) throw new Error(`Nasjonalbiblioteket MODS ${mods.status}`);
    const modsXml = await mods.text();
    const parsed = parseNbItem(
      item,
      extractModsGenres(modsXml),
      extractModsCoverUrl(modsXml),
      extractModsLanguage(modsXml),
    );
    return {
      title: parsed.title,
      authorNames: parsed.authorNames,
      pageCount: parsed.pageCount,
      coverUrl: parsed.coverUrl,
      publisher: parsed.publisher,
      publishedDate: parsed.publishedDate,
      subjects: parsed.subjects,
      fiction: parsed.fiction,
      language: parsed.language,
    };
  } catch (error) {
    console.error('Nasjonalbiblioteket lookup failed', error);
    return null;
  }
}

export async function fetchGoogleBooks(isbn13: string, google: IsbnLookupDeps['google']): Promise<BookLookupResult | null> {
  try {
    const { volume } = await google(isbn13);
    return volume === null ? null : parseGoogleVolume(volume);
  } catch (error) {
    console.error('Google Books lookup failed', error);
    return null;
  }
}

export async function lookupIsbnSources(isbn13: string, deps: IsbnLookupDeps): Promise<IsbnSources> {
  const fetchImpl = deps.fetch ?? fetch;
  const openLibrary = await fetchOpenLibrary(isbn13, fetchImpl);
  const google = await fetchGoogleBooks(isbn13, deps.google);
  const nb = await fetchNasjonalbiblioteket(isbn13, fetchImpl);
  return { openLibrary, google, nb };
}

// The source the title, authors and first page count come from: Open
// Library when it answered, else Google, else the national library.
export function primaryLookup(sources: IsbnSources): BookLookupResult | null {
  return sources.openLibrary ?? sources.google ?? sources.nb;
}
