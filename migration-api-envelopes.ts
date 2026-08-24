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
