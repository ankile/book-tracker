import type { BookLookupResult } from '../interfaces/metadata.ts';

// Nasjonalbiblioteket (api.nb.no) — the third metadata source, and the
// only one that reliably knows Norwegian editions. Free, no API key, and
// it reflects CORS origins, so the browser can call it directly.
//
// It answers the fiction/non-fiction question for Norwegian books that
// Open Library and Google Books draw a blank on: catalogue records carry
// MODS genres like "Romaner" (novels) and the explicit marker "notfiction".
// The catalogue's MODS record sometimes includes a public cover supplied by
// Bokbasen. Restricted Nasjonalbiblioteket scans remain separate and must be
// verified before a migration stores them.
export const NB_SEARCH_URL = 'https://api.nb.no/catalog/v1/items';

// Cataloguing tokens that describe the record rather than the work, and
// so are noise as subject labels.
const GENRE_STOPWORDS = new Set(['tekst', 'text', 'bibliography', 'fiction', 'notfiction', 'novel', 'biography', 'drama', 'poem']);

const FICTION_GENRES = /^(novel|fiction|roman|romaner|noveller|fortellinger|eventyr|dikt|lyrikk|poem|drama|skuespill|tegneserier)$/i;
const NONFICTION_GENRES = /^(notfiction|biography|biografier|selvbiografier|memoarer|lover|fagb[oø]ker|sakprosa|essays?|leksika|l[æa]reb[oø]ker)$/i;

export function nbSearchUrl(isbn13: string): string {
  return `${NB_SEARCH_URL}?q=${isbn13}&size=1`;
}

export function nbModsUrl(itemId: string): string {
  return `https://api.nb.no/catalog/v1/metadata/${itemId}/mods`;
}

// The scanned cover page of a digitised book. Restricted for in-copyright
// titles (403), so callers must verify before storing — nbCoverCandidate
// only builds the URL.
export function nbCoverCandidate(urn: string): string {
  return urn ? `https://www.nb.no/services/image/resolver/${urn}_C1/full/0,400/0/native.jpg` : '';
}

// MODS genres come from a separate request; pass [] when not fetched.
export interface NbItem {
  metadata?: {
    title?: string;
    creators?: string[];
    pageCount?: number;
    originInfo?: { publisher?: string; issued?: string };
    identifiers?: { urn?: string };
  };
}

export interface NbBookLookupResult extends BookLookupResult {
  urn: string;
}

type Data = Record<string, unknown>;

function isRecord(value: unknown): value is Data {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown): Data {
  if (!isRecord(value)) {
    throw new TypeError('Nasjonalbiblioteket item must be an object.');
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

export function parseNbItem(
  item: unknown,
  genres: unknown = [],
  publicCoverUrl: string = '',
): NbBookLookupResult {
  const data = requireRecord(item);
  const md = optionalRecord(data.metadata) ?? {};
  const originInfo = optionalRecord(md.originInfo);
  const identifiers = optionalRecord(md.identifiers);
  const validGenres = strings(genres);
  const subjects = [...new Set(
    validGenres.map((genre) => genre.trim()).filter((genre) => genre !== '' && !GENRE_STOPWORDS.has(genre.toLowerCase()))
  )];
  return {
    title: optionalString(md.title) ?? '',
    authorNames: strings(md.creators).map(flipCatalogueName),
    pageCount: optionalPageCount(md.pageCount),
    coverUrl: publicCoverUrl,
    publisher: optionalString(originInfo?.publisher) ?? '',
    publishedDate: optionalString(originInfo?.issued) ?? '',
    subjects,
    fiction: deriveFictionFromNbGenres(validGenres),
    urn: optionalString(identifiers?.urn) ?? '',
  };
}

// Catalogue form is "Hamsun, Knut"; the app stores display order.
export function flipCatalogueName(name: string): string {
  const parts = name.split(',');
  if (parts.length !== 2) return name.trim();
  return `${parts[1].trim()} ${parts[0].trim()}`.trim();
}

// A fiction genre wins outright: records routinely carry both a content
// genre ("novel") and a form note ("bibliography"), and only the former
// says what the book is.
export function deriveFictionFromNbGenres(genres: readonly string[]): boolean | null {
  let sawNonfiction = false;
  for (const genre of genres) {
    const value = genre.trim();
    if (FICTION_GENRES.test(value)) return true;
    if (NONFICTION_GENRES.test(value)) sawNonfiction = true;
  }
  return sawNonfiction ? false : null;
}

// MODS is XML; only the genre elements are needed, and a regex over them
// avoids pulling an XML parser into the browser bundle for one field.
export function extractModsGenres(modsXml: string): string[] {
  return [...new Set(
    [...modsXml.matchAll(/<(?:[a-zA-Z]+:)?genre[^>]*>([^<]*)<\/(?:[a-zA-Z]+:)?genre>/g)]
      .map((match) => match[1].trim())
      .filter((genre) => genre !== '')
  )];
}

const PUBLIC_COVER_HOSTS = new Set([
  'media.aja.bs.no',
  'contents.bibs.aws.unit.no',
]);

// MODS also contains full-text links, thumbnails, and restricted NB scans.
// Accept only an explicit cover label from the catalog's public image hosts.
export function extractModsCoverUrl(modsXml: string): string {
  const urlElements = modsXml.matchAll(
    /<(?:[a-zA-Z]+:)?url\b([^>]*)>([^<]*)<\/(?:[a-zA-Z]+:)?url>/g,
  );
  for (const match of urlElements) {
    const attributes = match[1];
    if (!/\bdisplayLabel\s*=\s*(["'])Omslagsbilde\1/i.test(attributes)) continue;

    const value = match[2].trim().replaceAll('&amp;', '&');
    if (!URL.canParse(value)) continue;
    const url = new URL(value);
    if (url.protocol === 'https:' && PUBLIC_COVER_HOSTS.has(url.hostname)) {
      return url.href;
    }
  }
  return '';
}
