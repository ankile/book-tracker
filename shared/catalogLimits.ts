// Sizing bounds shared by the browser's live catalog scan (which listens to
// whole collections), the creation paths (which refuse once a collection
// reaches its bound) and the author autocomplete. They are structural, not
// usage limits: the operator's browser holds every author, work, edition and
// index row in memory and in the persistent cache, and the client author
// store already listens to the whole catalogAuthors collection for
// autocomplete. At the ~1 KB a real catalog document runs, 1,000 of each is
// ~3 MB (prod holds ~220 books today). Raise them only together with a
// lazier listener design.
//
// The bound assumes an average row under ~3 KB. Rows at the decoder maxima
// (a work ~15 KB) could push the resident set past 15 MB, which only a
// verified account filling the catalog with oversized records can reach;
// that is outside the threat model (owner decision 2026-09-01), and the
// failure is confined to the admin page — db-audit.ts still reads
// everything.
export const CATALOG_LIMITS = {
  catalogAuthors: 1000,
  works: 1000,
  editions: 1000,
  isbnIndexes: 1000,
  externalIdIndexes: 1000,
} as const;

// A personal book names at most this many catalog authors; the scan reports
// a book past it as malformed rather than resolving a runaway list.
export const MAX_AUTHORS_PER_PERSONAL_BOOK = 6;
