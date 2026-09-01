// Catalog identity normalization, shared by the browser and Cloud Functions.
// One implementation on purpose: ensureauthors writes nameKeys with it,
// catalog.ts derives title keys from it, the live admin scan in the browser
// recomputes both, and the add-book flow matches against them. A fold added
// on one side but not the other would report every stored author as
// corrupt and make lookups miss existing authors.
//
// This directory is imported by the SvelteKit app and the root tests
// directly and copied into functions/src/shared by the functions build (the
// two packages compile with different module systems and neither can reach
// across the other's tsconfig root). Nothing here may import from either
// package or from a runtime-specific API.

const CATALOG_CHARACTER_FOLDS: Readonly<Record<string, string>> = {
  'æ': 'ae',
  'ð': 'd',
  'đ': 'd',
  'ł': 'l',
  'ø': 'o',
  'œ': 'oe',
  'ß': 'ss',
  'þ': 'th',
};

export function normalizeCatalogIdentity(value: string): string {
  const folded = [...value.normalize('NFKD').toLowerCase()].map((character) =>
    CATALOG_CHARACTER_FOLDS[character] ?? character,
  ).join('');
  return folded
    .replace(/\p{Mark}+/gu, '')
    .replace(/['\u2018\u2019\u02bc`\u00b4]/gu, '')
    .replace(/&/gu, ' and ')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

const SUPPORTED_LEADING_TITLE_ARTICLES = ['a', 'an', 'the'] as const;

function moveTrailingEnglishArticle(title: string): string {
  const match = /^(.*\S)\s*,\s*(a|an|the)\s*$/iu.exec(title);
  return match === null ? title : `${match[2]} ${match[1]}`;
}

export function normalizeCatalogTitle(value: string): string {
  const normalized = normalizeCatalogIdentity(moveTrailingEnglishArticle(value));
  const words = normalized.split(' ');
  const first = words[0] as typeof SUPPORTED_LEADING_TITLE_ARTICLES[number];
  if (words.length > 1 && SUPPORTED_LEADING_TITLE_ARTICLES.includes(first)) {
    return words.slice(1).join(' ');
  }
  return normalized;
}

export function catalogTitleKeys(
  canonicalTitle: string,
  alternateTitles: readonly string[],
): string[] {
  return [...new Set(
    [canonicalTitle, ...alternateTitles]
      .map(normalizeCatalogTitle)
      .filter((title) => title.length > 0),
  )];
}

export function identityTokens(value: string): Set<string> {
  return new Set(normalizeCatalogIdentity(value).split(' ').filter(Boolean));
}

// Jaccard agreement between two token sets; 0 when either is empty.
export function tokenAgreement(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  const intersection = [...left].filter((token) => right.has(token)).length;
  return intersection / new Set([...left, ...right]).size;
}

function isbn13CheckDigit(first12: string): string {
  let sum = 0;
  for (let index = 0; index < 12; index += 1) {
    sum += Number(first12[index]) * (index % 2 === 0 ? 1 : 3);
  }
  return String((10 - (sum % 10)) % 10);
}

// The one ISBN normalizer: any ISBN-10 or ISBN-13 spelling a personal book
// may carry (hyphens and spaces included) becomes the checksum-valid
// ISBN-13 the catalog indexes by, or null. The scan reports link candidates
// with it, so it must agree with what the link path accepts.
export function normalizeIsbn13(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const isbn = value.replace(/[-\s]/g, '').toUpperCase();
  if (/^\d{9}[\dX]$/.test(isbn)) {
    let isbn10Sum = 0;
    for (let index = 0; index < 10; index += 1) {
      isbn10Sum += (10 - index) * (isbn[index] === 'X' ? 10 : Number(isbn[index]));
    }
    if (isbn10Sum % 11 !== 0) return null;
    const core = `978${isbn.slice(0, 9)}`;
    return `${core}${isbn13CheckDigit(core)}`;
  }
  if (!/^\d{13}$/.test(isbn)) return null;
  return isbn[12] === isbn13CheckDigit(isbn) ? isbn : null;
}

// The externalIdIndex document id is the SHA-256 hex digest of this string.
// The digest itself is computed by the caller: synchronously with
// node:crypto in Cloud Functions, asynchronously with SubtleCrypto in the
// browser.
export function externalIndexDigestInput(provider: string, id: string): string {
  return `${provider}\0${id}`;
}
