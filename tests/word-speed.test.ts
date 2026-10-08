import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeEditionWordEstimate } from '../src/lib/firebase/decoders.ts';
import type { EditionWordEstimate } from '../src/lib/interfaces/catalog.ts';
import {
  bookWordsPerMinute,
  measuredBookSpeeds,
  pooledWordsPerMinute,
  speedEditionIds,
  type WordSpeedBook,
} from '../src/lib/utils/wordSpeed.ts';

// The two estimates Word Counter sent first (prod, 2026-10-08), as the
// statistics read them.
const wiseMansFear: EditionWordEstimate = {
  pageCountBasis: 1108, wordsPerPage: 381.7, wordsPerPageLow: 330.4, wordsPerPageHigh: 433.1,
};
const godTest: EditionWordEstimate = {
  pageCountBasis: 329, wordsPerPage: 295.7, wordsPerPageLow: 259, wordsPerPageHigh: 332.4,
};
const estimates = new Map([['wmf', wiseMansFear], ['god', godTest]]);

const book = (overrides: Partial<WordSpeedBook>): WordSpeedBook => ({
  id: 'book', title: 'Book', editionId: 'wmf', pageCount: 1108, pagesRead: 600, timeRead: 900,
  ...overrides,
});

test('a book reads in words per minute only on the page count its edition was measured on', () => {
  // 600 pages in 900 minutes at 381.7 words a page.
  const speed = bookWordsPerMinute(book({}), estimates);
  assert.ok(speed);
  assert.equal(speed.wordsPerMinute, 600 * 381.7 / 900);
  assert.equal(speed.low, 600 * 330.4 / 900);
  assert.equal(speed.high, 600 * 433.1 / 900);
  assert.equal(speed.wordsPerPage, 381.7);
  assert.equal(speed.minutes, 900);
  // Another printing, an unmeasured or unlinked edition: no speed in words.
  assert.equal(bookWordsPerMinute(book({ pageCount: 994 }), estimates), null);
  assert.equal(bookWordsPerMinute(book({ editionId: 'unmeasured' }), estimates), null);
  assert.equal(bookWordsPerMinute(book({ editionId: null }), estimates), null);
  // Under an hour of reading, or no pages, is too little to call a speed,
  // the same bar the pages-per-hour lists use.
  assert.equal(bookWordsPerMinute(book({ timeRead: 59 }), estimates), null);
  assert.ok(bookWordsPerMinute(book({ timeRead: 60 }), estimates));
  assert.equal(bookWordsPerMinute(book({ pagesRead: 0 }), estimates), null);
});

test('measured books are listed fastest first and pooled by their minutes', () => {
  const books = [
    book({ id: 'a', title: 'The Wise Man\'s Fear' }),
    book({ id: 'b', title: 'The God Test', editionId: 'god', pageCount: 329, pagesRead: 329, timeRead: 360 }),
    book({ id: 'c', title: 'Unmeasured', editionId: 'other' }),
  ];
  const measured = measuredBookSpeeds(books, estimates);
  // 329 pages in 6 hours at 295.7 is ≈ 270 wpm, ahead of 600 in 15 hours at 381.7 (≈ 254).
  assert.deepEqual(measured.map((speed) => speed.id), ['b', 'a']);
  const pooled = pooledWordsPerMinute(measured);
  assert.ok(pooled);
  // Total words over total minutes.
  const words = 600 * 381.7 + 329 * 295.7;
  assert.ok(Math.abs(pooled.wordsPerMinute - words / (900 + 360)) < 1e-9);
  assert.ok(Math.abs(pooled.low - (600 * 330.4 + 329 * 259) / 1260) < 1e-9);
  assert.ok(Math.abs(pooled.high - (600 * 433.1 + 329 * 332.4) / 1260) < 1e-9);
  assert.equal(pooledWordsPerMinute([]), null);
});

test('only the editions of timed books are read', () => {
  assert.deepEqual(speedEditionIds([
    book({ editionId: 'wmf' }),
    book({ editionId: 'wmf' }),
    book({ editionId: 'god' }),
    book({ editionId: 'short', timeRead: 30 }),
    book({ editionId: null }),
  ]), ['god', 'wmf']);
});

test('an edition\'s Word Counter estimate decodes to what the statistics use', () => {
  const stored = {
    workId: 'work', title: 'The Wise Man\'s Fear',
    wordEstimate: {
      method: 'corrected-chosen', countingVersion: 1, pageCountBasis: 1108, chosenPages: 15,
      randomPages: 20, ordinaryShare: 1, wordsPerPage: 381.7, wordsPerPageLow: 330.4,
      wordsPerPageHigh: 433.1, language: 'en', readability: null, vocabulary: null,
      createdBy: 'reader', measuredAt: 'server timestamp',
    },
  };
  assert.deepEqual(decodeEditionWordEstimate(stored, 'editions/wmf'), wiseMansFear);
  assert.equal(decodeEditionWordEstimate({ workId: 'work' }, 'editions/plain'), null);
  for (const [broken, message] of [
    [{ ...stored.wordEstimate, pageCountBasis: 1108.5 }, /pageCountBasis: expected an integer/],
    [{ ...stored.wordEstimate, wordsPerPage: '381.7' }, /wordsPerPage: expected a finite number/],
    [{ ...stored.wordEstimate, wordsPerPageLow: 400 }, /0 ≤ low ≤ words per page ≤ high/],
    [{ ...stored.wordEstimate, wordsPerPageHigh: 300 }, /0 ≤ low ≤ words per page ≤ high/],
  ] as const) {
    assert.throws(
      () => decodeEditionWordEstimate({ ...stored, wordEstimate: broken }, 'editions/wmf'),
      message,
    );
  }
});
