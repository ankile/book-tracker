import assert from 'node:assert/strict';
import test from 'node:test';
import { readingSummary } from '../src/lib/utils/readingSummary.ts';

const timed = (id: string, currentPage: number, pageCount: number, pagesRead: number, timeRead: number) => ({
  id, authorIds: [`author-${id}`], fiction: null, currentPage, pageCount, pagesRead, timeRead,
});

test('reading summary weights pages, includes holds and identifies unknown remaining time', () => {
  const books = [
    timed('a', 50, 100, 50, 100),
    timed('b', 100, 900, 100, 150),
    { ...timed('c', 0, 100, 0, 0), authorIds: ['author-nobody'] },
  ];
  // With no library beyond these books the unread one borrows the pooled
  // pace of the other two: 250 minutes over 150 pages.
  const summary = readingSummary(books);
  assert.equal(summary.count, 3);
  assert.equal(summary.completion, 150 / 1100 * 100);
  assert.equal(summary.pagesLeft, 950);
  assert.equal(summary.minutesRead, 250);
  assert.equal(summary.minutesLeft, 1300 + 100 * 250 / 150);
  assert.equal(summary.unknownBooks, 0);
  assert.equal(summary.borrowedBooks, 1);
  // A library with nothing timed leaves it unknown and out of the total.
  const alone = readingSummary([books[2]], [books[2]]);
  assert.equal(alone.minutesLeft, 0);
  assert.equal(alone.unknownBooks, 1);
  assert.equal(alone.borrowedBooks, 0);
  assert.equal(readingSummary([]).completion, 0);
  assert.equal(readingSummary([timed('done', 100, 100, 0, 0)]).unknownBooks, 0);
});
