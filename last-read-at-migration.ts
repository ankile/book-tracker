// Backfill planner for lastReadAt (see migrate-last-read-at.ts). Pure so
// the unit test and the driver share one rule, and the rule itself is the
// client's (src/lib/utils/lastRead.ts): the newest row that is a timed
// session or moved the page forward, or null for a book never read. A
// page-count clamp or backward correction is not reading. updatedAt is
// never a source — it moves on every metadata edit, which is exactly what
// put a book edited on 2026-08-29 above one read on 2026-08-26. A book
// that already carries the field (a timestamp or an explicit null) is left
// alone, so a second apply plans nothing.
import {lastReadAtOf, type ReadActivityRow} from './src/lib/utils/lastRead.ts';

export interface StoredUpdateRow {
  id: string;
  data: Record<string, unknown>;
}

interface TimestampValue {
  toMillis(): number;
}

export interface LastReadAtPlan {
  lastReadAt: TimestampValue | null;
  via: 'row' | 'never';
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

export function planLastReadAt(
  book: Record<string, unknown>,
  updates: readonly StoredUpdateRow[],
): LastReadAtPlan | null {
  if (book.lastReadAt !== undefined) {
    if (book.lastReadAt !== null) timestampOf(book.lastReadAt, 'lastReadAt');
    return null;
  }
  const rows: ReadActivityRow<TimestampValue>[] = updates.map((row) => ({
    id: row.id,
    type: row.data.type,
    pagesRead: row.data.pagesRead,
    createdAt: timestampOf(row.data.createdAt, `${row.id}.createdAt`),
  }));
  const lastReadAt = lastReadAtOf(rows);
  return {lastReadAt, via: lastReadAt === null ? 'never' : 'row'};
}
