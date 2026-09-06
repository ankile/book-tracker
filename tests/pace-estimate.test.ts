import assert from 'node:assert/strict';
import test from 'node:test';
import { minutesLeft, paceFor, paceNote } from '../src/lib/utils/paceEstimate.ts';

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
