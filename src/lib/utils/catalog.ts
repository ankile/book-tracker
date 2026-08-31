const SUPPORTED_LEADING_TITLE_ARTICLES = ['a', 'an', 'the'] as const;

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
  alternateTitles: readonly string[],
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
