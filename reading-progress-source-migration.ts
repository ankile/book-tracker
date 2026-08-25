interface TimestampValue {
  toMillis(): number;
}

export interface StoredProgressUpdate {
  id: string;
  data: Record<string, unknown>;
}

export interface ReadingProgressSourcePatch {
  currentPageUpdateId: string | null;
}

export interface ReadingProgressSourceFinding {
  cls: string;
  detail: string;
}

function safePage(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function timestampMillis(value: unknown, label: string): number {
  if (typeof value !== 'object' || value === null ||
      !('toMillis' in value) || typeof value.toMillis !== 'function') {
    throw new TypeError(`${label} must be a timestamp`);
  }
  const millis = (value as TimestampValue).toMillis();
  if (!Number.isFinite(millis)) throw new TypeError(`${label} must be a finite timestamp`);
  return millis;
}

// Backfill progress ownership without guessing from aggregate totals. The
// newest row that establishes the stored page is the best available source;
// deterministic id ordering resolves equal client timestamps.
export function planReadingProgressSource(
  book: Record<string, unknown>,
  updates: readonly StoredProgressUpdate[],
): ReadingProgressSourcePatch | null {
  const currentPage = safePage(book.currentPage, 'book.currentPage');
  const candidates = updates.map(({id, data}) => {
    if (data.type !== 'reading' && data.type !== 'update') {
      throw new TypeError(`updates/${id}.type must be reading or update`);
    }
    return {
      id,
      toPage: safePage(data.toPage, `updates/${id}.toPage`),
      createdAt: timestampMillis(data.createdAt, `updates/${id}.createdAt`),
    };
  });
  const hasSource = Object.hasOwn(book, 'currentPageUpdateId');
  const source = book.currentPageUpdateId;
  if (source !== undefined && source !== null &&
      (typeof source !== 'string' || source.length === 0)) {
    throw new TypeError('book.currentPageUpdateId must be a non-empty string or null');
  }
  if (typeof source === 'string') {
    const current = candidates.find((candidate) => candidate.id === source);
    if (current === undefined) throw new Error(`progress source updates/${source} is missing`);
    if (current.toPage !== currentPage) {
      throw new Error(`progress source updates/${source} does not establish page ${currentPage}`);
    }
    return null;
  }

  const newest = candidates
    .filter((candidate) => candidate.toPage === currentPage)
    .toSorted((left, right) =>
      right.createdAt - left.createdAt || right.id.localeCompare(left.id)
    )[0];
  if (newest !== undefined) return {currentPageUpdateId: newest.id};
  return hasSource ? null : {currentPageUpdateId: null};
}

// Audit is intentionally distinct from planning: an explicit null is a valid
// persisted baseline, but nonzero progress without an establishing row needs
// operator review before that baseline is accepted.
export function auditReadingProgressSource(
  book: Record<string, unknown>,
  updates: readonly StoredProgressUpdate[],
): ReadingProgressSourceFinding[] {
  const source = book.currentPageUpdateId;
  if (source !== undefined && source !== null &&
      (typeof source !== 'string' || source.length === 0)) {
    return [{
      cls: 'book.progress-source-bad-shape',
      detail: JSON.stringify(source),
    }];
  }
  if (typeof source === 'string') {
    const current = updates.find((update) => update.id === source);
    if (current === undefined) {
      return [{cls: 'book.progress-source-missing', detail: source}];
    }
    if (current.data.toPage !== book.currentPage) {
      return [{
        cls: 'book.progress-source-page-mismatch',
        detail: `${source}:${String(current.data.toPage)} != ${String(book.currentPage)}`,
      }];
    }
    return [];
  }
  if (source !== null) return [];

  const matching = updates
    .filter((update) => update.data.toPage === book.currentPage)
    .map((update) => update.id)
    .sort();
  if (matching.length > 0) {
    return [{cls: 'book.progress-source-unclaimed', detail: matching.join(',')}];
  }
  if (typeof book.currentPage === 'number' &&
      Number.isSafeInteger(book.currentPage) && book.currentPage > 0) {
    return [{
      cls: 'book.progress-source-null-baseline',
      detail: `page ${book.currentPage} has no establishing update`,
    }];
  }
  return [];
}
