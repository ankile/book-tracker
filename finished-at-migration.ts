// Backfill planner for finishedAt (see migrate-finished-at.ts). Pure so the
// unit test and the driver share one rule.
//
// A finished book without a stamp gets the moment of its last forward
// progress — the newest update row with pagesRead > 0 — because that is
// when the reader reached the last page. A page-count correction written
// later is an update row with zero or negative pagesRead and must not
// become the finish date. With no progress row at all the newest row of
// any type stands in, and with no history the book's own updatedAt does.
// Unfinished books are left alone: the decoder reads an absent field as
// null, and the client writes null explicitly from now on.

export interface StoredUpdateRow {
  id: string;
  data: Record<string, unknown>;
}

interface TimestampValue {
  toMillis(): number;
}

export interface FinishedAtPatch {
  finishedAt: TimestampValue;
}

function timestampOf(value: unknown, label: string): TimestampValue {
  if (typeof value !== 'object' || value === null ||
      !('toMillis' in value) || typeof value.toMillis !== 'function') {
    throw new TypeError(`${label} must be a timestamp`);
  }
  const candidate = value as TimestampValue;
  if (!Number.isFinite(candidate.toMillis())) throw new TypeError(`${label} must be a finite timestamp`);
  return candidate;
}

export function planFinishedAt(
  book: Record<string, unknown>,
  updates: readonly StoredUpdateRow[],
): FinishedAtPatch | null {
  if (book.finished !== true) return null;
  if (book.finishedAt !== undefined && book.finishedAt !== null) {
    timestampOf(book.finishedAt, 'finishedAt');
    return null;
  }
  const rows = updates.map((row) => {
    const pagesRead = row.data.pagesRead;
    if (typeof pagesRead !== 'number' || !Number.isFinite(pagesRead)) {
      throw new TypeError(`${row.id}.pagesRead must be a finite number`);
    }
    return {
      id: row.id,
      pagesRead,
      createdAt: timestampOf(row.data.createdAt, `${row.id}.createdAt`),
    };
  }).sort((left, right) =>
    left.createdAt.toMillis() - right.createdAt.toMillis() || left.id.localeCompare(right.id));
  const progressed = rows.filter((row) => row.pagesRead > 0);
  const source = progressed.at(-1) ?? rows.at(-1);
  return {finishedAt: source?.createdAt ?? timestampOf(book.updatedAt, 'updatedAt')};
}
