// Goodreads — the last-resort source, used only by migrate-enrich-goodreads.js
// for books the other three could not fill. Deliberately NOT wired into the
// app: Goodreads sends no CORS headers (a browser cannot call it at all),
// its Terms of Service disallow automated access, and the markup is
// unversioned. Keeping it in a hand-run backfill confines the fragility and
// the volume to a few dozen requests over the owner's own library.
//
// Requests go to /book/isbn/<isbn>, which redirects to the book page.
// That path is not disallowed by robots.txt, unlike /search.
//
// Data comes from the page's schema.org JSON-LD (stable, machine-intended)
// rather than from scraped markup; only the genre list, which JSON-LD
// omits, is read out of the embedded page state.
const NONFICTION_GENRES = new Set([
  'memoir', 'biography', 'history', 'science', 'self help', 'business',
  'psychology', 'philosophy', 'politics', 'economics', 'travel', 'health',
  'true crime', 'essays', 'autobiography', 'reference', 'religion',
]);

export function goodreadsIsbnUrl(isbn13) {
  return `https://www.goodreads.com/book/isbn/${isbn13}`;
}

export function parseGoodreadsHtml(html) {
  const linkedData = extractJsonLd(html);
  if (linkedData === null) return null;
  const genres = extractGenres(html);
  return {
    title: linkedData.name ?? '',
    authorNames: (linkedData.author ?? []).map((a) => a.name).filter((name) => typeof name === 'string'),
    pageCount: linkedData.numberOfPages,
    // Goodreads cover images are served from Amazon's CDN over https.
    coverUrl: typeof linkedData.image === 'string' ? linkedData.image : '',
    publisher: '',
    publishedDate: '',
    subjects: genres,
    fiction: deriveFictionFromGenres(genres),
  };
}

function extractJsonLd(html) {
  const match = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s);
  if (match === null) return null;
  const data = JSON.parse(match[1]);
  return data['@type'] === 'Book' ? data : null;
}

// Genres appear in the embedded page state as {"name":X,"webUrl":".../genres/..."}.
export function extractGenres(html) {
  return [...new Set(
    [...html.matchAll(/"name":"([^"]{2,40})","webUrl":"https:\/\/www\.goodreads\.com\/genres\//g)]
      .map((match) => match[1])
  )];
}

// Goodreads tags non-fiction explicitly and consistently, so "Nonfiction"
// is a stronger signal here than any topic guess; a plain "Fiction" tag
// settles the other direction. ("Nonfiction" cannot match the \bfiction\b
// test — there is no word boundary inside it.)
export function deriveFictionFromGenres(genres) {
  let sawNonfiction = false;
  for (const genre of genres) {
    const lower = genre.toLowerCase();
    if (/\bnon-?fiction\b/.test(lower)) sawNonfiction = true;
    else if (/\bfiction\b/.test(lower)) return true;
    else if (NONFICTION_GENRES.has(lower)) sawNonfiction = true;
  }
  return sawNonfiction ? false : null;
}
