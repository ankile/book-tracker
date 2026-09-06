import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FORECAST_DAY_MS as DAY, selectedForecastDays, calibrateForecast,
  finishForecast, forecastFeatures, forecastReadings, multiWindowForecastDays,
  type ForecastBook, type ForecastReading,
} from '../src/lib/utils/finishForecast.ts';
import { buildForecastHistory } from '../src/lib/utils/forecastHistory.ts';
import { projectedFinishes } from '../src/lib/utils/sessions.ts';
import { readingEvidence, forecastBacktest } from '../src/lib/utils/forecastDiagnostics.ts';
import { forecastHistogram } from '../src/lib/utils/forecastDistribution.ts';
import { readingSummary } from '../src/lib/utils/readingSummary.ts';

import { conditionalResumeDays } from '../forecast-candidates.ts';

const now = Date.UTC(2026, 8, 5, 12);
const book: ForecastBook = { id: 'a', currentPage: 40, pageCount: 200, finished: false };
const readings: ForecastReading[] = [
  { bookId: 'a', at: now - 10 * DAY, minutes: 30, pages: 20 },
  { bookId: 'a', at: now - 2 * DAY, minutes: 30, pages: 20 },
];
const stamp = (at: number) => ({ toDate: () => new Date(at) });

test('forecasts use only prior sessions and stay deterministic', () => {
  const future = { bookId: 'a', at: now + DAY, minutes: 500, pages: 1000 };
  const original = finishForecast(book, [book], readings, now);
  assert.equal(original.status, 'estimated');
  assert.deepEqual(finishForecast(book, [book], [...readings, future], now), original);
  assert.equal(original.days, selectedForecastDays(forecastFeatures(book, [book], readings, now)!));
});

test('a competing book does not give this book the entire combined reading budget', () => {
  const second = { ...book, id: 'b' };
  const parallel = [...readings, ...readings.map((row) => ({ ...row, bookId: 'b' }))];
  const features = forecastFeatures(book, [book, second], parallel, now)!;
  const days = selectedForecastDays(features);
  assert.ok(days > features.remainingMinutes / features.rates[14].user);
  assert.equal(features.activeBooks, 2);
});

test('zero-reading days slow the forecast and a long pause does not invent a return date', () => {
  const recent = finishForecast(book, [book], readings, now);
  const quiet = finishForecast(book, [book], readings, now + DAY);
  assert.ok(quiet.days! > recent.days!);
  const paused = finishForecast(book, [book], readings, now + 30 * DAY);
  assert.equal(paused.status, 'inactive');
  assert.equal(paused.days, null);
  assert.ok(paused.features!.resumeRate > 0);
});

test('unstarted books need a session; first-day forecasts use explicit speed priors', () => {
  assert.equal(finishForecast(book, [book], [], now).status, 'insufficient');
  const first = finishForecast(book, [book], readings.slice(0, 1), now);
  assert.equal(first.status, 'estimated');
  assert.equal(first.features!.speedSource, 'book');
  const noPages = readings.map((r) => ({ ...r, pages: 0 }));
  const defaultSpeed = finishForecast(book, [book], noPages, now);
  assert.equal(defaultSpeed.features!.speedSource, 'default');
  assert.equal(defaultSpeed.features!.remainingMinutes, 320);
  const librarySpeed = finishForecast(book, [book], [...noPages, { bookId: 'b', at: now - DAY, minutes: 30, pages: 20 }], now);
  assert.equal(librarySpeed.features!.speedSource, 'library');
  assert.equal(librarySpeed.features!.remainingMinutes, 720); // 90 total minutes / 20 pages, including zero-page sessions
  assert.equal(finishForecast({ ...book, finished: true }, [book], readings, now).days, null);
});

test('page corrections set remaining progress but do not masquerade as reading', () => {
  const updates = readings.map((row) => ({ book: { id: row.bookId }, type: 'reading' as const,
    createdAt: stamp(row.at), pagesRead: row.pages, timeRead: row.minutes }));
  const corrected = [...updates, { book: { id: 'a' }, type: 'update' as const, createdAt: stamp(now), pagesRead: 100 }];
  assert.deepEqual(forecastReadings(corrected), readings);
  assert.ok(finishForecast({ ...book, currentPage: 140 }, [book], forecastReadings(corrected), now).days!
    < finishForecast(book, [book], readings, now).days!);
});

test('ongoing gaps are censored, not observed resumptions', () => {
  assert.equal(conditionalResumeDays(Array.from({ length: 6 }, () => ({ days: 100, resumed: false })), 10), Infinity);
  assert.equal(conditionalResumeDays(Array.from({ length: 6 }, () => ({ days: 100, resumed: true })), 10), 90);
});

test('calibration cannot learn a future completion, and censored books can leave the upper bound unknown', () => {
  const observations = Array.from({ length: 12 }, (_, i) => ({ bookId: `${i}`, at: now - DAY,
    predictedDays: 10, finishedAt: now + 5 * DAY, idleDays: 0 }));
  const first = calibrateForecast(observations, now, 0)!;
  assert.equal(first.upperFactor, Infinity);
  assert.deepEqual(calibrateForecast(observations.map((row) => ({ ...row, finishedAt: now + 100 * DAY })), now, 0), first);
  assert.equal(calibrateForecast(observations.slice(0, 3), now, 0), null);
});

test('history replay uses prefix progress and never the completed book totals', () => {
  const start = Date.UTC(2025, 0, 1, 12);
  const updates = [0, 2, 4].map((day, i) => ({ book: { id: 'a' }, createdAt: stamp(start + day * DAY),
    updatedAt: stamp(start + day * DAY), type: 'reading' as const, pagesRead: i === 2 ? 60 : 20,
    timeRead: i === 2 ? 60 : 20, toPage: i === 2 ? 100 : (i + 1) * 20 }));
  const finished = { ...book, currentPage: 100, pageCount: 100, finished: true, finishedAt: stamp(start + 4 * DAY) };
  const history = buildForecastHistory([finished], updates, start + 5 * DAY);
  assert.ok(history.some((row) => row.at === start + 2.5 * DAY && row.predictedDays > 0));
  const before = buildForecastHistory([{ ...finished, finished: false, currentPage: 40, finishedAt: null }], updates.slice(0, 2), start + 3 * DAY);
  assert.equal(history.find((row) => row.at === start + 2.5 * DAY)!.predictedDays,
    before.find((row) => row.at === start + 2.5 * DAY)!.predictedDays);
});

test('multi-window estimate includes a quiet seven-day window without dropping its other evidence', () => {
  const features = forecastFeatures(book, [book], readings, now + 6 * DAY)!;
  assert.equal(features.rates[7].book, 0);
  assert.equal(selectedForecastDays(features), 112);
  assert.ok(Number.isFinite(multiWindowForecastDays(features)));
  assert.equal(multiWindowForecastDays(features), (112 + 240 / Math.sqrt(3.75)) / 2);
  const paused = forecastFeatures(book, [book], readings, now + 15 * DAY)!;
  assert.equal(multiWindowForecastDays(paused), Infinity);
});

test('daily replay keeps first-day and long-idle books and ignores edits not yet visible', () => {
  const start = Date.UTC(2023, 0, 1, 12);
  const updates = [{ book: { id: 'a' }, createdAt: stamp(start), updatedAt: stamp(start),
    type: 'reading' as const, pagesRead: 20, timeRead: 30, toPage: 20 }];
  const history = buildForecastHistory([{ ...book, finishedAt: null }], updates, start + 400 * DAY);
  assert.equal(history.length, 400);
  assert.ok(Number.isFinite(history[0].predictedDays));
  assert.equal(history[0].previousDays, Infinity);
  assert.equal(history.at(-1)!.predictedDays, Infinity);
  const edited = buildForecastHistory([{ ...book, finishedAt: null }],
    updates.map((row) => ({ ...row, updatedAt: stamp(start + 2 * DAY) })), start + 3 * DAY);
  assert.equal(edited.length, 1);
  assert.equal(edited[0].at, start + 2.5 * DAY);
});

test('fixed follow-up never cherry-picks recently completed books into the main score', () => {
  const fresh = { bookId: 'fast', at: now - 10 * DAY, finishedAt: now - DAY,
    predictedDays: 8, baselineDays: 5, idleDays: 0, activeBooks: 1 };
  const result = forecastBacktest([fresh, { ...fresh, bookId: 'ongoing', finishedAt: null }], now);
  assert.equal(result.overall, null);
  assert.equal(result.pending, 2);
  assert.equal(result.uncappedError, null);
});

test('dashboard and modal use the same forecast date', () => {
  const updates = readings.map((row) => ({ book: { id: row.bookId }, type: 'reading' as const,
    createdAt: stamp(row.at), pagesRead: row.pages, timeRead: row.minutes }));
  const books = [{ ...book, title: 'A', pagesRead: 40, timeRead: 60 }];
  const projection = projectedFinishes(books, new Map(), updates, new Date(now))[0];
  assert.equal(projection.projectedDate!.getTime(), Math.trunc(now + finishForecast(book, books, readings, now).days! * DAY));
});

test('reading evidence reconciles rolling daily bars, speed filters, and competing books', () => {
  const sessions = [...readings,
    { bookId: 'a', at: now - DAY, minutes: 2, pages: 1 },
    { bookId: 'a', at: now - DAY / 2, minutes: 10, pages: 30 },
    { bookId: 'b', at: now - 3 * DAY, minutes: 45, pages: 20 },
    { bookId: 'b', at: now + DAY, minutes: 1000, pages: 1000 },
    { bookId: 'b', at: now - 14 * DAY, minutes: 40, pages: 20 }];
  const facts = readingEvidence(book, sessions, now);
  const features = forecastFeatures(book, [book], sessions, now)!;
  assert.equal(facts.sessions, 4);
  assert.equal(facts.speedSessions, 2);
  assert.equal(features.remainingMinutes, features.remainingPages * facts.speedMinutes / facts.speedPages);
  assert.equal(facts.days.reduce((sum, row) => sum + row.book + row.other, 0), features.rates[14].user * 14);
  assert.equal(facts.competing.find((row) => row.bookId === 'b')!.minutes14, 45);
  assert.equal(facts.competing.find((row) => row.bookId === 'b')!.minutes30, 85);
});

test('backtest weights books equally and waits for unfinished outcomes to be scorable', () => {
  const row = { bookId: 'a', at: now - 100 * DAY, finishedAt: now - 90 * DAY,
    predictedDays: 8, baselineDays: 5, idleDays: 0, activeBooks: 2 };
  const history = [row, { ...row, at: row.at + DAY, predictedDays: 7, baselineDays: 4 },
    { ...row, bookId: 'b', predictedDays: Infinity, baselineDays: 30, finishedAt: null, idleDays: 20 },
    { ...row, bookId: 'c', at: now - DAY, finishedAt: null },
    { ...row, bookId: 'future', at: now + DAY },
    { ...row, bookId: 'validation', at: Date.UTC(2024, 0, 1), finishedAt: Date.UTC(2024, 0, 10) }];
  const result = forecastBacktest(history, now);
  assert.equal(result.overall!.books, 2);
  assert.equal(result.overall!.checkpoints, 3);
  assert.equal(result.overall!.selected, 1); // (mean(2, 2) + 0) / 2
  assert.equal(result.overall!.baseline, 32.5); // (mean(5, 5) + 60) / 2
  assert.equal(result.overall!.dateRate, .5);
  assert.equal(result.pending, 1);
  assert.equal(result.worst.length, 1);
  assert.equal(result.uncappedError, 2);
  assert.equal(result.coverage, null);
  const laterFinish = history.map((item) => item.bookId === 'c' ? { ...item, finishedAt: now + 20 * DAY } : item);
  assert.deepEqual(forecastBacktest(laterFinish, now), result);
});

test('calibration exposes completed and censored evidence without changing its factors', () => {
  const observations = Array.from({ length: 12 }, (_, i) => ({ bookId: `${i}`, at: now - 20 * DAY,
    predictedDays: 10, finishedAt: i < 10 ? now - 10 * DAY : null, idleDays: 0 }));
  const result = calibrateForecast(observations, now, 0)!;
  assert.equal(result.books, 12);
  assert.equal(result.checkpoints, 12);
  assert.equal(result.completedCheckpoints, 10);
  assert.equal(result.completedBooks, 10);
  assert.equal(result.lowerFactor, 1);
  assert.equal(result.upperFactor, Infinity);
});

test('histogram preserves Kaplan-Meier event mass, censored tail and original quantiles', () => {
  const observations = Array.from({ length: 12 }, (_, i) => ({ bookId: `${i}`, at: now - 100 * DAY,
    predictedDays: 10, finishedAt: i < 9 ? now - (90 - i * 10) * DAY : null, idleDays: 0 }));
  const basic = calibrateForecast(observations, now, 0)!;
  const full = calibrateForecast(observations, now, 0, true)!;
  assert.equal(full.lowerFactor, basic.lowerFactor);
  assert.equal(full.upperFactor, basic.upperFactor);
  assert.equal(full.distribution!.length, 9);
  assert.ok(Math.abs(full.unresolvedMass - .25) < 1e-12);
  const histogram = forecastHistogram(full, 20);
  assert.equal(histogram.maxDays, 180);
  assert.ok(Math.abs(histogram.bins.reduce((sum, bin) => sum + bin.mass, 0) + full.unresolvedMass - 1) < 1e-12);
  assert.ok(histogram.bins.at(-1)!.mass > 0, 'Largest observation belongs in the last bin');
  const duplicate = calibrateForecast([...observations, observations[0]], now, 0, true)!;
  assert.deepEqual(duplicate.distribution, full.distribution, 'Repeating a book does not increase its total weight');
});

test('fully censored calibration cannot invent finite completion mass', () => {
  const observations = Array.from({ length: 12 }, (_, i) => ({ bookId: `${i}`, at: now - DAY,
    predictedDays: 10, finishedAt: null, idleDays: 0 }));
  const full = calibrateForecast(observations, now, 0, true)!;
  assert.deepEqual(full.distribution, []);
  assert.equal(full.unresolvedMass, 1);
  assert.equal(full.upperFactor, Infinity);
});

test('reading summary weights pages, includes holds and identifies unknown remaining time', () => {
  const summary = readingSummary([
    { currentPage: 50, pageCount: 100, pagesRead: 50, timeRead: 100 },
    { currentPage: 100, pageCount: 900, pagesRead: 100, timeRead: 150 },
    { currentPage: 0, pageCount: 100, pagesRead: 0, timeRead: 0 },
  ]);
  assert.equal(summary.count, 3);
  assert.equal(summary.completion, 150 / 1100 * 100);
  assert.equal(summary.pagesLeft, 950);
  assert.equal(summary.minutesRead, 250);
  assert.equal(summary.minutesLeft, 1300);
  assert.equal(summary.unknownBooks, 1);
  assert.equal(readingSummary([]).completion, 0);
  assert.equal(readingSummary([{ currentPage: 100, pageCount: 100, pagesRead: 0, timeRead: 0 }]).unknownBooks, 0);
});
