export const SUPPORTED_LEADING_TITLE_ARTICLES = ['a', 'an', 'the'] as const;

const APOSTROPHES = /['\u2018\u2019\u02bc`\u00b4]/gu;
const COMBINING_MARKS = /\p{Mark}+/gu;
const NON_WORD_CHARACTERS = /[^\p{Letter}\p{Number}]+/gu;
const CHARACTER_FOLDS: Readonly<Record<string, string>> = {
  'æ': 'ae',
  'ð': 'd',
  'đ': 'd',
  'ł': 'l',
  'ø': 'o',
  'œ': 'oe',
  'ß': 'ss',
  'þ': 'th',
};

function foldCharacters(value: string): string {
  return [...value].map((character) => CHARACTER_FOLDS[character] ?? character).join('');
}

function normalizeWords(value: string): string {
  return foldCharacters(value.normalize('NFKD').toLowerCase())
    .replace(COMBINING_MARKS, '')
    .replace(APOSTROPHES, '')
    .replace(/&/gu, ' and ')
    .replace(NON_WORD_CHARACTERS, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

function moveTrailingEnglishArticle(title: string): string {
  const match = /^(.*\S)\s*,\s*(a|an|the)\s*$/iu.exec(title);
  return match === null ? title : `${match[2]} ${match[1]}`;
}

export function normalizeCatalogTitle(title: string): string {
  const normalized = normalizeWords(moveTrailingEnglishArticle(title));
  const words = normalized.split(' ');
  if (
    words.length > 1 &&
    SUPPORTED_LEADING_TITLE_ARTICLES.includes(
      words[0] as (typeof SUPPORTED_LEADING_TITLE_ARTICLES)[number],
    )
  ) {
    return words.slice(1).join(' ');
  }
  return normalized;
}

export function catalogTitleKeys(
  canonicalTitle: string,
  alternateTitles: readonly string[] = [],
): string[] {
  return [...new Set(
    [canonicalTitle, ...alternateTitles]
      .map(normalizeCatalogTitle)
      .filter((title) => title.length > 0),
  )];
}

export function normalizeCatalogAuthorName(name: string): string {
  return normalizeWords(name);
}

export function normalizeCatalogAuthorNames(names: readonly string[]): string[] {
  return [...new Set(names.map(normalizeCatalogAuthorName).filter((name) => name.length > 0))]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

export function catalogAuthorsEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const normalizedLeft = normalizeCatalogAuthorNames(left);
  const normalizedRight = normalizeCatalogAuthorNames(right);
  return normalizedLeft.length > 0 &&
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((name, index) => name === normalizedRight[index]);
}

export function catalogAuthorsOverlap(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const normalizedLeft = new Set(normalizeCatalogAuthorNames(left));
  return normalizedLeft.size > 0 &&
    normalizeCatalogAuthorNames(right).some((name) => normalizedLeft.has(name));
}

function levenshteinDistance(left: string, right: string): number {
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  let previous = Array.from({length: right.length + 1}, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      current.push(Math.min(
        current[rightIndex] + 1,
        previous[rightIndex + 1] + 1,
        previous[rightIndex] + (left[leftIndex] === right[rightIndex] ? 0 : 1),
      ));
    }
    previous = current;
  }
  return previous[right.length];
}

export function catalogTitleSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeCatalogTitle(left);
  const normalizedRight = normalizeCatalogTitle(right);
  const longest = Math.max(normalizedLeft.length, normalizedRight.length);
  if (longest === 0) return 0;
  return 1 - levenshteinDistance(normalizedLeft, normalizedRight) / longest;
}

export type CatalogTextMatch =
  | 'none'
  | 'title-only'
  | 'title-author-overlap'
  | 'title-author-exact';

export interface CatalogTextCandidate {
  canonicalTitle: string;
  alternateTitles?: readonly string[];
  authorNames: readonly string[];
}

export function matchCatalogText(
  title: string,
  authorNames: readonly string[],
  candidate: CatalogTextCandidate,
): CatalogTextMatch {
  const titleKey = normalizeCatalogTitle(title);
  if (
    titleKey.length === 0 ||
    !catalogTitleKeys(candidate.canonicalTitle, candidate.alternateTitles).includes(titleKey)
  ) {
    return 'none';
  }
  if (catalogAuthorsEqual(authorNames, candidate.authorNames)) return 'title-author-exact';
  if (catalogAuthorsOverlap(authorNames, candidate.authorNames)) return 'title-author-overlap';
  return 'title-only';
}
