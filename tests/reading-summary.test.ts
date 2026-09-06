import assert from 'node:assert/strict';
import test from 'node:test';
import { readingSummary } from '../src/lib/utils/readingSummary.ts';

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
