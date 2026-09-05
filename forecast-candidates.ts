// Offline experiment candidates. Only the selected predictor is shipped to browsers.
import { FORECAST_DAY_MS, FORECAST_HORIZON_DAYS, FORECAST_WINDOWS, forecastFeatures, type ForecastBook, type ForecastFeatures, type ForecastReading } from './src/lib/utils/finishForecast.ts';

export interface ReadingGap { days: number; resumed: boolean }

// Kaplan-Meier conditional median. An ongoing pause is censored evidence,
// never an observed return. Infinity means the observed curve has not
// identified a median, not that the reader will never return.
export function conditionalResumeDays(gaps: readonly ReadingGap[], idle: number): number {
  const eligible = gaps.filter((gap) => gap.days > idle).sort((a, b) => a.days - b.days);
  if (eligible.length < 5) return Infinity;
  let survival = 1;
  for (let i = 0; i < eligible.length;) {
    const time = eligible[i].days;
    let j = i;
    let events = 0;
    while (j < eligible.length && eligible[j].days === time) {
      if (eligible[j].resumed) events += 1;
      j += 1;
    }
    survival *= 1 - events / (eligible.length - i);
    if (survival <= .5) return time - idle;
    i = j;
  }
  return Infinity;
}

export interface ExperimentalForecastFeatures extends ForecastFeatures {
  dailyMinutes: number[];
  resumeWait: number;
  lifetimeRate: number;
}

export function experimentalForecastFeatures(book: ForecastBook, books: readonly ForecastBook[], readings: readonly ForecastReading[], now: number): ExperimentalForecastFeatures | null {
  const features = forecastFeatures(book, books, readings, now);
  if (features === null) return null;
  const past = readings.filter((row) => row.at <= now && row.minutes > 0 && row.pages >= 0);
  const own = past.filter((row) => row.bookId === book.id);
  const activeIds = new Set(books.filter((b) => !b.finished && b.currentPage < b.pageCount).map((b) => b.id));
  const dailyMinutes = Array.from({ length: 30 }, (_, i) => past
    .filter((row) => now - row.at >= i * FORECAST_DAY_MS && now - row.at < (i + 1) * FORECAST_DAY_MS)
    .reduce((sum, row) => sum + row.minutes, 0));
  const byBook = new Map<string, ForecastReading[]>();
  for (const row of past) {
    const group = byBook.get(row.bookId) ?? [];
    group.push(row); byBook.set(row.bookId, group);
  }
  const gaps: ReadingGap[] = [];
  for (const [id, group] of byBook) {
    group.sort((a, b) => a.at - b.at);
    for (let i = 1; i < group.length; i += 1) {
      const days = (group[i].at - group[i - 1].at) / FORECAST_DAY_MS;
      if (days >= 1) gaps.push({ days, resumed: true });
    }
    if (activeIds.has(id)) gaps.push({ days: (now - group[group.length - 1].at) / FORECAST_DAY_MS, resumed: false });
  }
  return { ...features, dailyMinutes,
    lifetimeRate: own.reduce((sum, row) => sum + row.minutes, 0) / features.ageDays,
    resumeWait: features.idleDays < 1 ? 0 : conditionalResumeDays(gaps, features.idleDays) };
}

export interface ForecastCandidate {
  name: string;
  kind: 'baseline' | 'book' | 'allocated' | 'blend' | 'lifetime' | 'simulation' | 'renewal';
  window: number;
  sharePower?: number;
}

export const FORECAST_CANDIDATES: ForecastCandidate[] = [
  { name: 'existing-30', kind: 'baseline', window: 30 },
  ...FORECAST_WINDOWS.map((window): ForecastCandidate => ({ name: `book-${window}`, kind: 'book', window })),
  { name: 'lifetime', kind: 'lifetime', window: 30 },
  ...[14, 30, 60].flatMap((window) => [0.5, 1].map((sharePower): ForecastCandidate => ({
    name: `allocated-${window}-${sharePower}`, kind: 'allocated', window, sharePower,
  }))),
  ...[14, 30, 60].map((window): ForecastCandidate => ({ name: `blend-${window}`, kind: 'blend', window })),
  { name: 'simulation-30', kind: 'simulation', window: 30, sharePower: 0.5 },
  { name: 'renewal', kind: 'renewal', window: 14 },
  { name: 'renewal-after-7', kind: 'renewal', window: 30 },
];

export function forecastRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function quantile(values: readonly number[], probability: number): number {
  if (values.length === 0) throw new Error('Cannot take a quantile of no values');
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor((ordered.length - 1) * probability)];
}

export function candidateDays(features: ExperimentalForecastFeatures, candidate: ForecastCandidate): number {
  const rate = features.rates[candidate.window];
  if (candidate.kind === 'renewal') {
    if (candidate.window === 30 && features.idleDays <= 7) {
      const daily = Math.sqrt(features.rates[14].book * features.rates[14].user);
      return daily > 0 ? features.remainingMinutes / daily : Infinity;
    }
    return features.resumeWait + features.remainingMinutes / features.resumeRate;
  }
  if (candidate.kind === 'baseline') {
    return features.idleDays > 60 || rate.user <= 0 ? Infinity : features.remainingMinutes / rate.user;
  }
  if (candidate.kind === 'simulation') {
    const share = Math.sqrt(rate.activeShare);
    if (share === 0 || rate.user === 0) return Infinity;
    const random = forecastRandom(1847);
    const results: number[] = [];
    for (let draw = 0; draw < 128; draw += 1) {
      let remaining = features.remainingMinutes;
      let day = 0;
      while (remaining > 0 && day < FORECAST_HORIZON_DAYS) {
        // One book gets this day's available reading time. Zero-reading
        // days and competing books both consume calendar time.
        const minutes = features.dailyMinutes[Math.floor(random() * features.dailyMinutes.length)];
        if (random() < share) remaining -= minutes;
        day += 1;
      }
      results.push(remaining > 0 ? Infinity : day);
    }
    return quantile(results, 0.5);
  }
  const daily = candidate.kind === 'book' ? rate.book
    : candidate.kind === 'lifetime' ? features.lifetimeRate
      : candidate.kind === 'blend' ? Math.sqrt(rate.book * rate.user)
        : rate.user * rate.activeShare ** (candidate.sharePower ?? 1);
  return daily > 0 ? features.remainingMinutes / daily : Infinity;
}

