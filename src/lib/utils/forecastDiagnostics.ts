import {
  FORECAST_DAY_MS as DAY, FORECAST_HORIZON_DAYS, FORECAST_RANGE_SCALE,
  calibrateForecast, type ForecastBook, type ForecastReading,
} from './finishForecast.ts';
import type { ForecastReplayObservation } from './forecastHistory.ts';

export const FORECAST_HOLDOUT_START = Date.UTC(2025, 0, 1);
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

export function readingEvidence(book: ForecastBook, readings: readonly ForecastReading[], now: number) {
  const past = readings.filter((row) => row.at <= now && row.minutes > 0 && row.pages >= 0);
  const own = past.filter((row) => row.bookId === book.id).sort((a, b) => a.at - b.at);
  const speed = own.filter((row) => row.minutes >= 5 && row.pages / row.minutes <= 2.5);
  const days = Array.from({ length: 14 }, (_, index) => {
    const start = now - (14 - index) * DAY;
    const end = start + DAY;
    const rows = past.filter((row) => row.at > start && row.at <= end);
    return { start, end, book: rows.filter((row) => row.bookId === book.id).reduce((sum, row) => sum + row.minutes, 0),
      other: rows.filter((row) => row.bookId !== book.id).reduce((sum, row) => sum + row.minutes, 0) };
  });
  const competing = [...new Set(past.filter((row) => now - row.at < 30 * DAY).map((row) => row.bookId))].map((id) => {
    const rows = past.filter((row) => row.bookId === id);
    return { bookId: id, minutes14: rows.filter((row) => now - row.at < 14 * DAY).reduce((sum, row) => sum + row.minutes, 0),
      minutes30: rows.filter((row) => now - row.at < 30 * DAY).reduce((sum, row) => sum + row.minutes, 0),
      lastAt: Math.max(...rows.map((row) => row.at)) };
  }).sort((a, b) => b.minutes14 - a.minutes14 || b.minutes30 - a.minutes30);
  return { sessions: own.length, speedSessions: speed.length,
    speedMinutes: speed.reduce((sum, row) => sum + row.minutes, 0),
    speedPages: speed.reduce((sum, row) => sum + row.pages, 0),
    firstAt: own[0]?.at ?? null, lastAt: own.at(-1)?.at ?? null,
    days, competing, bookReadingDays14: days.filter((row) => row.book > 0).length,
    readingDays14: days.filter((row) => row.book + row.other > 0).length };
}

function bookMeans<T extends { bookId: string }>(rows: readonly T[], value: (row: T) => number): number[] {
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const group = groups.get(row.bookId) ?? [];
    group.push(value(row));
    groups.set(row.bookId, group);
  }
  return [...groups.values()].map(mean);
}

function remaining(row: ForecastReplayObservation, now: number) {
  return row.finishedAt !== null && row.finishedAt <= now ? (row.finishedAt - row.at) / DAY : Infinity;
}

function score(rows: ForecastReplayObservation[], now: number) {
  if (rows.length === 0) return null;
  const error = (row: ForecastReplayObservation, prediction: number) => Math.abs(Math.min(90, prediction) - Math.min(90, remaining(row, now)));
  return { books: new Set(rows.map((row) => row.bookId)).size, checkpoints: rows.length,
    selected: mean(bookMeans(rows, (row) => error(row, row.predictedDays))),
    baseline: mean(bookMeans(rows, (row) => error(row, row.baselineDays))),
    previous: mean(bookMeans(rows, (row) => error(row, row.previousDays ?? Infinity))),
    multiWindow: mean(bookMeans(rows, (row) => error(row, row.multiWindowDays ?? Infinity))),
    dateRate: mean(bookMeans(rows, (row) => Number(row.predictedDays <= FORECAST_HORIZON_DAYS))) };
}

// Fixed follow-up includes all open books, whether or not they later finish.
export function forecastBacktest(history: readonly ForecastReplayObservation[], now: number, rangeScale = FORECAST_RANGE_SCALE) {
  const evaluation = history.filter((row) => row.at >= FORECAST_HOLDOUT_START && row.at < now);
  const scorable = evaluation.filter((row) => now - row.at >= 90 * DAY);
  const completed = scorable.filter((row) => Number.isFinite(remaining(row, now))
    && Number.isFinite(row.predictedDays) && row.predictedDays <= FORECAST_HORIZON_DAYS);
  const errors = completed.map((row) => ({ ...row, actualDays: remaining(row, now),
    error: Math.abs(row.predictedDays - remaining(row, now)) })).sort((a, b) => b.error - a.error);
  const worst = [...new Map(errors.toReversed().map((row) => [row.bookId, row])).values()]
    .sort((a, b) => b.error - a.error).slice(0, 5);
  const intervals = scorable.filter((row) => row.predictedDays > 0 && row.predictedDays <= FORECAST_HORIZON_DAYS).flatMap((row) => {
    const calibration = calibrateForecast(history.filter((other) => other.bookId !== row.bookId), row.at, row.idleDays);
    if (calibration === null) return [];
    const lower = Math.min(row.predictedDays, Math.max(1, row.predictedDays) * calibration.lowerFactor / rangeScale);
    const rawUpper = Math.max(row.predictedDays, Math.max(1, row.predictedDays) * calibration.upperFactor * rangeScale);
    const upper = rawUpper <= FORECAST_HORIZON_DAYS ? rawUpper : Infinity;
    const actual = remaining(row, now);
    const cappedLower = Math.min(90, lower), cappedUpper = Math.min(90, rawUpper), cappedActual = Math.min(90, actual);
    return [{ bookId: row.bookId, actual, upper, covered: Number(actual >= lower && actual <= upper),
      cappedCovered: Number(cappedActual >= cappedLower && cappedActual <= cappedUpper),
      width: cappedUpper - cappedLower,
      intervalScore: cappedUpper - cappedLower + 10 * Math.max(0, cappedLower - cappedActual, cappedActual - cappedUpper) }];
  });
  const knownIntervals = intervals.filter((row) => Number.isFinite(row.actual));
  return {
    fullHistory: score(history.filter((row) => now - row.at >= 90 * DAY), now),
    overall: score(scorable, now), active: score(scorable.filter((row) => row.idleDays <= 7), now),
    quiet: score(scorable.filter((row) => row.idleDays > 7), now),
    parallel: score(scorable.filter((row) => row.activeBooks > 1), now),
    pending: evaluation.length - scorable.length,
    completedCheckpoints: completed.length, completedBooks: new Set(completed.map((row) => row.bookId)).size,
    uncappedError: completed.length === 0 ? null : mean(bookMeans(completed, (row) => Math.abs(row.predictedDays - remaining(row, now)))),
    intervalCheckpoints: knownIntervals.length, intervalBooks: new Set(knownIntervals.map((row) => row.bookId)).size,
    coverage: knownIntervals.length === 0 ? null : mean(bookMeans(knownIntervals, (row) => row.covered)),
    finiteUpperRate: intervals.length === 0 ? null : mean(intervals.map((row) => Number(Number.isFinite(row.upper)))),
    cappedCoverage: intervals.length === 0 ? null : mean(bookMeans(intervals, (row) => row.cappedCovered)),
    intervalScore: intervals.length === 0 ? null : mean(bookMeans(intervals, (row) => row.intervalScore)),
    intervalWidth: intervals.length === 0 ? null : mean(bookMeans(intervals, (row) => row.width)),
    cappedIntervalCheckpoints: intervals.length,
    worst,
  };
}

export interface ForecastWorkerResult {
  history: ForecastReplayObservation[];
  backtest: ReturnType<typeof forecastBacktest>;
}
