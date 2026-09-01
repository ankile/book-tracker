// ISBN normalization, shared by the add/edit modal's Look up button,
// migrate-enrich-books.ts and the catalog link paths so every side keys
// lookups and indexes the same way. The implementation lives with the other
// catalog identity normalizers (shared/catalogIdentity.ts) and is the one the
// server's link/apply path uses.
//
// normalizeIsbn accepts whatever the user pasted (hyphens, spaces, lower-x
// check digit) and returns the bare ISBN-13 string, converting ISBN-10
// input. Returns null for anything that isn't a checksum-valid ISBN —
// callers surface that, they don't guess.
export { normalizeIsbn13 as normalizeIsbn } from '../../../shared/catalogIdentity.ts';
