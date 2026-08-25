import assert from "node:assert/strict";
import test from "node:test";

import type { TimestampLike } from "../src/lib/interfaces/common.ts";
import type {
  BookUpdateView,
  PageCorrectionView,
  ReadingUpdateView,
} from "../src/lib/interfaces/reading.ts";

import {
  buildBookTimelines,
  finishedAtByBook,
  monthlyAggregates,
  lifetimePagesPerHour,
  minutesByHour,
  minutesByWeekday,
  computeMomentum,
  computeSuperlatives,
  daysToFinishSummary,
  dustyShelf,
  completionRate,
  projectedFinishes,
  authorLeaderboard,
  qualifiesForSpeed,
} from "../src/lib/utils/sessions.ts";

// Firestore stand-ins: sessions carry createdAt Timestamps and a book
// DocumentReference (only .id is read).
const ts = (iso: string): TimestampLike => ({ toDate: () => new Date(iso) });
const reading = (
  bookId: string,
  iso: string,
  pages: number,
  minutes: number,
): ReadingUpdateView => ({
  type: "reading",
  book: { id: bookId },
  createdAt: ts(iso),
  pagesRead: pages,
  fromPage: 0,
  toPage: pages,
  timeRead: minutes,
});
const update = (bookId: string, iso: string, pages: number): PageCorrectionView => ({
  type: "update",
  book: { id: bookId },
  createdAt: ts(iso),
  pagesRead: pages,
});

const sessions: BookUpdateView[] = [
  reading("a", "2026-01-05T20:00:00", 30, 60),
  reading("a", "2026-01-06T21:00:00", 40, 60),
  // Page-only update finishes book a two days after its last session.
  update("a", "2026-01-08T09:00:00", 10),
  reading("b", "2026-03-10T08:00:00", 25, 30),
];

test("qualifiesForSpeed guards short sessions, absurd paces, and update docs", () => {
  assert.equal(qualifiesForSpeed(reading("x", "2026-01-01T12:00:00", 10, 30)), true);
  assert.equal(qualifiesForSpeed(reading("x", "2026-01-01T12:00:00", 10, 3)), false);
  assert.equal(qualifiesForSpeed(reading("x", "2026-01-01T12:00:00", 500, 60)), false);
  // A backwards page correction is not a pace.
  assert.equal(qualifiesForSpeed(reading("x", "2026-01-01T12:00:00", -20, 60)), false);
  assert.equal(qualifiesForSpeed(update("x", "2026-01-01T12:00:00", 10)), false);
});

test("buildBookTimelines spans every update type and counts active days", () => {
  const timelines = buildBookTimelines(sessions);
  const a = timelines.get("a");
  assert.ok(a);
  assert.equal(a.firstAt.getTime(), new Date("2026-01-05T20:00:00").getTime());
  assert.equal(a.lastAt.getTime(), new Date("2026-01-08T09:00:00").getTime());
  assert.equal(a.activeDays, 3);
  assert.equal(a.totalMinutes, 120);
  assert.equal(a.totalPages, 80);
  assert.equal(a.sessionCount, 3);
});

test("finishedAtByBook maps finished books to their last update", () => {
  const books = [
    { id: "a", finished: true },
    { id: "b", finished: false },
    { id: "no-sessions", finished: true },
  ];
  const finishedAt = finishedAtByBook(books, buildBookTimelines(sessions));
  const finishedA = finishedAt.get("a");
  assert.ok(finishedA);
  assert.equal(finishedA.getTime(), new Date("2026-01-08T09:00:00").getTime());
  assert.equal(finishedAt.has("b"), false);
  assert.equal(finishedAt.has("no-sessions"), false);
});

test("monthlyAggregates fills gap months and withholds jittery speeds", () => {
  const months = monthlyAggregates(sessions);
  assert.equal(months.length, 3); // Jan, Feb, Mar 2026
  assert.deepEqual(months.map((m) => m.month), ["2026-01", "2026-02", "2026-03"]);
  const jan = months[0];
  assert.equal(jan.pages, 70); // reading only; the page-only update is excluded
  assert.equal(jan.minutes, 120);
  assert.equal(jan.books, 1);
  assert.equal(jan.pagesPerHour, 70 / 2);
  assert.equal(months[1].pages, 0);
  assert.equal(months[1].pagesPerHour, null);
  // March has 30 qualifying minutes — under the hour floor.
  assert.equal(months[2].pagesPerHour, null);
});

test("lifetimePagesPerHour aggregates qualifying sessions only", () => {
  // 95 pages over 150 minutes across the three qualifying sessions.
  assert.equal(lifetimePagesPerHour(sessions), 95 / 2.5);
});

test("minutesByHour buckets raw local start hours", () => {
  const hours = minutesByHour(sessions);
  assert.equal(hours[20].minutes, 60);
  assert.equal(hours[21].minutes, 60);
  assert.equal(hours[8].minutes, 30);
  assert.equal(hours[9].minutes, 0);
  assert.equal(hours.reduce((sum, h) => sum + h.sessions, 0), 3);
});

test("minutesByWeekday is Monday-first and 3 AM-shifted", () => {
  // 2026-01-05 is a Monday; a 1 AM Tuesday session belongs to Monday.
  const weekdays = minutesByWeekday([
    reading("a", "2026-01-05T20:00:00", 30, 60),
    reading("a", "2026-01-06T01:00:00", 10, 45),
  ]);
  assert.equal(weekdays[0].label, "Mon");
  assert.equal(weekdays[0].minutes, 105);
  assert.equal(weekdays[1].minutes, 0);
});

test("computeMomentum normalizes the window to short histories", () => {
  // 10 days of history, steady 100 pages/day: recent and lifetime rates
  // must agree (~1.0×) — a fixed /30 denominator would report 0.33×.
  const steady = Array.from({ length: 10 }, (_, i) =>
    reading("a", `2026-03-${String(i + 1).padStart(2, "0")}T12:00:00`, 100, 60)
  );
  const momentum = computeMomentum(steady, new Date("2026-03-10T18:00:00"));
  assert.ok(momentum);
  assert.ok(momentum.ratio !== null);
  assert.ok(Math.abs(momentum.ratio - 1) < 0.01);
});

test("computeMomentum compares the last 30 days to the lifetime rate", () => {
  const now = new Date("2026-03-15T12:00:00");
  const momentum = computeMomentum(sessions, now);
  assert.ok(momentum);
  // 25 pages in the window; 95 pages lifetime over ~68.7 days.
  assert.equal(momentum.recentPagesPerDay, 25 / 30);
  assert.ok(Math.abs(momentum.lifetimePagesPerDay - 95 / 68.67) < 0.01);
  assert.ok(momentum.ratio !== null && momentum.ratio > 0);
});

test("computeSuperlatives finds the records", () => {
  const books = [
    { id: "a", finished: true, title: "Alpha", pageCount: 100 },
    { id: "b", finished: false, title: "Beta", pageCount: 200 },
  ];
  const result = computeSuperlatives(sessions, books, buildBookTimelines(sessions));
  assert.ok(result);
  assert.deepEqual(result.biggestDay, { day: "2026-01-06", pages: 40 });
  assert.ok(result.longestSession);
  assert.equal(result.longestSession.minutes, 60);
  assert.equal(result.medianSessionMinutes, 60);
  // Alpha: Jan 5 → Jan 8 inclusive.
  assert.ok(result.fastestFinish);
  assert.deepEqual(result.fastestFinish, { title: "Alpha", days: 4, pageCount: 100 });
});

test("daysToFinishSummary needs two sessions and reports medians", () => {
  const books = [{ id: "a", finished: true }, { id: "b", finished: true }];
  const summary = daysToFinishSummary(books, buildBookTimelines(sessions));
  // Only book a has ≥ 2 sessions.
  assert.deepEqual(summary, { count: 1, medianDays: 4, medianActiveDays: 3 });
});

test("dustyShelf ranks unfinished books by staleness", () => {
  const now = new Date("2026-06-01T12:00:00");
  const books = [
    { id: "b", finished: false, title: "Beta", currentPage: 50, pageCount: 200, updatedAt: ts("2026-03-10T08:00:00") },
    { id: "c", finished: false, title: "Gamma", currentPage: 0, pageCount: 300, updatedAt: ts("2026-05-20T12:00:00") },
  ];
  const shelf = dustyShelf(books, buildBookTimelines(sessions), now);
  assert.equal(shelf[0].title, "Beta"); // idle since March
  assert.equal(shelf[0].percentComplete, 25);
  assert.equal(shelf[1].title, "Gamma"); // updatedAt fallback, 12 days
  assert.equal(shelf[1].daysSince, 12);
});

test("completionRate counts only books that were ever started", () => {
  const books = [
    { id: "a", finished: true },
    { id: "b", finished: false },
    { id: "never-started", finished: false },
  ];
  assert.equal(completionRate(books, buildBookTimelines(sessions)), 0.5);
});

test("projectedFinishes projects active books and nulls dormant ones", () => {
  const now = new Date("2026-03-20T12:00:00");
  const books = [
    { id: "b", finished: false, title: "Beta", currentPage: 25, pageCount: 100, pagesRead: 25, timeRead: 30 },
    { id: "dormant", finished: false, title: "Dormant", currentPage: 10, pageCount: 100, pagesRead: 10, timeRead: 60 },
  ];
  const dormantSessions = [...sessions, reading("dormant", "2025-06-01T12:00:00", 10, 60)];
  const projections = projectedFinishes(books, buildBookTimelines(dormantSessions), dormantSessions, now);
  assert.equal(projections[0].title, "Beta");
  // 30 recent minutes / 30 days = 1 min/day at 25/30 pages/min → 90 days.
  assert.ok(projections[0].projectedDate);
  assert.ok(
    Math.abs(projections[0].projectedDate.getTime() - (now.getTime() + 90 * 24 * 60 * 60 * 1000)) < 1000
  );
  assert.equal(projections[1].projectedDate, null);
});

test("authorLeaderboard ranks by hours and credits co-authors fully", () => {
  const books = [
    { id: "a", finished: true, authorIds: ["x", "y"], pagesRead: 100, timeRead: 300 },
    { id: "b", finished: false, authorIds: ["x"], pagesRead: 50, timeRead: 90 },
  ];
  const authors = [
    { id: "x", name: "Xavier" },
    { id: "y", name: "Yvonne" },
  ];
  const rows = authorLeaderboard(books, authors);
  assert.equal(rows[0].name, "Xavier");
  assert.equal(rows[0].books, 2);
  assert.equal(rows[0].finishedBooks, 1);
  assert.equal(rows[0].minutes, 390);
  assert.equal(rows[1].name, "Yvonne");
  assert.equal(rows[1].minutes, 300);
});

test("authorLeaderboard omits unresolved raw ids while retaining named analytics", () => {
  const books = [
    { id: "a", finished: true, authorIds: ["loaded", "still-loading"], pagesRead: 100, timeRead: 300 },
  ];
  assert.deepEqual(authorLeaderboard(books, [{ id: "loaded", name: "Loaded" }]), [
    { name: "Loaded", books: 1, finishedBooks: 1, pages: 100, minutes: 300 },
  ]);
  assert.deepEqual(authorLeaderboard(books, []), []);
});
