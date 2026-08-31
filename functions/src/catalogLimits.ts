// Sizing bounds shared by the admin scan (which reads whole collections)
// and the creation paths (which refuse once a collection reaches its
// bound). They are structural — the scan page holds one page of each in
// memory — not usage limits: raise them together with scan pagination.
export const CATALOG_LIMITS = {
  catalogAuthors: 5000,
  works: 5000,
  editions: 5000,
  isbnIndexes: 5000,
  externalIdIndexes: 5000,
} as const;
