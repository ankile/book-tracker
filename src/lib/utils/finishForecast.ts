import type { BookUpdateView } from '../interfaces/reading.ts';

export const FORECAST_DAY_MS = 86_400_000;
export const FORECAST_HORIZON_DAYS = 365;

export interface ForecastBook {
  id: string;
  currentPage: number;
  pageCount: number;
  finished: boolean;
}

export interface ForecastReading {
  bookId: string;
  at: number;
  minutes: number;
  pages: number;
}

export function forecastReadings(updates: readonly BookUpdateView[]): ForecastReading[] {
  return updates.filter((row) => row.type === 'reading').map((row) => ({
    bookId: row.book.id,
    at: row.createdAt.toDate().getTime(),
    minutes: row.type === 'reading' ? row.timeRead : 0,
    pages: row.pagesRead,
  }));
}

export interface ForecastFeatures {
  remainingMinutes: number;
  remainingPages: number;
  idleDays: number;
  ageDays: number;
  readingDays: number;
  bookId: string;
  rates: Record<number, { user: number; book: number; share: number; activeShare: number }>;
  activeBooks: number;
  resumeRate: number;
}

export const FORECAST_WINDOWS = [7, 14, 30, 60, 90] as const;

// All rates include days with no reading. The fixed 24-hour buckets end at
// the forecast instant; rendering calendar dates happens in the user's zone.
export function forecastFeatures(
  book: ForecastBook,
  books: readonly ForecastBook[],
  readings: readonly ForecastReading[],
  now: number,
): ForecastFeatures | null {
  const past = readings.filter((row) => row.at <= now && row.minutes > 0 && row.pages >= 0);
  const own = past.filter((row) => row.bookId === book.id).sort((a, b) => a.at - b.at);
  if (book.finished || book.currentPage >= book.pageCount || own.length === 0) return null;
  const speedRows = own.filter((row) => row.minutes >= 5 && row.pages / row.minutes <= 2.5);
  const speedPages = speedRows.reduce((sum, row) => sum + row.pages, 0);
  const speedMinutes = speedRows.reduce((sum, row) => sum + row.minutes, 0);
  if (speedPages <= 0 || speedMinutes <= 0) return null;
  const remainingPages = Math.max(0, book.pageCount - book.currentPage);
  const first = own[0].at;
  const ageDays = Math.max(1, (now - first) / FORECAST_DAY_MS);
  const idleDays = (now - own[own.length - 1].at) / FORECAST_DAY_MS;
  const activeIds = new Set(books.filter((b) => !b.finished && b.currentPage < b.pageCount).map((b) => b.id));
  const activeBooks = new Set(past.filter((r) => activeIds.has(r.bookId) && now - r.at < 30 * FORECAST_DAY_MS).map((r) => r.bookId)).size;
  const rates: ForecastFeatures['rates'] = {};
  for (const window of FORECAST_WINDOWS) {
    const recent = past.filter((row) => now - row.at < window * FORECAST_DAY_MS);
    const total = recent.reduce((sum, row) => sum + row.minutes, 0);
    const ownMinutes = recent.filter((row) => row.bookId === book.id).reduce((sum, row) => sum + row.minutes, 0);
    const activeMinutes = recent.filter((row) => activeIds.has(row.bookId)).reduce((sum, row) => sum + row.minutes, 0);
    rates[window] = {
      user: total / window,
      book: ownMinutes / Math.min(window, ageDays),
      share: total > 0 ? ownMinutes / total : 0,
      activeShare: activeMinutes > 0 ? ownMinutes / activeMinutes : 0,
    };
  }
  const lastAt = own[own.length - 1].at;
  const resumeMinutes = own.filter((row) => lastAt - row.at < 14 * FORECAST_DAY_MS).reduce((sum, row) => sum + row.minutes, 0);
  return {
    bookId: book.id,
    remainingPages,
    remainingMinutes: remainingPages * speedMinutes / speedPages,
    idleDays, ageDays, rates, activeBooks,
    readingDays: new Set(own.map((row) => Math.floor((now - row.at) / FORECAST_DAY_MS))).size,
    resumeRate: resumeMinutes / Math.max(1, Math.min(14, (lastAt - first) / FORECAST_DAY_MS)),
  };
}

// Selected on the 2024 validation period before opening the 2025+ holdout.
export const SELECTED_FORECAST = { name: 'blend-14', kind: 'blend', window: 14 } as const;
export const FORECAST_RANGE_SCALE = 3;

export function selectedForecastDays(features: ForecastFeatures): number {
  const rate = features.rates[SELECTED_FORECAST.window];
  const daily = Math.sqrt(rate.book * rate.user);
  return daily > 0 ? features.remainingMinutes / daily : Infinity;
}

export interface ForecastObservation {
  bookId: string;
  at: number;
  predictedDays: number;
  finishedAt: number | null;
  idleDays: number;
}

export interface ForecastCalibration {
  lowerFactor: number;
  upperFactor: number;
  books: number;
}

// Equal total weight per book prevents a long, frequently logged book from
// dominating the uncertainty estimate. Unfinished books contribute censored
// lower bounds. See docs/finish-forecast.md for the coverage limitations.
export function calibrateForecast(
  observations: readonly ForecastObservation[], now: number, idleDays: number,
): ForecastCalibration | null {
  const usable = observations.filter((row) => row.at < now && Number.isFinite(row.predictedDays) && row.predictedDays > 0
    && (row.idleDays > 7) === (idleDays > 7));
  const counts = new Map<string, number>();
  for (const row of usable) counts.set(row.bookId, (counts.get(row.bookId) ?? 0) + 1);
  if (counts.size < 12) return null;
  const values = usable.map((row) => ({
    ratio: ((row.finishedAt !== null && row.finishedAt <= now ? row.finishedAt : now) - row.at)
      / FORECAST_DAY_MS / Math.max(1, row.predictedDays),
    event: row.finishedAt !== null && row.finishedAt <= now,
    weight: 1 / counts.get(row.bookId)!,
  })).filter((row) => row.ratio >= 0).sort((a, b) => a.ratio - b.ratio);
  let risk = values.reduce((sum, row) => sum + row.weight, 0);
  let survival = 1;
  let lowerFactor = Infinity;
  let upperFactor = Infinity;
  for (let i = 0; i < values.length;) {
    const ratio = values[i].ratio;
    let j = i;
    let events = 0;
    let removed = 0;
    while (j < values.length && values[j].ratio === ratio) {
      removed += values[j].weight;
      if (values[j].event) events += values[j].weight;
      j += 1;
    }
    survival *= Math.max(0, 1 - events / risk);
    if (survival <= .9 && lowerFactor === Infinity) lowerFactor = ratio;
    if (survival <= .1 && upperFactor === Infinity) upperFactor = ratio;
    risk -= removed;
    i = j;
  }
  return { lowerFactor, upperFactor, books: counts.size };
}

export interface FinishForecast {
  status: 'estimated' | 'inactive' | 'insufficient' | 'beyond-horizon';
  days: number | null;
  lowerDays: number | null;
  upperDays: number | null;
  features: ForecastFeatures | null;
  calibrationBooks: number;
}

export function finishForecast(
  book: ForecastBook, books: readonly ForecastBook[], readings: readonly ForecastReading[],
  now: number, observations: readonly ForecastObservation[] = [],
): FinishForecast {
  const features = forecastFeatures(book, books, readings, now);
  const empty = { days: null, lowerDays: null, upperDays: null, features, calibrationBooks: 0 };
  if (!features || features.readingDays < 2) return { ...empty, status: 'insufficient' };
  const days = selectedForecastDays(features);
  if (!Number.isFinite(days)) return { ...empty, status: 'inactive' };
  if (days > FORECAST_HORIZON_DAYS) return { ...empty, status: 'beyond-horizon' };
  const calibration = calibrateForecast(observations.filter((row) => row.bookId !== book.id), now, features.idleDays);
  const lower = calibration === null ? null : Math.min(days, Math.max(0, Math.max(1, days) * calibration.lowerFactor / FORECAST_RANGE_SCALE));
  const upper = calibration === null ? null : Math.max(days, Math.max(1, days) * calibration.upperFactor * FORECAST_RANGE_SCALE);
  return { status: 'estimated', days,
    lowerDays: lower !== null && Number.isFinite(lower) ? lower : null,
    upperDays: upper !== null && upper <= FORECAST_HORIZON_DAYS ? upper : null,
    features, calibrationBooks: calibration?.books ?? 0 };
}

export function forecastDate(now: Date, days: number): Date {
  return new Date(now.getTime() + days * FORECAST_DAY_MS);
}
