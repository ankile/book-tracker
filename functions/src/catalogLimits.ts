// Sizing bounds shared by the admin scan (which reads whole collections)
// and the creation paths (which refuse once a collection reaches its
// bound). They are structural, not usage limits: the scan's first page
// serialises every author, work, and edition into one callable response,
// which Cloud Functions caps at 10 MB. At the ~1 KB a real catalog
// document runs, 1,000 of each is ~3 MB with room for growth (prod holds
// ~220 books today); 5,000 of each would already exceed the response cap.
// Raise them only together with scan pagination.
export const CATALOG_LIMITS = {
  catalogAuthors: 1000,
  works: 1000,
  editions: 1000,
  isbnIndexes: 1000,
  externalIdIndexes: 1000,
} as const;
