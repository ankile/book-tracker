import type {BookLookupResult} from "./src/lib/interfaces/metadata.ts";
import {normalizeIsbn} from "./src/lib/utils/isbn.ts";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, source: string): JsonObject {
  if (!isObject(value)) {
    throw new TypeError(`${source} response must be an object`);
  }
  return value;
}

function optionalArray(value: unknown, source: string): unknown[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError(`${source} must be an array when present`);
  }
  return value;
}

const LOOKUP_RESULT_KEYS = new Set([
  "title",
  "authorNames",
  "pageCount",
  "coverUrl",
  "publisher",
  "publishedDate",
  "subjects",
  "fiction",
  "language",
]);

function requireString(value: unknown, source: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${source} must be a string`);
  }
  return value;
}

function requireStringArray(value: unknown, source: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new TypeError(`${source} must be an array of strings`);
  }
  return value;
}

function decodeBookLookupResult(value: unknown, source: string): BookLookupResult {
  const result = requireObject(value, source);
  const unknownKey = Object.keys(result).find((key) => !LOOKUP_RESULT_KEYS.has(key));
  if (unknownKey !== undefined) {
    throw new TypeError(`${source} has unknown field ${unknownKey}`);
  }
  const pageCount = result.pageCount;
  if (pageCount !== undefined &&
      (typeof pageCount !== "number" || !Number.isSafeInteger(pageCount) ||
        pageCount <= 0)) {
    throw new TypeError(`${source}.pageCount must be a positive safe integer when present`);
  }
  if (result.fiction !== null && typeof result.fiction !== "boolean") {
    throw new TypeError(`${source}.fiction must be a boolean or null`);
  }
  return {
    title: requireString(result.title, `${source}.title`),
    authorNames: requireStringArray(result.authorNames, `${source}.authorNames`),
    pageCount: pageCount as number | undefined,
    coverUrl: requireString(result.coverUrl, `${source}.coverUrl`),
    publisher: requireString(result.publisher, `${source}.publisher`),
    publishedDate: requireString(result.publishedDate, `${source}.publishedDate`),
    subjects: requireStringArray(result.subjects, `${source}.subjects`),
    fiction: result.fiction,
    // Envelopes recorded before the language field carry none.
    language: result.language === undefined ? "" : requireString(result.language, `${source}.language`),
  };
}

export function bookLookupCache(
  value: unknown,
  source = "Book lookup cache",
): Record<string, BookLookupResult | null> {
  const cache = requireObject(value, source);
  const decoded: Record<string, BookLookupResult | null> = {};
  for (const [isbn13, result] of Object.entries(cache)) {
    if (normalizeIsbn(isbn13) !== isbn13) {
      throw new TypeError(`${source} key ${JSON.stringify(isbn13)} must be a bare ISBN-13`);
    }
    decoded[isbn13] = result === null ? null :
      decodeBookLookupResult(result, `${source}[${JSON.stringify(isbn13)}]`);
  }
  return decoded;
}

export function openLibraryRecord(payload: unknown, isbn13: string): unknown | undefined {
  const envelope = requireObject(payload, 'Open Library');
  return envelope[`ISBN:${isbn13}`];
}

export function googleBooksVolume(payload: unknown): unknown | undefined {
  const envelope = requireObject(payload, 'Google Books');
  const items = optionalArray(envelope.items, 'Google Books items');
  if (items === undefined || items.length === 0) return undefined;

  const item = requireObject(items[0], 'Google Books item');
  if (!('volumeInfo' in item)) {
    throw new TypeError('Google Books item is missing volumeInfo');
  }
  return item.volumeInfo;
}

export interface NbSearchResult {
  id: string;
  record: unknown;
}

export function nbSearchItem(payload: unknown): NbSearchResult | undefined {
  const envelope = requireObject(payload, 'Nasjonalbiblioteket');
  if (envelope._embedded === undefined) return undefined;

  const embedded = requireObject(envelope._embedded, 'Nasjonalbiblioteket _embedded');
  const items = optionalArray(embedded.items, 'Nasjonalbiblioteket items');
  if (items === undefined || items.length === 0) return undefined;

  const item = requireObject(items[0], 'Nasjonalbiblioteket item');
  if (typeof item.id !== 'string' || item.id === '') {
    throw new TypeError('Nasjonalbiblioteket item id must be a non-empty string');
  }
  return { id: item.id, record: item };
}
