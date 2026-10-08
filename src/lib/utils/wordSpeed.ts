// Reading speed in words, for books whose catalog edition carries a Word
// Counter estimate measured on the book's own page count
// (shared/wordEstimate.ts). It sits beside pages per hour on the stats page
// and uses the same book-level basis as its fastest and slowest lists:
// pages read over minutes read, for books with at least an hour of reading.
// The range carries the estimate's 95% interval through; pages and minutes
// are taken as exact.
import { matchedWordEstimate } from '../../../shared/wordEstimate.ts';
import type { EditionWordEstimate } from '../interfaces/catalog.ts';
import { BOOK_SPEED_MIN_MINUTES } from './sessions.ts';

export interface WordSpeedBook {
  id: string;
  title: string;
  editionId: string | null;
  pageCount: number;
  pagesRead: number;
  timeRead: number;
}

export interface WordsPerMinute {
  wordsPerMinute: number;
  low: number;
  high: number;
}

export interface MeasuredBookSpeed extends WordsPerMinute {
  id: string;
  title: string;
  wordsPerPage: number;
  minutes: number;
}

const timed = (book: WordSpeedBook): boolean =>
  book.timeRead >= BOOK_SPEED_MIN_MINUTES && book.pagesRead > 0;

// The editions worth reading an estimate for: only a timed book can show a speed.
export function speedEditionIds(books: readonly WordSpeedBook[]): string[] {
  return [...new Set(books.flatMap((book) =>
    timed(book) && book.editionId !== null ? [book.editionId] : []))].sort();
}

export function bookWordsPerMinute(
  book: WordSpeedBook,
  estimates: ReadonlyMap<string, EditionWordEstimate>,
): MeasuredBookSpeed | null {
  if (!timed(book) || book.editionId === null) return null;
  const estimate = matchedWordEstimate(estimates.get(book.editionId), book.pageCount);
  if (estimate === null) return null;
  const perMinute = (wordsPerPage: number) => book.pagesRead * wordsPerPage / book.timeRead;
  return {
    id: book.id,
    title: book.title,
    wordsPerPage: estimate.wordsPerPage,
    minutes: book.timeRead,
    wordsPerMinute: perMinute(estimate.wordsPerPage),
    low: perMinute(estimate.wordsPerPageLow),
    high: perMinute(estimate.wordsPerPageHigh),
  };
}

export function measuredBookSpeeds(
  books: readonly WordSpeedBook[],
  estimates: ReadonlyMap<string, EditionWordEstimate>,
): MeasuredBookSpeed[] {
  return books
    .flatMap((book) => {
      const speed = bookWordsPerMinute(book, estimates);
      return speed === null ? [] : [speed];
    })
    .sort((a, b) => b.wordsPerMinute - a.wordsPerMinute);
}

// All measured reading pooled: total words over total minutes. Each book's
// range moves with its own estimate, so the pooled range takes every book at
// its low (or high) end together, which is the cautious reading.
export function pooledWordsPerMinute(speeds: readonly MeasuredBookSpeed[]): WordsPerMinute | null {
  const minutes = speeds.reduce((sum, speed) => sum + speed.minutes, 0);
  if (minutes === 0) return null;
  const pooled = (key: keyof WordsPerMinute) =>
    speeds.reduce((sum, speed) => sum + speed[key] * speed.minutes, 0) / minutes;
  return { wordsPerMinute: pooled('wordsPerMinute'), low: pooled('low'), high: pooled('high') };
}
