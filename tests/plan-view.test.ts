import assert from 'node:assert/strict';
import test from 'node:test';
import { Timestamp } from 'firebase/firestore';
import type { Book } from '../src/lib/interfaces/book.ts';
import type { PlanEntry, PlannedEntry } from '../src/lib/interfaces/readingPlan.ts';
import {
  buildPlanRows,
  effortSourceLabel,
  moveAnnouncement,
  updateEffortMap,
} from '../src/lib/utils/planView.ts';

const at = Timestamp.fromMillis(1_700_000_000_000);

const book = (id: string, overrides: Partial<Book> = {}): Book => ({
  id,
  authorIds: ['author-a'],
  currentPage: 100,
  currentPageUpdateId: null,
  pageCount: 300,
  pagesRead: 100,
  timeRead: 200,
  title: `Book ${id}`,
  finished: false,
  finishedAt: null,
  lastReadAt: null,
  isbn: '',
  owner: { id: 'owner' } as Book['owner'],
  createdAt: at,
  updatedAt: at,
  activeTimer: null,
  coverUrl: '',
  publisher: '',
  publishedDate: '',
  subjects: [],
  fiction: true,
  language: '',
  workId: null,
  editionId: null,
  matchMethod: null,
  linkedAt: null,
  ...overrides,
} as Book);

const planned = (id: string, overrides: Partial<PlannedEntry> = {}): PlannedEntry => ({
  id,
  kind: 'planned',
  rank: 1000,
  manualMinutesPerPage: null,
  createdAt: at,
  updatedAt: at,
  title: `Planned ${id}`,
  authors: [{ id: 'author-a', name: 'Ada Author' }, { id: null, name: 'Typed Name' }],
  pageCount: 200,
  isbn: '',
  catalogLink: null,
  coverUrl: '',
  publisher: '',
  publishedDate: '',
  subjects: [],
  fiction: null,
  language: '',
  ...overrides,
});

test('rows join ranked entries with unfinished books and mark unpositioned books', () => {
  const entries: PlanEntry[] = [
    planned('wish', { rank: 2000 }),
    { id: 'reading', kind: 'book', rank: 1000, manualMinutesPerPage: 3, createdAt: at, updatedAt: at },
    { id: 'gone', kind: 'book', rank: 500, manualMinutesPerPage: null, createdAt: at, updatedAt: at },
  ];
  const rows = buildPlanRows(entries, [book('new', { activeTimer: { start: '2026-09-16T10:00:00Z' } }), book('reading')], null);
  assert.deepEqual(rows.map((row) => [row.id, row.kind, row.implicit, row.rank]), [
    ['reading', 'book', false, 1000],
    ['wish', 'planned', false, 2000],
    ['new', 'book', true, null],
  ]);
  assert.equal(rows[0].manualMinutesPerPage, 3);
  assert.equal(rows[1].authors, 'Author & Name');
  assert.equal(rows[1].currentPage, 0);
  assert.equal(rows[2].timerRunning, true);
  assert.equal(rows[2].manualMinutesPerPage, null);
});

test('the effort map recomputes only rows whose effort inputs changed', () => {
  const library = [book('reading'), book('other', { authorIds: ['author-b'], pagesRead: 50, timeRead: 50 })];
  const rows = buildPlanRows([planned('wish', { rank: 2000 })], [book('reading')], null);
  const first = updateEffortMap(new Map(), rows, library);
  assert.equal(first.computed, 2);
  // Own pace on the reading book: 200 min / 100 pages, 200 pages left.
  assert.equal(first.map.get('reading')?.effort.remainingMinutes, 400);
  // The planned book borrows the author's pace (2 min/page) for 200 pages.
  assert.equal(first.map.get('wish')?.effort.source, 'author');
  assert.equal(first.map.get('wish')?.effort.remainingMinutes, 400);
  // A rank-only change computes nothing.
  const reranked = buildPlanRows([planned('wish', { rank: 1 })], [book('reading')], null);
  const second = updateEffortMap(first.map, reranked, library);
  assert.equal(second.computed, 0);
  assert.equal(second.map.get('wish'), first.map.get('wish'));
  // A manual estimate on one row recomputes that row alone.
  const estimated = buildPlanRows([planned('wish', { rank: 1, manualMinutesPerPage: 5 })], [book('reading')], null);
  const third = updateEffortMap(second.map, estimated, library);
  assert.equal(third.computed, 1);
  assert.equal(third.map.get('wish')?.effort.remainingMinutes, 1000);
  assert.equal(third.map.get('reading'), first.map.get('reading'));
  // New pace evidence anywhere in the library recomputes every row.
  const fourth = updateEffortMap(third.map, estimated, [book('reading'), book('other', { authorIds: ['author-b'], pagesRead: 60, timeRead: 50 })]);
  assert.equal(fourth.computed, 2);
});

test('copy names the effort source and announces a move with its forecast', () => {
  const rows = buildPlanRows([planned('wish', { pageCount: null })], [], null);
  const { map } = updateEffortMap(new Map(), rows, []);
  assert.equal(effortSourceLabel(map.get('wish')!.effort), 'Page count needed');
  assert.equal(effortSourceLabel({ ...map.get('wish')!.effort, remainingPages: 10 }), 'No pace evidence yet');
  assert.equal(effortSourceLabel({ ...map.get('wish')!.effort, source: 'manual' }), 'Your estimate');
  assert.equal(moveAnnouncement('Dune', 2, 5, new Date(2026, 10, 14)), 'Dune moved to position 2 of 5. Expected finish November 2026.');
  assert.equal(moveAnnouncement('Dune', 5, 5, null), 'Dune moved to position 5 of 5. No complete finish forecast.');
});
