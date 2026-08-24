// Nasjonalbiblioteket (api.nb.no) — the third metadata source, and the
// only one that reliably knows Norwegian editions. Free, no API key, and
// it reflects CORS origins, so the browser can call it directly.
//
// It answers the fiction/non-fiction question for Norwegian books that
// Open Library and Google Books draw a blank on: catalogue records carry
// MODS genres like "Romaner" (novels) and the explicit marker "notfiction".
// Covers are weaker — the scanned cover of an in-copyright book is
// restricted, so a candidate URL must be verified before it is stored.
export const NB_SEARCH_URL = 'https://api.nb.no/catalog/v1/items';

// Cataloguing tokens that describe the record rather than the work, and
// so are noise as subject labels.
const GENRE_STOPWORDS = new Set(['tekst', 'text', 'bibliography', 'fiction', 'notfiction', 'novel', 'biography', 'drama', 'poem']);

const FICTION_GENRES = /^(novel|fiction|roman|romaner|noveller|fortellinger|eventyr|dikt|lyrikk|poem|drama|skuespill|tegneserier)$/i;
const NONFICTION_GENRES = /^(notfiction|biography|biografier|selvbiografier|memoarer|lover|fagb[oø]ker|sakprosa|essays?|leksika|l[æa]reb[oø]ker)$/i;

export function nbSearchUrl(isbn13) {
  return `${NB_SEARCH_URL}?q=${isbn13}&size=1`;
}

export function nbModsUrl(itemId) {
  return `https://api.nb.no/catalog/v1/metadata/${itemId}/mods`;
}

// The scanned cover page of a digitised book. Restricted for in-copyright
// titles (403), so callers must verify before storing — nbCoverCandidate
// only builds the URL.
export function nbCoverCandidate(urn) {
  return urn ? `https://www.nb.no/services/image/resolver/${urn}_C1/full/0,400/0/native.jpg` : '';
}

// MODS genres come from a separate request; pass [] when not fetched.
// coverUrl is deliberately left empty here — see nbCoverCandidate.
export function parseNbItem(item, genres = []) {
  const md = item.metadata ?? {};
  const subjects = [...new Set(
    genres.map((g) => g.trim()).filter((g) => g !== '' && !GENRE_STOPWORDS.has(g.toLowerCase()))
  )];
  return {
    title: md.title ?? '',
    authorNames: (md.creators ?? []).map(flipCatalogueName),
    pageCount: md.pageCount,
    coverUrl: '',
    publisher: md.originInfo?.publisher ?? '',
    publishedDate: md.originInfo?.issued ?? '',
    subjects,
    fiction: deriveFictionFromNbGenres(genres),
    urn: md.identifiers?.urn ?? '',
  };
}

// Catalogue form is "Hamsun, Knut"; the app stores display order.
export function flipCatalogueName(name) {
  const parts = name.split(',');
  if (parts.length !== 2) return name.trim();
  return `${parts[1].trim()} ${parts[0].trim()}`.trim();
}

// A fiction genre wins outright: records routinely carry both a content
// genre ("novel") and a form note ("bibliography"), and only the former
// says what the book is.
export function deriveFictionFromNbGenres(genres) {
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
export function extractModsGenres(modsXml) {
  return [...new Set(
    [...modsXml.matchAll(/<(?:[a-zA-Z]+:)?genre[^>]*>([^<]*)<\/(?:[a-zA-Z]+:)?genre>/g)]
      .map((match) => match[1].trim())
      .filter((genre) => genre !== '')
  )];
}
