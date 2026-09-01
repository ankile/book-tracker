// Catalog identity normalization for the browser. The implementation is
// shared with Cloud Functions (shared/catalogIdentity.ts) so the keys the
// client matches against are the keys the server wrote.
import { normalizeCatalogIdentity } from '../../../shared/catalogIdentity.ts';

export { catalogTitleKeys, normalizeCatalogTitle } from '../../../shared/catalogIdentity.ts';

export function normalizeCatalogAuthorName(name: string): string {
  return normalizeCatalogIdentity(name);
}

export function normalizeCatalogAuthorNames(names: readonly string[]): string[] {
  return [...new Set(names.map(normalizeCatalogAuthorName).filter((name) => name.length > 0))]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}
