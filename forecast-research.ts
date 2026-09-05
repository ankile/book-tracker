// Offline only. Reads a local db-snapshot dump; never imports a database client.
// node forecast-research.ts <snapshot.json> <email> explore|final <output-dir>
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  FORECAST_DAY_MS as DAY,
  calibrateForecast, SELECTED_FORECAST, FORECAST_RANGE_SCALE,
  type ForecastBook, type ForecastFeatures, type ForecastReading,
} from './src/lib/utils/finishForecast.ts';

import { FORECAST_CANDIDATES, candidateDays, experimentalForecastFeatures, forecastRandom, quantile } from './forecast-candidates.ts';

interface Stamp { seconds: number; nanoseconds: number }
interface StoredBook extends Record<string, unknown> {
  title: string; pageCount: number; currentPage: number; finished: boolean;
  createdAt: Stamp; finishedAt: Stamp | null;
}
interface StoredUpdate extends Record<string, unknown> {
  type: 'reading' | 'update'; createdAt: Stamp; updatedAt: Stamp;
  fromPage: number; toPage: number; pagesRead: number; timeRead?: number;
}
interface Snapshot {
  takenAt: string; docCount: number;
  docs: { path: string; data: Record<string, unknown> }[];
}
interface Row extends ForecastReading { type: 'reading' | 'update'; from: number; to: number; editedAt: number }
interface History { id: string; title: string; pageCount: number; finishedAt: number | null; rows: Row[]; reliable: boolean }
interface Checkpoint {
  bookId: string; at: number; finishedAt: number | null; features: ForecastFeatures;
  predictions: Record<string, number>; session: boolean;
}

const [file, email, stage, outputDir] = process.argv.slice(2);
if (!file || !email || !outputDir || !['explore', 'final'].includes(stage)) {
  throw new Error('Usage: node forecast-research.ts <snapshot.json> <email> explore|final <output-dir>');
}
const contents = readFileSync(file, 'utf8');
const snapshot: Snapshot = JSON.parse(contents);
const user = snapshot.docs.find((doc) => /^users\/[^/]+$/.test(doc.path) && doc.data.email === email);
if (!user) throw new Error('Account not present in snapshot');
const ms = (stamp: Stamp): number => stamp.seconds * 1000 + stamp.nanoseconds / 1e6;
const histories: History[] = snapshot.docs.filter((doc) => doc.path.startsWith(`${user.path}/books/`) && doc.path.split('/').length === 4)
  .map((doc) => {
    const book = doc.data as StoredBook;
    assert.ok(Number.isFinite(book.pageCount) && book.pageCount > 0, `${doc.path}: pageCount`);
    const id = doc.path.split('/')[3];
    const rows: Row[] = snapshot.docs.filter((row) => row.path.startsWith(`${doc.path}/updates/`)).map((row) => {
      const data = row.data as StoredUpdate;
      assert.ok(data.type === 'reading' || data.type === 'update', `${row.path}: update type`);
      for (const value of [data.fromPage, data.toPage, data.pagesRead, ms(data.createdAt), ms(data.updatedAt)]) {
        assert.ok(Number.isFinite(value), `${row.path}: numeric history field`);
      }
      if (data.type === 'reading') assert.ok(Number.isFinite(data.timeRead), `${row.path}: reading minutes`);
      return { bookId: id, at: ms(data.createdAt), editedAt: ms(data.updatedAt), type: data.type,
        minutes: data.type === 'reading' ? data.timeRead! : 0, pages: data.pagesRead, from: data.fromPage, to: data.toPage };
    }).sort((a, b) => a.at - b.at);
    const finishedAt = book.finished ? ms(book.finishedAt!) : null;
    // A finish label needs an observed progress row that reaches the book's
    // length near the recorded finish. Books added already finished cannot
    // teach us how long completing them took.
    const finishRow = rows.findLast((row) => row.to === book.pageCount && row.pages > 0);
    const reliable = finishedAt === null || (finishRow !== undefined && Math.abs(finishRow.at - finishedAt) < DAY);
    return { id, title: book.title, pageCount: book.pageCount, rows, finishedAt, reliable };
  });
const allRows = histories.flatMap((book) => book.rows).sort((a, b) => a.at - b.at);
const readings = allRows.filter((row) => row.type === 'reading');
const takenAt = Date.parse(snapshot.takenAt);
const validationStart = Date.UTC(2024, 0, 1);
const testStart = Date.UTC(2025, 0, 1);
const end = stage === 'explore' ? testStart : takenAt;
const checkpoints: Checkpoint[] = [];
// One checkpoint per UTC week plus every session end. Weekly checkpoints
// make lack of activity visible instead of evaluating only when you read.
const origins = new Set<number>(readings.filter((row) => row.at < end).map((row) => row.at));
for (let at = Math.ceil(allRows[0].at / (7 * DAY)) * 7 * DAY; at < end; at += 7 * DAY) origins.add(at);
for (const at of [...origins].sort((a, b) => a - b)) {
  const visible = histories.map((book) => {
    // Current snapshot edits are not historical event versions. Omit rows
    // changed after this cutoff rather than leaking their corrected values.
    const past = book.rows.filter((row) => row.at <= at && row.editedAt <= at + 1000);
    const last = past.at(-1);
    return { history: book, past, book: { id: book.id, pageCount: book.pageCount,
      currentPage: last?.to ?? 0, finished: last?.to === book.pageCount } satisfies ForecastBook };
  }).filter((item) => item.past.length > 0);
  const pastReadings = readings.filter((row) => row.at <= at && row.editedAt <= at + 1000);
  for (const item of visible) {
    const { history, past, book } = item;
    if (!history.reliable || book.finished || (history.finishedAt !== null && history.finishedAt <= at)) continue;
    const isSession = past.at(-1)!.at === at && past.at(-1)!.type === 'reading';
    if (!isSession && at % (7 * DAY) !== 0) continue;
    const f = experimentalForecastFeatures(book, visible.map((item) => item.book), pastReadings, at);
    if (!f || f.readingDays < 2 || f.idleDays > 365) continue;
    const predictions = Object.fromEntries(FORECAST_CANDIDATES.map((candidate) => [candidate.name, candidateDays(f, candidate)]));
    // Reconstruct the exact existing baseline from prefix totals and all
    // activity rows, including corrections for its 60-day activity gate.
    const own = past.filter((row) => row.type === 'reading');
    const pages = own.reduce((sum, row) => sum + row.pages, 0);
    const minutes = own.reduce((sum, row) => sum + row.minutes, 0);
    const recentMinutes = pastReadings.filter((row) => at - row.at <= 30 * DAY).reduce((sum, row) => sum + row.minutes, 0);
    predictions['existing-30'] = at - past.at(-1)!.at <= 60 * DAY && pages > 0 && minutes > 0 && recentMinutes > 0
      ? (book.pageCount - book.currentPage) * minutes / pages / (recentMinutes / 30) : Infinity;
    checkpoints.push({ bookId: book.id, at, finishedAt: history.finishedAt, features: f, predictions, session: isSession });
  }
}

const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
function bookValues(rows: Checkpoint[], value: (row: Checkpoint) => number): number[] {
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const group = groups.get(row.bookId) ?? [];
    group.push(value(row)); groups.set(row.bookId, group);
  }
  return [...groups.values()].map(mean);
}
function remaining(row: Checkpoint, asOf: number): number {
  return row.finishedAt !== null && row.finishedAt <= asOf ? (row.finishedAt - row.at) / DAY : Infinity;
}
function scorable(rows: Checkpoint[], asOf: number): Checkpoint[] {
  return rows.filter((row) => remaining(row, asOf) < 90 || asOf - row.at >= 90 * DAY);
}
function errors(rows: Checkpoint[], model: string, asOf: number): number[] {
  return bookValues(rows, (row) => Math.abs(Math.min(90, row.predictions[model]) - Math.min(90, remaining(row, asOf))));
}
function scores(rows: Checkpoint[], asOf: number) {
  const eligible = scorable(rows, asOf);
  return FORECAST_CANDIDATES.map((model) => {
    const error = errors(eligible, model.name, asOf);
    const active = eligible.filter((row) => row.features.idleDays <= 7);
    const quiet = eligible.filter((row) => row.features.idleDays > 7);
    const parallel = eligible.filter((row) => row.features.activeBooks > 1);
    return { model: model.name, books: error.length, checkpoints: eligible.length,
      mae90: mean(error), medianBookMae90: quantile(error, 0.5),
      activeMae90: mean(errors(active, model.name, asOf)),
      quietMae90: mean(errors(quiet, model.name, asOf)),
      parallelMae90: mean(errors(parallel, model.name, asOf)),
      forecastRate: mean(bookValues(eligible, (row) => Number(Number.isFinite(row.predictions[model.name])))) };
  }).sort((a, b) => a.mae90 - b.mae90);
}

function intervalScores(rows: Checkpoint[], model: string, asOf: number, scale = 1) {
  const observations = checkpoints.map((row) => ({ bookId: row.bookId, at: row.at,
    finishedAt: row.finishedAt, predictedDays: row.predictions[model], idleDays: row.features.idleDays }));
  const evaluated = rows.filter((row) => Number.isFinite(row.predictions[model]) && row.predictions[model] <= 365).map((row) => {
    const calibration = calibrateForecast(observations.filter((obs) => obs.bookId !== row.bookId), row.at, row.features.idleDays);
    if (calibration === null) return null;
    const point = row.predictions[model];
    const lower = Math.min(point, Math.max(1, point) * calibration.lowerFactor / scale);
    const rawUpper = Math.max(point, Math.max(1, point) * calibration.upperFactor * scale);
    const upper = rawUpper > 365 ? Infinity : rawUpper;
    const actual = remaining(row, asOf);
    return { row, lower, upper, actual, covered: actual >= lower && actual <= upper };
  }).filter((row) => row !== null);
  const complete = evaluated.filter((row) => Number.isFinite(row.actual));
  const finite = complete.filter((row) => Number.isFinite(row.upper));
  const coverageGroups = new Map<string, number[]>();
  for (const row of complete) {
    const group = coverageGroups.get(row.row.bookId) ?? [];
    group.push(Number(row.covered)); coverageGroups.set(row.row.bookId, group);
  }
  return { scale, completedCheckpoints: complete.length, completedCoverage: mean(complete.map((row) => Number(row.covered))),
    bookWeightedCoverage: mean([...coverageGroups.values()].map(mean)),
    finiteUpperFraction: mean(evaluated.map((row) => Number(Number.isFinite(row.upper)))),
    medianFiniteWidth: finite.length > 0 ? quantile(finite.map((row) => row.upper - row.lower), .5) : null,
    nominalCoverage: .8 };
}

mkdirSync(outputDir, { recursive: true });
const validation = scores(checkpoints.filter((row) => row.at >= validationStart && row.at < testStart), testStart);
const selectionFile = resolve(outputDir, 'selection.json');
if (stage === 'explore') {
  const intervalValidation = [1, 1.5, 2, 3].map((scale) => intervalScores(checkpoints.filter((row) => row.at >= validationStart && row.at < testStart), validation[0].model, testStart, scale));
  const rangeScale = (intervalValidation.find((result) => result.bookWeightedCoverage >= .8) ?? intervalValidation.at(-1)!).scale;
  writeFileSync(selectionFile, JSON.stringify({ snapshotHash: createHash('sha256').update(contents).digest('hex'),
    testStart, validationStart, selected: validation[0].model, candidates: FORECAST_CANDIDATES,
    metric: 'Per-book mean absolute error in remaining days, capped at 90 days; censored outcomes scored only after sufficient follow-up',
    validation, rangeScale, intervalValidation }, null, 2));
  console.log(JSON.stringify({ stage, histories: histories.length, finished: histories.filter((h) => h.finishedAt !== null).length,
    unreliableLabels: histories.filter((h) => !h.reliable).length, rows: allRows.length, checkpoints: checkpoints.length, validation }, null, 2));
} else {
  const selection: { selected: string; snapshotHash: string; rangeScale: number } = JSON.parse(readFileSync(selectionFile, 'utf8'));
  if (selection.snapshotHash !== createHash('sha256').update(contents).digest('hex')) throw new Error('Snapshot changed after model selection');
  if (selection.selected !== SELECTED_FORECAST.name) throw new Error('App model differs from frozen selection');
  if (selection.rangeScale !== FORECAST_RANGE_SCALE) throw new Error('App range differs from frozen selection');
  const testRows = scorable(checkpoints.filter((row) => row.at >= testStart), takenAt);
  const testScores = scores(testRows, takenAt);
  const selectedErrors = errors(testRows, selection.selected, takenAt);
  const baselineErrors = errors(testRows, 'existing-30', takenAt);
  const differences = baselineErrors.map((value, i) => value - selectedErrors[i]);
  const random = forecastRandom(6541);
  const boot = Array.from({ length: 4000 }, () => mean(differences.map(() => differences[Math.floor(random() * differences.length)])));
  const observed = Math.abs(mean(differences));
  const permutations = Array.from({ length: 4000 }, () => Math.abs(mean(differences.map((value) => value * (random() < .5 ? -1 : 1)))));
  const finishedRows = testRows.filter((row) => Number.isFinite(remaining(row, takenAt)) && Number.isFinite(row.predictions[selection.selected]));
  const absolute = finishedRows.map((row) => Math.abs(row.predictions[selection.selected] - remaining(row, takenAt)));
  const result = { stage, selected: selection.selected, validation, testScores,
    pairedBookImprovement: { mean: mean(differences), interval95: [quantile(boot, .025), quantile(boot, .975)], books: differences.length,
      permutationP: (1 + permutations.filter((value) => value >= observed).length) / (1 + permutations.length) },
    intervals: intervalScores(testRows, selection.selected, takenAt, selection.rangeScale),
    uncappedCompletedErrors: { checkpoints: absolute.length, mean: mean(absolute), median: quantile(absolute, .5), p90: quantile(absolute, .9) },
    examples: [...finishedRows].sort((a, b) => Math.abs(b.predictions[selection.selected] - remaining(b, takenAt)) - Math.abs(a.predictions[selection.selected] - remaining(a, takenAt)))
      .filter((row, i, rows) => rows.findIndex((other) => other.bookId === row.bookId) === i).slice(0, 6)
      .map((row) => ({ book: histories.find((h) => h.id === row.bookId)!.title, predictedAt: new Date(row.at).toISOString(),
        predictedDays: row.predictions[selection.selected], actualDays: remaining(row, takenAt), idleDays: row.features.idleDays })),
    testStart: new Date(testStart).toISOString(), snapshot: snapshot.takenAt };
  writeFileSync(resolve(outputDir, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
// Private artifacts contain per-book history and must stay out of Git.
writeFileSync(resolve(outputDir, `${stage}-checkpoints.json`), JSON.stringify(checkpoints, (_, value: unknown) => value === Infinity ? null : value));
