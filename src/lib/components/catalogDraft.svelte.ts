// The shared-catalog search and selection state behind a book form: the
// debounced search, its results, the chosen work, and whether the reader
// chose it or an exact ISBN match did. One implementation serves the
// add/edit book modal and the to-read planner's add flow. Form filling
// (title, authors, pages, metadata copied from a chosen result) stays
// with the form: the draft only owns the catalog side.
import { catalogSearch } from '../firebase/functions.ts';
import type { CatalogSearchRequest, CatalogSearchResult, CatalogSelection } from '../interfaces/catalog.ts';
import { normalizeIsbn } from '../utils/isbn.ts';
import {
  automaticIsbnSelectionStillApplies,
  createLatestRequestGate,
  exactEditionPreselection,
  selectionForResult,
} from '../utils/catalogClient.ts';

const SEARCH_DEBOUNCE_MS = 350;

export class CatalogDraft {
  results = $state<CatalogSearchResult[]>([]);
  selection = $state<CatalogSelection | null>(null);
  selectedResult = $state<CatalogSearchResult | null>(null);
  loading = $state(false);
  message = $state('');
  // The reader chose or removed a link; automatic matches must not
  // override that, and saving must not seed a work.
  choiceTouched = $state(false);
  // The ISBN whose exact edition match was selected automatically; the
  // selection is dropped when that ISBN changes.
  automaticIsbn13 = $state<string | null>(null);
  #gate = createLatestRequestGate();

  // Seed from a stored link (editing) or clear (adding).
  seed(selection: CatalogSelection | null, automaticIsbn13: string | null): void {
    this.selection = selection;
    this.selectedResult = null;
    this.choiceTouched = false;
    this.automaticIsbn13 = automaticIsbn13;
    this.results = [];
    this.message = '';
  }

  // The form closed: stop any request in flight and forget the results.
  reset(): void {
    this.#gate.invalidate();
    this.results = [];
    this.message = '';
    this.loading = false;
  }

  // Called from the form's $effect whenever its search inputs change;
  // returns the cleanup that cancels the pending debounce. `onExact`
  // receives an unambiguous ISBN match the reader has not overridden.
  sync(
    request: CatalogSearchRequest | null,
    online: boolean,
    onExact: (result: CatalogSearchResult) => void,
  ): (() => void) | undefined {
    if (request === null) {
      this.#gate.invalidate();
      this.results = [];
      this.loading = false;
      if (this.automaticIsbn13 !== null) {
        this.selection = null;
        this.selectedResult = null;
        this.automaticIsbn13 = null;
      }
      return undefined;
    }
    if (!automaticIsbnSelectionStillApplies(this.automaticIsbn13, request)) {
      this.selection = null;
      this.selectedResult = null;
      this.automaticIsbn13 = null;
    }
    if (!online) {
      this.#gate.invalidate();
      this.loading = false;
      this.message = this.selection === null
        ? 'Catalog lookup is unavailable offline. Saving will keep this book unlinked.'
        : 'Catalog lookup is unavailable offline. Your current shared-work choice remains selected.';
      return undefined;
    }
    // Input changes make any already-running request stale immediately, not
    // only after the replacement request starts at the end of the debounce.
    this.#gate.invalidate();
    this.results = [];
    const timeout = window.setTimeout(() => void this.#search(request, onExact), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }

  async #search(request: CatalogSearchRequest, onExact: (result: CatalogSearchResult) => void): Promise<void> {
    const requestId = this.#gate.begin();
    this.loading = true;
    this.message = '';
    try {
      const response = await catalogSearch(request);
      if (!this.#gate.isCurrent(requestId)) return;
      this.results = response.results;
      if (this.selection !== null) {
        const chosen = this.selection;
        this.selectedResult = response.results.find((result) =>
          result.workId === chosen.workId || result.work.mergedFrom.includes(chosen.workId)) ?? this.selectedResult;
      }
      const exact = exactEditionPreselection(response.results);
      if (!this.choiceTouched && this.selection === null && exact !== null) onExact(exact);
    } catch (error) {
      if (!this.#gate.isCurrent(requestId)) return;
      console.error('Catalog search failed', error);
      this.results = [];
      this.message = 'Catalog suggestions are unavailable. You can still save this book unlinked.';
    } finally {
      if (this.#gate.isCurrent(requestId)) this.loading = false;
    }
  }

  // Record a chosen result. `touched` is false for the automatic exact
  // ISBN match, which then follows the ISBN field.
  select(result: CatalogSearchResult, touched: boolean, isbn: string): void {
    this.selection = selectionForResult(result);
    this.selectedResult = result;
    this.choiceTouched = touched;
    this.automaticIsbn13 = touched ? null : normalizeIsbn(isbn);
  }

  remove(): void {
    this.selection = null;
    this.selectedResult = null;
    this.choiceTouched = true;
    this.automaticIsbn13 = null;
    this.message = 'This personal book will be saved without a shared-work link.';
  }
}
