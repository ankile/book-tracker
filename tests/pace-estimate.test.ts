import assert from 'node:assert/strict';
import test from 'node:test';
import { minutesLeft, paceEditionIds, paceFor, paceNote } from '../src/lib/utils/paceEstimate.ts';

const book = (id: string, authorIds: string[], fiction: boolean | null, pagesRead: number, timeRead: number) => ({
  id, authorIds, fiction, pagesRead, timeRead,
});

const rothfuss = 'author-rothfuss';
const library = [
  // 200 pages in 400 minutes: 2 min/page on the author.
  book('name-of-the-wind', [rothfuss], true, 200, 400),
  // Other fiction, 1 min/page; other non-fiction, 4 min/page.
  book('dune', ['author-herbert'], true, 300, 300),
  book('thinking', ['author-kahneman'], false, 100, 400),
  // Untimed books lend nothing.
  book('unread-fiction', ['author-x'], true, 0, 0),
  book('pages-no-minutes', [rothfuss], true, 50, 0),
];

test('a book with its own sessions uses its own pace', () => {
  const own = book('own', [rothfuss], true, 10, 25);
  assert.deepEqual(paceFor(own, [...library, own]), { minutesPerPage: 2.5, source: 'own' });
  assert.equal(paceNote({ minutesPerPage: 2.5, source: 'own' }, own), null);
});

test('an unread book borrows the pooled pace of other books sharing an author, itself excluded', () => {
  const wise = book('wise-mans-fear', [rothfuss], true, 0, 0);
  const pace = paceFor(wise, [...library, wise]);
  assert.deepEqual(pace, { minutesPerPage: 2, source: 'author' });
  assert.equal(minutesLeft({ currentPage: 100, pageCount: 1000 }, pace!), 1800);
  assert.equal(paceNote(pace!, wise), 'Estimated from your pace on other books by this author');
  // Pooled, not averaged per book: a second author book at 1 min/page for
  // 600 pages pulls the pace to 1000 min / 800 pages.
  assert.equal(paceFor(wise, [...library, book('slow', [rothfuss], true, 600, 600)])?.minutesPerPage, 1.25);
});

test('without the author on record the pace comes from the same genre, then the whole library', () => {
  const novel = book('novel', ['author-new'], true, 0, 0);
  assert.deepEqual(paceFor(novel, library), { minutesPerPage: 1.4, source: 'genre' });
  assert.equal(paceNote(paceFor(novel, library)!, novel), 'Estimated from your pace on other fiction');
  const essay = book('essay', ['author-new'], false, 0, 0);
  assert.deepEqual(paceFor(essay, library), { minutesPerPage: 4, source: 'genre' });
  assert.equal(paceNote(paceFor(essay, library)!, essay), 'Estimated from your pace on other non-fiction');
  // Unknown genre skips the genre step: 1100 minutes over 600 pages.
  const unknown = book('unknown', ['author-new'], null, 0, 0);
  const pace = paceFor(unknown, library);
  assert.equal(pace?.source, 'library');
  assert.ok(Math.abs(pace!.minutesPerPage - 1100 / 600) < 1e-12);
  assert.equal(paceNote(pace!, unknown), 'Estimated from your average pace across your library');
  // No genre match falls through to the library too.
  assert.equal(paceFor(essay, library.filter((candidate) => candidate.fiction !== false))?.source, 'library');
});

test('nothing timed anywhere means no estimate, and the pace never comes from a negative remainder', () => {
  const lone = book('lone', ['author-new'], true, 0, 0);
  assert.equal(paceFor(lone, [lone, book('other', ['author-y'], true, 0, 0)]), null);
  assert.equal(paceFor(lone, []), null);
  assert.equal(minutesLeft({ currentPage: 120, pageCount: 100 }, { minutesPerPage: 2, source: 'own' }), 0);
});

// Word Counter estimates (owner decision 2026-10-08): an unread book whose
// edition was measured on its page count borrows the reader's minutes per
// word on other measured books, ahead of the page-based tiers.
const estimate = (pageCountBasis: number, wordsPerPage: number) => ({
  pageCountBasis, wordsPerPage, wordsPerPageLow: wordsPerPage - 30, wordsPerPageHigh: wordsPerPage + 30,
});
const measured = (id: string, editionId: string, pageCount: number, pagesRead: number, timeRead: number, authorIds: string[] = ['author-other']) => ({
  ...book(id, authorIds, true, pagesRead, timeRead), editionId, pageCount,
});
const estimates = new Map([
  // The Wise Man's Fear: 381.7 words a page on 1108 pages.
  ['wmf-edition', estimate(1108, 381.7)],
  // A donor read at 250 words a minute: 300 words a page, 600 pages in 720 minutes.
  ['donor-edition', estimate(400, 300)],
  ['second-donor-edition', estimate(200, 200)],
]);

test('an unread measured book borrows minutes per word from measured books, ahead of its author', () => {
  const wise = measured('wise-mans-fear', 'wmf-edition', 1108, 0, 0, [rothfuss]);
  const donor = measured('donor', 'donor-edition', 400, 600, 720);
  const pace = paceFor(wise, [...library, donor, wise], estimates);
  // 720 minutes over 180,000 words, at 381.7 words a page.
  assert.equal(pace?.source, 'words');
  assert.ok(Math.abs(pace!.minutesPerPage - 381.7 * 720 / (600 * 300)) < 1e-12);
  assert.equal(paceNote(pace!, wise), 'Estimated from this edition\'s words per page and your reading speed in words on other measured books');
  // Pooled by words: a second donor of 100 pages at 200 words in 100 minutes.
  const second = measured('second', 'second-donor-edition', 200, 100, 100);
  assert.ok(Math.abs(paceFor(wise, [...library, donor, second], estimates)!.minutesPerPage - 381.7 * 820 / (180_000 + 20_000)) < 1e-12);
});

test('the words tier needs the page counts to match and a timed measured donor', () => {
  const donor = measured('donor', 'donor-edition', 400, 600, 720);
  // Another printing of the measured edition: the author tier as before.
  const otherPrinting = measured('wise', 'wmf-edition', 994, 0, 0, [rothfuss]);
  assert.equal(paceFor(otherPrinting, [...library, donor], estimates)?.source, 'author');
  // A donor on another page count, or untimed, lends nothing in words.
  const wise = measured('wise', 'wmf-edition', 1108, 0, 0, [rothfuss]);
  assert.equal(paceFor(wise, [...library, measured('donor', 'donor-edition', 380, 600, 720)], estimates)?.source, 'author');
  assert.equal(paceFor(wise, [...library, measured('donor', 'donor-edition', 400, 0, 0)], estimates)?.source, 'author');
  // Pages without minutes say nothing about speed either.
  assert.equal(paceFor(wise, [...library, measured('donor', 'donor-edition', 400, 600, 0)], estimates)?.source, 'author');
  // Without estimates at all, nothing changes.
  assert.equal(paceFor(wise, [...library, donor])?.source, 'author');
  // Its own sessions still win.
  assert.equal(paceFor(measured('wise', 'wmf-edition', 1108, 10, 25), [...library, donor], estimates)?.source, 'own');
});

test('pace editions are the paced books\' and every timed book\'s', () => {
  assert.deepEqual(paceEditionIds(
    [measured('target', 'target-edition', 300, 0, 0), book('unlinked', [], true, 0, 0)],
    [measured('timed', 'timed-edition', 300, 10, 10), measured('untimed', 'untimed-edition', 300, 0, 0), measured('again', 'timed-edition', 300, 5, 5)],
  ), ['target-edition', 'timed-edition']);
});
