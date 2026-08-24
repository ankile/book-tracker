import assert from "node:assert/strict";
import test from "node:test";

import type { TimestampLike } from "../src/lib/interfaces/common.ts";

import {
  aggregateSessionsByDay,
  buildProfilePayload,
  computeBooksByYear,
  computeStats,
  profilePayloadEqual,
  USERNAME_PATTERN,
} from "../src/lib/utils/stats.ts";

// Firestore Timestamp stand-in: computeStats only calls createdAt.toDate().
const ts = (iso: string): TimestampLike => ({ toDate: () => new Date(iso) });

const books = [
  { finished: true, timeRead: 300, pagesRead: 320, pageCount: 320, authorIds: [], createdAt: ts("2024-03-01T12:00:00Z") },
  { finished: true, timeRead: 600, pagesRead: 480, pageCount: 480, authorIds: [], createdAt: ts("2025-06-01T12:00:00Z") },
  { finished: false, timeRead: 90, pagesRead: 100, pageCount: 400, authorIds: [], createdAt: ts("2025-07-01T12:00:00Z") },
];

test("computeStats aggregates the library", () => {
  const stats = computeStats(books);
  assert.equal(stats.totalBooks, 3);
  assert.equal(stats.finishedBooks, 2);
  assert.equal(stats.readingBooks, 1);
  assert.equal(stats.totalTimeReadHours, Math.round(990 / 60));
  assert.equal(stats.totalPagesRead, 900);
  assert.equal(stats.avgTimePerBook, 450);
  assert.equal(typeof stats.booksPerYear, 'string');
  if (typeof stats.booksPerYear === 'string') assert.match(stats.booksPerYear, /^\d+\.\d$/);
});

test("computeStats reports the date range endpoints", () => {
  const stats = computeStats(books);
  assert.ok(stats.firstFinishedAt);
  assert.ok(stats.lastFinishedAt);
  assert.ok(stats.firstBookAddedAt);
  assert.equal(stats.firstFinishedAt.getTime(), new Date("2024-03-01T12:00:00Z").getTime());
  assert.equal(stats.lastFinishedAt.getTime(), new Date("2025-06-01T12:00:00Z").getTime());
  assert.equal(stats.firstBookAddedAt.getTime(), new Date("2024-03-01T12:00:00Z").getTime());
  const empty = computeStats([]);
  assert.equal(empty.firstFinishedAt, null);
  assert.equal(empty.firstBookAddedAt, null);
  assert.equal(empty.booksPerYear, 0);
});

test("computeStats prefers session-derived finish dates when given", () => {
  const withIds = books.map((book, i) => ({ ...book, id: `b${i}` }));
  const finishedAt = new Map([["b0", new Date("2023-11-15T12:00:00Z")]]);
  const stats = computeStats(withIds, finishedAt);
  assert.ok(stats.firstFinishedAt);
  assert.equal(stats.firstFinishedAt.getTime(), new Date("2023-11-15T12:00:00Z").getTime());
});

test("computeBooksByYear counts unique/new authors and tracks book extremes", () => {
  const library = [
    { id: "b1", finished: true, timeRead: 60, pagesRead: 100, pageCount: 100, authorIds: ["x", "y"], createdAt: ts("2024-02-01T12:00:00Z") },
    { id: "b2", finished: true, timeRead: 60, pagesRead: 500, pageCount: 500, authorIds: ["x"], createdAt: ts("2024-06-01T12:00:00Z") },
    { id: "b3", finished: true, timeRead: 60, pagesRead: 300, pageCount: 300, authorIds: ["x", "z"], createdAt: ts("2025-01-05T12:00:00Z") },
    { id: "b4", finished: false, timeRead: 60, pagesRead: 50, pageCount: 400, authorIds: ["w"], createdAt: ts("2025-02-01T12:00:00Z") },
  ];
  const years = computeBooksByYear(library);
  assert.equal(years.length, 2);
  const [y2025, y2024] = years;
  assert.equal(y2024.uniqueAuthors, 2);
  assert.equal(y2024.newAuthors, 2);
  assert.equal(y2024.longestBook.pageCount, 500);
  assert.equal(y2024.shortestBook.pageCount, 100);
  // 2025: x is returning, z is new; the unfinished b4 counts nowhere.
  assert.equal(y2025.uniqueAuthors, 2);
  assert.equal(y2025.newAuthors, 1);
  assert.equal(y2025.longestBook.pageCount, 300);
  assert.equal(y2025.shortestBook.pageCount, 300);
});

test("computeBooksByYear reattributes by session-derived finish dates", () => {
  const library = [
    { id: "b1", finished: true, timeRead: 60, pagesRead: 100, pageCount: 100, authorIds: [], createdAt: ts("2024-12-20T12:00:00Z") },
  ];
  const finishedAt = new Map([["b1", new Date("2025-01-10T12:00:00Z")]]);
  const years = computeBooksByYear(library, finishedAt);
  assert.equal(years.length, 1);
  assert.equal(years[0].year, "2025");
});

test("sessions aggregate per day with the 3 AM boundary, ascending", () => {
  const days = aggregateSessionsByDay([
    { type: "reading", book: { id: "b" }, createdAt: ts("2026-08-20T14:00:00"), pagesRead: 10, timeRead: 20 },
    { type: "reading", book: { id: "b" }, createdAt: ts("2026-08-20T22:00:00"), pagesRead: 5, timeRead: 10 },
    // 1 AM local time counts as the evening of the 20th, not the 21st.
    { type: "reading", book: { id: "b" }, createdAt: ts("2026-08-21T01:00:00"), pagesRead: 3, timeRead: 6 },
    { type: "reading", book: { id: "b" }, createdAt: ts("2026-08-05T12:00:00"), pagesRead: 7, timeRead: 14 },
    // Page-only corrections ride the same listener but must never inflate
    // the heatmap or the published day totals.
    { type: "update", book: { id: "b" }, createdAt: ts("2026-08-20T15:00:00"), pagesRead: 50 },
  ]);
  assert.deepEqual(days, [
    { day: "2026-08-05", pagesRead: 7, timeRead: 14, sessions: 1 },
    { day: "2026-08-20", pagesRead: 18, timeRead: 36, sessions: 3 },
  ]);
});

test("payload is stable across recomputes even with a minutes-old finish date", () => {
  // booksPerYear anchors on "now"; if it moved between recomputes the
  // profile-sync effect would rewrite the doc on every listener echo.
  const justFinished = [
    { id: "b0", finished: true, timeRead: 300, pagesRead: 320, pageCount: 320, authorIds: [], createdAt: ts("2026-08-23T10:00:00") },
  ];
  const finishedAt = new Map([["b0", new Date(Date.now() - 5 * 60 * 1000)]]);
  const first = buildProfilePayload(justFinished, [], finishedAt);
  const second = buildProfilePayload(justFinished, [], finishedAt);
  assert.equal(profilePayloadEqual(structuredClone(first), second), true);
  // And the floored denominator keeps the rate sane rather than in the
  // thousands for a brand-new library.
  assert.ok(first.stats.booksPerYear <= 12);
});

test("payload carries only aggregate numbers — no titles, no book objects", () => {
  const payload = buildProfilePayload(books);
  assert.deepEqual(Object.keys(payload).sort(), ["days", "records", "stats", "years"]);
  assert.equal(payload.records, null);
  for (const value of Object.values(payload.stats)) {
    assert.equal(typeof value, "number");
  }
  for (const year of payload.years) {
    assert.deepEqual(Object.keys(year).sort(), ["count", "hours", "pages", "year"]);
    for (const value of Object.values(year)) {
      assert.equal(typeof value, "number");
    }
  }
});

test("payload years are per finish year, newest first", () => {
  const { years } = buildProfilePayload(books);
  assert.deepEqual(years, [
    { year: 2025, count: 1, hours: 10, pages: 480 },
    { year: 2024, count: 1, hours: 5, pages: 320 },
  ]);
});

test("published doc equals its own payload (sync must settle)", () => {
  const payload = buildProfilePayload(books);
  // Round-trip through JSON the way Firestore round-trips plain values.
  const published = structuredClone(payload);
  assert.equal(profilePayloadEqual(published, payload), true);
});

test("payload publishes title-free record aggregates", () => {
  const records = {
    momentum: { ratio: 1.2, recentPagesPerDay: 8, lifetimePagesPerDay: 6.7 },
    superlatives: {
      biggestDay: { day: "2026-08-20", pages: 120 },
      longestSession: { minutes: 95 },
      medianSessionMinutes: 24,
      fastestFinish: { days: 3, pageCount: 320 },
    },
  };
  const payload = buildProfilePayload(books, [], undefined, records);
  assert.deepEqual(payload.records, records);
  assert.equal(JSON.stringify(payload.records).includes("title"), false);
  assert.equal(payload.stats.authors, 0);

  const stale = structuredClone(payload);
  assert.ok(stale.records);
  assert.ok(stale.records.superlatives);
  stale.records.superlatives.medianSessionMinutes += 1;
  assert.equal(profilePayloadEqual(stale, payload), false);
});

test("a changed stat or year row marks the published doc dirty", () => {
  const payload = buildProfilePayload(books);
  const staleStat = structuredClone(payload);
  staleStat.stats.totalPagesRead -= 1;
  assert.equal(profilePayloadEqual(staleStat, payload), false);

  const staleYear = structuredClone(payload);
  staleYear.years[0].count += 1;
  assert.equal(profilePayloadEqual(staleYear, payload), false);
});

test("a changed day aggregate marks the published doc dirty", () => {
  const days = aggregateSessionsByDay([
    { type: "reading", book: { id: "b" }, createdAt: ts("2026-08-20T14:00:00"), pagesRead: 10, timeRead: 20 },
  ]);
  const payload = buildProfilePayload(books, days);
  const published = structuredClone(payload);
  assert.equal(profilePayloadEqual(published, payload), true);

  const stale = structuredClone(payload);
  stale.days[0].pagesRead += 1;
  assert.equal(profilePayloadEqual(stale, payload), false);

  // A pre-heatmap doc without days must read as dirty so it upgrades.
  const { days: _days, ...legacy } = structuredClone(payload);
  assert.equal(profilePayloadEqual(legacy, payload), false);
});

test("missing or malformed published doc reads as dirty", () => {
  const payload = buildProfilePayload(books);
  assert.equal(profilePayloadEqual(null, payload), false);
  assert.equal(profilePayloadEqual({ stats: {} }, payload), false);
});

test("username pattern matches the rules' charset", () => {
  assert.equal(USERNAME_PATTERN.test("lars-2"), true);
  assert.equal(USERNAME_PATTERN.test("ab"), false);
  assert.equal(USERNAME_PATTERN.test("Lars"), false);
  assert.equal(USERNAME_PATTERN.test("a".repeat(31)), false);
  assert.equal(USERNAME_PATTERN.test("has space"), false);
});
