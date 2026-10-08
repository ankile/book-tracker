// Words per numbered page of a catalog edition, measured in Word Counter
// (the word-counter app) and stored as editions/{id}.wordEstimate by
// catalog.setwordestimate. A reader's book uses it only when the book's page
// count is the one the edition was measured on (owner decision 2026-10-08):
// another printing, or a page count the reader corrected, paginates
// differently, and rescaling would be a guess. The browser (stats page) and
// the work-readers callable apply the same rule.

export interface WordEstimateBasis {
  pageCountBasis: number;
  wordsPerPage: number;
}

export function matchedWordEstimate<T extends WordEstimateBasis>(
  estimate: T | null | undefined,
  pageCount: number,
): T | null {
  return estimate !== null && estimate !== undefined && estimate.pageCountBasis === pageCount ?
    estimate : null;
}
