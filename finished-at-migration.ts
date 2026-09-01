// Backfill planner for finishedAt (see migrate-finished-at.ts). Pure so the
// unit test and the driver share one rule.
//
// A finished book without a stamp gets the moment of its last forward
// progress — the newest update row with pagesRead > 0 — because that is
// when the reader reached the last page. A page-count correction written
// later is an update row with zero or negative pagesRead and must not
// become the finish date; the planner reports such a later row so the
// operator sees the choice in the dry run. With no progress row at all
// the newest row of any type stands in (the correction that marked the
// book finished), and with no history at all the book's own createdAt
// does: such a book was added already finished. updatedAt is never a
// source — it moves on every metadata edit, which is exactly what made
// fifteen books look finished on 2026-08-28. Unfinished and already-
// stamped books are left alone.

export interface StoredUpdateRow {
  id: string;
  data: Record<string, unknown>;
}

interface TimestampValue {
  toMillis(): number;
}

export type FinishedAtSource = 'progress' | 'row' | 'createdAt';

export interface FinishedAtPlan {
  finishedAt: TimestampValue;
  via: FinishedAtSource;
  // A row newer than the chosen progress row (a later correction). The
  // stamp still comes from the progress row; this is for the operator.
  laterRowAt: TimestampValue | null;
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
): FinishedAtPlan | null {
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
  const newest = rows.at(-1);
  const progress = rows.filter((row) => row.pagesRead > 0).at(-1);
  if (progress !== undefined) {
    return {
      finishedAt: progress.createdAt,
      via: 'progress',
      laterRowAt: newest !== undefined && newest.id !== progress.id ? newest.createdAt : null,
    };
  }
  if (newest !== undefined) return {finishedAt: newest.createdAt, via: 'row', laterRowAt: null};
  return {finishedAt: timestampOf(book.createdAt, 'createdAt'), via: 'createdAt', laterRowAt: null};
}
