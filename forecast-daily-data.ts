// Offline snapshot replay. This module has no database client or credentials.
import assert from 'node:assert/strict';
import { FORECAST_DAY_MS as DAY, forecastFeatures, type ForecastBook, type ForecastReading } from './src/lib/utils/finishForecast.ts';
import { candidateDays, conditionalResumeDays, FORECAST_CANDIDATES, type ExperimentalForecastFeatures, type ReadingGap } from './forecast-candidates.ts';

interface Stamp { seconds: number; nanoseconds: number }
export interface DailySnapshot { takenAt: string; docs: {path: string; data: Record<string, unknown>}[] }
export interface HistoryRow extends ForecastReading { editedAt: number; type: 'reading' | 'update'; toPage: number }
export interface DailyBook { id: string; title: string; pageCount: number; finishedAt: number | null; reliable: boolean; rows: HistoryRow[] }
export interface DailyCase {
  bookId: string; at: number; finishedAt: number | null; currentUnfinished: boolean;
  idle: number; age: number; progress: number; remaining: number; activeBooks: number; readingDays: number;
  bookRates: number[]; userRates: number[]; ewma: number[]; resumeRate: number;
  vector: number[]; original: Record<string, number | null>;
}
export const HORIZONS = [7, 30, 90, 180, 365];
const ms = (stamp: Stamp) => stamp.seconds * 1000 + stamp.nanoseconds / 1e6;
const sum = (rows: readonly ForecastReading[]) => rows.reduce((total, row) => total + row.minutes, 0);

export function snapshotBooks(snapshot: DailySnapshot, email: string): DailyBook[] {
  const user = snapshot.docs.find((doc) => /^users\/[^/]+$/.test(doc.path) && doc.data.email === email);
  assert.ok(user, 'Account absent from snapshot');
  return snapshot.docs.filter((doc) => doc.path.startsWith(`${user.path}/books/`) && doc.path.split('/').length === 4).map((doc) => {
    const rows = snapshot.docs.filter((row) => row.path.startsWith(`${doc.path}/updates/`)).map((row): HistoryRow => {
      const d = row.data;
      assert.ok(d.type === 'reading' || d.type === 'update');
      const result: HistoryRow = { bookId: doc.path.split('/')[3], at: ms(d.createdAt as Stamp), editedAt: ms(d.updatedAt as Stamp),
        type: d.type, minutes: d.type === 'reading' ? d.timeRead as number : 0, pages: d.pagesRead as number, toPage: d.toPage as number };
      for (const value of [result.at, result.editedAt, result.minutes, result.pages, result.toPage]) assert.ok(Number.isFinite(value));
      return result;
    }).sort((a, b) => a.at - b.at);
    const pageCount = doc.data.pageCount as number;
    assert.ok(Number.isFinite(pageCount) && pageCount > 0);
    const finishedAt = doc.data.finished ? ms(doc.data.finishedAt as Stamp) : null;
    const final = rows.findLast((row) => row.toPage === pageCount && row.pages > 0);
    return { id: doc.path.split('/')[3], title: doc.data.title as string, pageCount, finishedAt, rows,
      reliable: finishedAt === null || (final !== undefined && Math.abs(final.at - finishedAt) < DAY) };
  });
}

// Final completion labels are only attached to results. Prefix progress alone
// determines the currently-reading population and all model inputs.
export function replayDay(histories: readonly DailyBook[], at: number): DailyCase[] {
  const visible = histories.map((history) => {
    const rows = history.rows.filter((row) => row.at <= at && row.editedAt <= at);
    const currentPage = rows.at(-1)?.toPage ?? 0;
    const book: ForecastBook = { id: history.id, pageCount: history.pageCount, currentPage, finished: currentPage >= history.pageCount };
    return { history, rows, book };
  }).filter((item) => item.rows.length > 0);
  const past = visible.flatMap((item) => item.rows).filter((row) => row.type === 'reading').sort((a, b) => a.at - b.at);
  const valid = past.filter((row) => row.minutes > 0 && row.pages >= 0);
  const speed = valid.filter((row) => row.minutes >= 5 && row.pages / row.minutes <= 2.5);
  const totalPages = speed.reduce((total, row) => total + row.pages, 0);
  const speedPrior = totalPages > 0 ? sum(speed) / totalPages : 2;
  const dailyMinutes = Array.from({length: 30}, (_, i) => sum(valid.filter((row) => at - row.at >= i * DAY && at - row.at < (i + 1) * DAY)));
  const gaps: ReadingGap[] = [];
  for (const item of visible) {
    const own = valid.filter((row) => row.bookId === item.book.id);
    for (let i = 1; i < own.length; i++) {
      const days = (own[i].at - own[i - 1].at) / DAY;
      if (days >= 1) gaps.push({days, resumed: true});
    }
    if (!item.book.finished && own.length) gaps.push({days: (at - own.at(-1)!.at) / DAY, resumed: false});
  }
  const result: DailyCase[] = [];
  for (const {history, book, rows} of visible) {
    if (book.finished || !history.reliable) continue;
    const own = valid.filter((row) => row.bookId === book.id);
    const f = forecastFeatures(book, visible.map((item) => item.book), past, at);
    const age = Math.max(1, (at - (own[0]?.at ?? rows[0].at)) / DAY);
    const idle = (at - (own.at(-1)?.at ?? rows.at(-1)!.at)) / DAY;
    const readingDays = new Set(own.map((row) => Math.floor((at - row.at) / DAY))).size;
    const remaining = f?.remainingMinutes ?? (book.pageCount - book.currentPage) * speedPrior;
    const bookRates = [7,14,30,60,90].map((w) => sum(own.filter((row) => at - row.at < w * DAY)) / Math.min(w, age));
    const userRates = [7,14,30,60,90].map((w) => sum(valid.filter((row) => at - row.at < w * DAY)) / w);
    const ewma = [7,14,30].map((half) => own.reduce((total, row) => total + row.minutes * 2 ** (-(at - row.at) / DAY / half), 0)
      / Math.max(1, half / Math.LN2 * (1 - 2 ** (-age / half))));
    const activeBooks = visible.filter((item) => !item.book.finished && valid.some((row) => row.bookId === item.book.id && at - row.at < 30 * DAY)).length;
    const original: DailyCase['original'] = Object.fromEntries(FORECAST_CANDIDATES.map((model) => [model.name, null]));
    if (f && readingDays >= 2) {
      const experimental: ExperimentalForecastFeatures = {...f, dailyMinutes, lifetimeRate: sum(own) / age,
        resumeWait: idle < 1 ? 0 : conditionalResumeDays(gaps, idle)};
      for (const model of FORECAST_CANDIDATES) {
        const days = candidateDays(experimental, model);
        original[model.name] = Number.isFinite(days) ? days : null;
      }
    }
    // The true former dashboard did not require two reading days or speed filters.
    const rawOwn = past.filter((row) => row.bookId === book.id);
    const rawPages = rawOwn.reduce((total, row) => total + row.pages, 0);
    const recent = sum(past.filter((row) => at - row.at <= 30 * DAY));
    original['existing-30'] = at - rows.at(-1)!.at <= 60 * DAY && rawPages > 0 && sum(rawOwn) > 0 && recent > 0
      ? (book.pageCount - book.currentPage) * sum(rawOwn) / rawPages / (recent / 30) : null;
    result.push({bookId: book.id, at, finishedAt: history.finishedAt, currentUnfinished: history.finishedAt === null,
      idle, age, readingDays, remaining, activeBooks, progress: book.currentPage / book.pageCount,
      bookRates, userRates, ewma, resumeRate: f?.resumeRate ?? 0, original,
      vector: [Math.log1p(remaining) / 2, Math.log1p(idle) / 1.2, Math.log1p(age) / 2,
        book.currentPage / book.pageCount, Math.log1p(userRates[1]) / 2, Math.log1p(bookRates[1]) / 2, Math.min(activeBooks, 5) / 3]});
  }
  return result;
}

export function dailyReplay(histories: readonly DailyBook[], end: number, phaseHours = 0): DailyCase[] {
  const first = Math.min(...histories.flatMap((book) => book.rows.map((row) => row.at)));
  const phase = phaseHours * DAY / 24;
  const result: DailyCase[] = [];
  for (let at = Math.ceil((first - phase) / DAY) * DAY + phase; at <= end; at += DAY) result.push(...replayDay(histories, at));
  return result;
}
