// Sizing bounds shared by the admin scan (which reads whole collections)
// and the creation paths (which refuse once a collection reaches its
// bound). They are structural, not usage limits: the scan's first page
// serialises every author, work, and edition into one callable response,
// which Cloud Functions caps at 10 MB. At the ~1 KB a real catalog
// document runs, 1,000 of each is ~3 MB with room for growth (prod holds
// ~220 books today); 5,000 of each would already exceed the response cap.
// Raise them only together with scan pagination.
//
// The bound assumes an average row under ~3 KB. Rows at the decoder maxima
// (a work ~15 KB) could push a full catalog past 10 MB, which only a
// verified account filling the catalog with oversized records can reach;
// that is outside the threat model (owner decision 2026-09-01), and the
// failure is confined to the admin scan — db-audit.ts still reads
// everything. Paginate the scan if a real catalog ever gets there.
export const CATALOG_LIMITS = {
  catalogAuthors: 1000,
  works: 1000,
  editions: 1000,
  isbnIndexes: 1000,
  externalIdIndexes: 1000,
} as const;
