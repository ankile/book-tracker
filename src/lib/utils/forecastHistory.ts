import type { BookUpdateView } from '../interfaces/reading.ts';
import type { TimestampLike } from '../interfaces/common.ts';
import {
  FORECAST_DAY_MS as DAY, selectedForecastDays, forecastFeatures,
  type ForecastBook, type ForecastObservation, type ForecastReading,
} from './finishForecast.ts';

export interface ForecastHistoryBook extends ForecastBook {
  finishedAt: TimestampLike | null;
}

export interface ForecastHistoryUpdate extends BookUpdateViewBase {
  type: 'reading' | 'update';
  timeRead?: number;
  updatedAt?: TimestampLike;
}

interface BookUpdateViewBase {
  book: { id: string };
  createdAt: TimestampLike;
  pagesRead: number;
  toPage?: number;
}

export interface ForecastHistoryInput {
  now: number;
  books: (ForecastBook & { finishedAt: number | null })[];
  updates: { bookId: string; at: number; editedAt: number; type: 'reading' | 'update';
    minutes: number; pages: number; toPage?: number }[];
}

export interface ForecastReplayObservation extends ForecastObservation {
  baselineDays: number;
  activeBooks: number;
}

export function forecastHistoryInput(
  books: readonly ForecastHistoryBook[], updates: readonly ForecastHistoryUpdate[], now: number,
): ForecastHistoryInput {
  return {
    now,
    books: books.map((book) => ({ id: book.id, pageCount: book.pageCount, currentPage: book.currentPage,
      finished: book.finished, finishedAt: book.finishedAt?.toDate().getTime() ?? null })),
    updates: updates.map((row) => ({ bookId: row.book.id, at: row.createdAt.toDate().getTime(),
      editedAt: row.updatedAt?.toDate().getTime() ?? row.createdAt.toDate().getTime(), type: row.type,
      minutes: row.type === 'reading' ? row.timeRead! : 0, pages: row.pagesRead, toPage: row.toPage })),
  };
}

export function forecastHistoryFromInput(input: ForecastHistoryInput): ForecastReplayObservation[] {
  const stamp = (at: number): TimestampLike => ({ toDate: () => new Date(at) });
  return buildForecastHistory(
    input.books.map((book) => ({ ...book, finishedAt: book.finishedAt === null ? null : stamp(book.finishedAt) })),
    input.updates.map((row) => ({ book: { id: row.bookId }, createdAt: stamp(row.at), updatedAt: stamp(row.editedAt),
      type: row.type, timeRead: row.minutes, pagesRead: row.pages, toPage: row.toPage })), input.now,
  );
}

// Build calibration evidence locally from the same prefix-only replay used
// by research. Metadata history is not stored, so pageCount is assumed fixed.
export function buildForecastHistory(
  books: readonly ForecastHistoryBook[],
  updates: readonly (BookUpdateView | ForecastHistoryUpdate)[],
  now: number,
): ForecastReplayObservation[] {
  const rows = updates.map((row) => ({
    bookId: row.book.id, at: row.createdAt.toDate().getTime(),
    editedAt: 'updatedAt' in row && row.updatedAt ? row.updatedAt.toDate().getTime() : row.createdAt.toDate().getTime(),
    type: row.type, minutes: row.type === 'reading' ? row.timeRead! : 0,
    pages: row.pagesRead, to: row.toPage,
  })).filter((row) => row.at <= now).sort((a, b) => a.at - b.at);
  if (rows.length === 0) return [];
  const histories = books.map((book) => {
    const own = rows.filter((row) => row.bookId === book.id);
    const finishedAt = book.finishedAt?.toDate().getTime() ?? null;
    const finishRow = own.findLast((row) => row.to === book.pageCount && row.pages > 0);
    return { book, own, finishedAt, reliable: finishedAt === null
      || (finishRow !== undefined && Math.abs(finishRow.at - finishedAt) < DAY) };
  });
  const origins = new Set<number>(rows.filter((row) => row.type === 'reading' && row.at < now).map((row) => row.at));
  for (let at = Math.ceil(rows[0].at / (7 * DAY)) * 7 * DAY; at < now; at += 7 * DAY) origins.add(at);
  const result: ForecastReplayObservation[] = [];
  for (const at of [...origins].sort((a, b) => a - b)) {
    const visible = histories.map((history) => {
      const past = history.own.filter((row) => row.at <= at && row.editedAt <= at + 1000);
      const last = past.at(-1);
      return { history, past, book: { ...history.book, currentPage: last?.to ?? 0,
        finished: last?.to === history.book.pageCount } };
    }).filter((item) => item.past.length > 0);
    const pastReadings: ForecastReading[] = rows.filter((row) => row.type === 'reading' && row.at <= at && row.editedAt <= at + 1000);
    for (const item of visible) {
      const { history, book, past } = item;
      if (!history.reliable || book.finished || (history.finishedAt !== null && history.finishedAt <= at)) continue;
      if (past.some((row) => row.to === undefined)) continue;
      const isSession = past.at(-1)!.at === at && past.at(-1)!.type === 'reading';
      if (!isSession && at % (7 * DAY) !== 0) continue;
      const features = forecastFeatures(book, visible.map((item) => item.book), pastReadings, at);
      if (!features || features.readingDays < 2 || features.idleDays > 365) continue;
      // Reproduce the old dashboard formula from the same visible prefix,
      // including its unfiltered speed and correction-aware activity gate.
      const own = past.filter((row) => row.type === 'reading');
      const pages = own.reduce((sum, row) => sum + row.pages, 0);
      const minutes = own.reduce((sum, row) => sum + row.minutes, 0);
      const recentMinutes = pastReadings.filter((row) => at - row.at <= 30 * DAY).reduce((sum, row) => sum + row.minutes, 0);
      const baselineDays = at - past.at(-1)!.at <= 60 * DAY && pages > 0 && minutes > 0 && recentMinutes > 0
        ? (book.pageCount - book.currentPage) * minutes / pages / (recentMinutes / 30) : Infinity;
      result.push({ bookId: book.id, at, finishedAt: history.finishedAt,
        predictedDays: selectedForecastDays(features), idleDays: features.idleDays,
        baselineDays, activeBooks: features.activeBooks });
    }
  }
  return result;
}
