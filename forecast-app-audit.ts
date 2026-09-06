// Read-only parity audit: local snapshot and saved research predictions only.
// node forecast-app-audit.ts <snapshot> <email> <daily-predictions.jsonl> <output.json>
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { snapshotBooks, type DailySnapshot } from './forecast-daily-data.ts';
import { forecastHistoryFromInput, type ForecastHistoryInput } from './src/lib/utils/forecastHistory.ts';
import { forecastBacktest } from './src/lib/utils/forecastDiagnostics.ts';
import { calibrateForecast, FORECAST_RANGE_SCALE, FORECAST_DAY_MS as DAY } from './src/lib/utils/finishForecast.ts';

const [file, email, predictionsFile, output] = process.argv.slice(2);
assert.ok(file && email && predictionsFile && output);
const raw = readFileSync(file, 'utf8');
const snapshot: DailySnapshot = JSON.parse(raw);
const books = snapshotBooks(snapshot, email);
const now = Date.parse(snapshot.takenAt);
const input: ForecastHistoryInput = { now,
  books: books.map((b) => ({ id: b.id, pageCount: b.pageCount, currentPage: b.rows.at(-1)?.toPage ?? 0,
    finished: b.finishedAt !== null, finishedAt: b.finishedAt })),
  updates: books.flatMap((b) => b.rows.map((r) => ({ bookId: r.bookId, at: r.at, editedAt: r.editedAt,
    type: r.type, minutes: r.minutes, pages: r.pages, toPage: r.toPage }))),
};
const started = performance.now();
const history = forecastHistoryFromInput(input);
const expected = readFileSync(predictionsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
assert.equal(history.length, expected.length, 'Daily population must match the saved experiment');
const lookup = new Map(history.map((r) => [`${r.bookId}:${r.at}`, r]));
for (const { row, models } of expected) {
  const actual = lookup.get(`${row.bookId}:${row.at}`);
  assert.ok(actual);
  for (const [field, name] of [['predictedDays', 'blend-14-ungated'], ['multiWindowDays', 'median-windows'],
    ['previousDays', 'blend-14'], ['baselineDays', 'existing-30']] as const) {
    const value = models[name].days ?? Infinity;
    assert.ok(actual[field] === value || Math.abs(actual[field]! - value) < 1e-8,
      `${row.bookId}:${row.at} ${name}: ${actual[field]} vs ${value}`);
  }
}
// Pick interval widening using only 2024 origins with 90-day follow-up before
// 2025. Minimize the nominal 80% interval score; report coverage alongside it.
const validationEnd = Date.UTC(2025, 0, 1);
const validation = history.filter((r) => r.at >= Date.UTC(2024, 0, 1) && r.at <= validationEnd - 90 * DAY
  && r.predictedDays > 0 && r.predictedDays <= 365).flatMap((r) => {
  const c = calibrateForecast(history.filter((o) => o.bookId !== r.bookId), r.at, r.idleDays);
  return c ? [{ r, c }] : [];
});
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
const scales = [1, 1.5, 2, 3].map((scale) => {
  const groups = new Map<string, { loss: number; covered: number; width: number }[]>();
  for (const { r, c } of validation) {
    const lower = Math.min(90, r.predictedDays, Math.max(1, r.predictedDays) * c.lowerFactor / scale);
    const upper = Math.min(90, Math.max(r.predictedDays, Math.max(1, r.predictedDays) * c.upperFactor * scale));
    const actual = Math.min(90, r.finishedAt !== null && r.finishedAt <= validationEnd ? (r.finishedAt - r.at) / DAY : Infinity);
    const group = groups.get(r.bookId) ?? [];
    group.push({ width: upper - lower, loss: upper - lower + 10 * Math.max(0, lower - actual, actual - upper),
      covered: Number(actual >= lower && actual <= upper) });
    groups.set(r.bookId, group);
  }
  return { scale, books: groups.size, forecasts: validation.length,
    intervalScore: mean([...groups.values()].map((g) => mean(g.map((v) => v.loss)))),
    coverage: mean([...groups.values()].map((g) => mean(g.map((v) => v.covered)))),
    width: mean([...groups.values()].map((g) => mean(g.map((v) => v.width)))) };
});
const selectedScale = [...scales].sort((a, b) => a.intervalScore - b.intervalScore)[0].scale;
assert.equal(selectedScale, FORECAST_RANGE_SCALE, 'App must use the audited range scale');
const backtest = forecastBacktest(history, now, selectedScale);
const result = { sourceHash: createHash('sha256').update(raw).digest('hex'),
  codeHash: createHash('sha256').update(['forecast-app-audit.ts', 'src/lib/utils/finishForecast.ts',
    'src/lib/utils/forecastHistory.ts', 'src/lib/utils/forecastDiagnostics.ts'].map((path) => readFileSync(path, 'utf8')).join('\n')).digest('hex'),
  forecasts: history.length, parityComparisons: history.length * 4,
  selectedScale, intervalValidation: scales, elapsedSeconds: (performance.now() - started) / 1000, backtest };
writeFileSync(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, backtest: { full: backtest.fullHistory, recent: backtest.overall,
  intervalScore: backtest.intervalScore, coverage: backtest.cappedCoverage } }, null, 2));
