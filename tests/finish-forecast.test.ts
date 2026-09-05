import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FORECAST_DAY_MS as DAY, selectedForecastDays, calibrateForecast,
  finishForecast, forecastFeatures, forecastReadings,
  type ForecastBook, type ForecastReading,
} from '../src/lib/utils/finishForecast.ts';
import { buildForecastHistory } from '../src/lib/utils/forecastHistory.ts';
import { projectedFinishes } from '../src/lib/utils/sessions.ts';

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

test('new books, single-day history and zero progress have no invented date', () => {
  assert.equal(finishForecast(book, [book], [], now).status, 'insufficient');
  assert.equal(finishForecast(book, [book], readings.slice(0, 1), now).status, 'insufficient');
  assert.equal(finishForecast(book, [book], readings.map((r) => ({ ...r, pages: 0 })), now).status, 'insufficient');
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
  assert.ok(history.some((row) => row.at === start + 2 * DAY && row.predictedDays > 0));
  const before = buildForecastHistory([{ ...finished, finished: false, currentPage: 40, finishedAt: null }], updates.slice(0, 2), start + 3 * DAY);
  assert.equal(history.find((row) => row.at === start + 2 * DAY)!.predictedDays,
    before.find((row) => row.at === start + 2 * DAY)!.predictedDays);
});

test('dashboard and modal use the same forecast date', () => {
  const updates = readings.map((row) => ({ book: { id: row.bookId }, type: 'reading' as const,
    createdAt: stamp(row.at), pagesRead: row.pages, timeRead: row.minutes }));
  const books = [{ ...book, title: 'A', pagesRead: 40, timeRead: 60 }];
  const projection = projectedFinishes(books, new Map(), updates, new Date(now))[0];
  assert.equal(projection.projectedDate!.getTime(), Math.trunc(now + finishForecast(book, books, readings, now).days! * DAY));
});
