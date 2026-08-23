import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProfilePayload,
  computeStats,
  profilePayloadEqual,
  USERNAME_PATTERN,
} from "../src/lib/utils/stats.js";

// Firestore Timestamp stand-in: computeStats only calls createdAt.toDate().
const ts = (iso) => ({ toDate: () => new Date(iso) });

const books = [
  { finished: true, timeRead: 300, pagesRead: 320, pageCount: 320, createdAt: ts("2024-03-01T12:00:00Z") },
  { finished: true, timeRead: 600, pagesRead: 480, pageCount: 480, createdAt: ts("2025-06-01T12:00:00Z") },
  { finished: false, timeRead: 90, pagesRead: 100, pageCount: 400, createdAt: ts("2025-07-01T12:00:00Z") },
];

test("computeStats aggregates the library", () => {
  const stats = computeStats(books);
  assert.equal(stats.totalBooks, 3);
  assert.equal(stats.finishedBooks, 2);
  assert.equal(stats.readingBooks, 1);
  assert.equal(stats.totalTimeReadHours, Math.round(990 / 60));
  assert.equal(stats.totalPagesRead, 900);
  assert.equal(stats.avgTimePerBook, 450);
});

test("payload carries only aggregate numbers — no titles, no book objects", () => {
  const payload = buildProfilePayload(books);
  assert.deepEqual(Object.keys(payload).sort(), ["stats", "years"]);
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
  const published = JSON.parse(JSON.stringify(payload));
  assert.equal(profilePayloadEqual(published, payload), true);
});

test("a changed stat or year row marks the published doc dirty", () => {
  const payload = buildProfilePayload(books);
  const staleStat = JSON.parse(JSON.stringify(payload));
  staleStat.stats.totalPagesRead -= 1;
  assert.equal(profilePayloadEqual(staleStat, payload), false);

  const staleYear = JSON.parse(JSON.stringify(payload));
  staleYear.years[0].count += 1;
  assert.equal(profilePayloadEqual(staleYear, payload), false);
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
