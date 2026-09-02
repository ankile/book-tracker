// Languages across the catalog. A work carries a default language: the
// language its editions are in unless an edition overrides it (owner
// decision 2026-09-02). Each reader's book carries the effective language of
// the edition it stands on, as a copy beside cover and publisher, so lists
// and stats can read it without a catalog join.
//
// Codes are lowercase ISO 639 primary subtags (en, no, de); '' is unknown on
// a work or a book and "inherit" on an edition. Norwegian Bokmål is stored
// as the macrolanguage code no, which is what Google Books and the ISBN
// registration group give; nn stays nn.

const LANGUAGE_CODE = /^[a-z]{2,3}$/u;

// ISO 639-2 (bibliographic and terminology) codes that library records
// use, mapped to the two-letter code the catalog stores.
const THREE_TO_TWO: Record<string, string> = {
  eng: 'en', nob: 'no', nor: 'no', nno: 'nn', swe: 'sv', dan: 'da', ger: 'de', deu: 'de',
  fre: 'fr', fra: 'fr', spa: 'es', ita: 'it', dut: 'nl', nld: 'nl', fin: 'fi', por: 'pt',
  rus: 'ru', pol: 'pl', jpn: 'ja', chi: 'zh', zho: 'zh', lat: 'la', gre: 'el', ell: 'el',
  ice: 'is', isl: 'is', cze: 'cs', ces: 'cs', hun: 'hu', tur: 'tr', ara: 'ar', heb: 'he',
  kor: 'ko', hin: 'hi', ukr: 'uk', cat: 'ca', rum: 'ro', ron: 'ro', hrv: 'hr', srp: 'sr',
  bul: 'bg', slv: 'sl', slo: 'sk', slk: 'sk', est: 'et', lav: 'lv', lit: 'lt', fao: 'fo',
  sme: 'se', ind: 'id', tha: 'th', vie: 'vi', per: 'fa', fas: 'fa', urd: 'ur', ben: 'bn',
  may: 'ms', msa: 'ms',
};

export function isLanguageCode(value: string): boolean {
  return value === '' || LANGUAGE_CODE.test(value);
}

// Lowercases, trims, drops a region subtag (en-US → en) and maps a
// three-letter library code to its two-letter form. Anything that is not a
// code afterwards is unknown: sources are not trusted to be tidy.
export function normalizeLanguageCode(value: string): string {
  const primary = value.trim().toLowerCase().split(/[-_]/u)[0];
  const code = primary === 'nb' ? 'no' : THREE_TO_TWO[primary] ?? primary;
  return LANGUAGE_CODE.test(code) ? code : '';
}

export function effectiveLanguage(editionLanguage: string, workLanguage: string): string {
  return editionLanguage !== '' ? editionLanguage : workLanguage;
}

// "Norwegian" for no, in the reader's locale where the runtime knows it;
// the code itself otherwise. '' stays ''.
export function languageLabel(code: string, locale = 'en'): string {
  if (code === '') return '';
  const names = new Intl.DisplayNames([locale], {type: 'language', fallback: 'code'});
  return names.of(code) ?? code;
}

// The languages the console offers first; any other code can be typed.
export const COMMON_LANGUAGES: ReadonlyArray<{code: string; label: string}> = [
  {code: 'en', label: 'English'}, {code: 'no', label: 'Norwegian'},
  {code: 'nn', label: 'Norwegian Nynorsk'}, {code: 'sv', label: 'Swedish'},
  {code: 'da', label: 'Danish'}, {code: 'de', label: 'German'}, {code: 'fr', label: 'French'},
  {code: 'es', label: 'Spanish'}, {code: 'it', label: 'Italian'}, {code: 'nl', label: 'Dutch'},
  {code: 'fi', label: 'Finnish'}, {code: 'is', label: 'Icelandic'}, {code: 'pt', label: 'Portuguese'},
  {code: 'ru', label: 'Russian'}, {code: 'pl', label: 'Polish'}, {code: 'ja', label: 'Japanese'},
  {code: 'zh', label: 'Chinese'}, {code: 'la', label: 'Latin'}, {code: 'el', label: 'Greek'},
];

// The ISBN registration group (the digits after the 978/979 prefix) names
// the country or language area that assigned the number, which for a book
// from a general publisher is the language it is printed in. A heuristic
// for the backfill of works that predate the language field, not a rule:
// an area that publishes in several languages, or one this table does not
// know, answers unknown and is left for the operator.
const GROUP_LANGUAGES: ReadonlyArray<[prefix: string, language: string]> = [
  ['9780', 'en'], ['9781', 'en'], ['9782', 'fr'], ['9783', 'de'], ['9784', 'ja'], ['9785', 'ru'],
  ['9787', 'zh'], ['97880', 'cs'], ['97882', 'no'], ['97883', 'pl'], ['97884', 'es'],
  ['97885', 'pt'], ['97886', 'sr'], ['97887', 'da'], ['97888', 'it'], ['97889', 'ko'],
  ['97890', 'nl'], ['97891', 'sv'], ['97894', 'nl'], ['978950', 'es'], ['978951', 'fi'],
  ['978952', 'fi'], ['978953', 'hr'], ['978954', 'bg'], ['978956', 'es'], ['978957', 'zh'],
  ['978958', 'es'], ['978959', 'es'], ['978960', 'el'], ['978961', 'sl'], ['978962', 'zh'],
  ['978963', 'hu'], ['978964', 'fa'], ['978965', 'he'], ['978966', 'uk'], ['978967', 'ms'],
  ['978968', 'es'], ['978970', 'es'], ['978972', 'pt'], ['978973', 'ro'], ['978974', 'th'],
  ['978975', 'tr'], ['978977', 'ar'], ['978979', 'id'], ['978980', 'es'], ['978981', 'en'],
  ['978982', 'en'], ['978983', 'ms'], ['978984', 'bn'], ['978986', 'zh'], ['978987', 'es'],
  ['978988', 'zh'], ['978989', 'pt'], ['9789979', 'is'], ['97910', 'fr'], ['97911', 'ko'],
  ['97912', 'it'], ['9798', 'en'],
];

export function languageForIsbn(isbn13: string): string {
  // Longest prefix wins: 9789979 (Iceland) over 97899 (which is not a group).
  let best: [string, string] | null = null;
  for (const entry of GROUP_LANGUAGES) {
    if (isbn13.startsWith(entry[0]) && (best === null || entry[0].length > best[0].length)) best = entry;
  }
  return best === null ? '' : best[1];
}
