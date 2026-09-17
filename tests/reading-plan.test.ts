import assert from 'node:assert/strict';
import test from 'node:test';
import type { BookUpdateView } from '../src/lib/interfaces/reading.ts';
import {
  chunkPlanWrites,
  dailyBudget,
  entryEffort,
  orderQueue,
  planMaterialize,
  planMove,
  readingDayOf,
  scheduleQueue,
  yearSummary,
  type PlanEffort,
  type QueueRow,
} from '../src/lib/utils/readingPlan.ts';

// Local-time dates throughout: the forecast is calendar arithmetic in the
// reader's zone, the same as stats.ts.
const local = (year: number, month: number, day: number, hour = 12, minute = 0) =>
  new Date(year, month - 1, day, hour, minute);
const ymd = (date: Date | null) => (date === null ? null : [date.getFullYear(), date.getMonth() + 1, date.getDate()]);

const reading = (at: Date, timeRead: number, pagesRead = 10): BookUpdateView => ({
  type: 'reading', book: { id: 'book' }, createdAt: { toDate: () => at }, timeRead, pagesRead,
});
const correction = (at: Date): BookUpdateView => ({
  type: 'update', book: { id: 'book' }, createdAt: { toDate: () => at }, pagesRead: 5,
});

const NOW = local(2026, 9, 16);

test('a reading day ends at 3 a.m. local time', () => {
  assert.deepEqual(ymd(readingDayOf(local(2026, 9, 16, 1, 30))), [2026, 9, 15]);
  assert.deepEqual(ymd(readingDayOf(local(2026, 9, 16, 3, 0))), [2026, 9, 16]);
});

test('the daily budget divides fourteen completed days, empty days included', () => {
  // Seven 60-minute days followed by seven days without reading.
  const sessions = Array.from({ length: 7 }, (_, index) => reading(local(2026, 9, 2 + index), 60));
  const budget = dailyBudget(sessions, NOW);
  assert.equal(budget.minutesPerDay, 30);
  assert.equal(budget.totalMinutes, 420);
  assert.equal(budget.readingDays, 7);
  assert.equal(budget.sessions, 7);
  assert.deepEqual(ymd(budget.windowStart), [2026, 9, 2]);
  assert.deepEqual(ymd(budget.windowEnd), [2026, 9, 15]);
  assert.equal(budget.todayMinutes, 0);
});

test('the window excludes today, older sessions and page corrections, and counts today separately', () => {
  const sessions = [
    reading(local(2026, 9, 16, 9), 25), // today: outside the average
    reading(local(2026, 9, 17, 1, 0), 5), // 1 a.m. on the 17th is still the 16th
    reading(local(2026, 9, 1), 140), // the day before the window
    reading(local(2026, 9, 2, 2, 59), 140), // 2:59 on the 2nd belongs to the 1st
    reading(local(2026, 9, 2, 3, 0), 140), // the first minute of the window
    correction(local(2026, 9, 10)),
  ];
  const budget = dailyBudget(sessions, NOW);
  assert.equal(budget.totalMinutes, 140);
  assert.equal(budget.minutesPerDay, 10);
  assert.equal(budget.readingDays, 1);
  assert.equal(budget.sessions, 1);
  assert.equal(budget.todayMinutes, 30);
});

const paceBook = (id: string, pagesRead: number, timeRead: number) => ({ id, authorIds: [], fiction: null, pagesRead, timeRead });

test('effort multiplies remaining pages by the manual pace, else the automatic one', () => {
  const library = [paceBook('other', 100, 200)];
  const automatic = entryEffort({ ...paceBook('a', 0, 0), pageCount: 300, currentPage: 100, manualMinutesPerPage: null }, library);
  assert.deepEqual(automatic, {
    remainingPages: 200,
    automaticPace: { minutesPerPage: 2, source: 'library' },
    minutesPerPage: 2,
    source: 'library',
    remainingMinutes: 400,
  });
  const manual = entryEffort({ ...paceBook('a', 0, 0), pageCount: 300, currentPage: 100, manualMinutesPerPage: 3.5 }, library);
  assert.equal(manual.minutesPerPage, 3.5);
  assert.equal(manual.source, 'manual');
  assert.equal(manual.remainingMinutes, 700);
  assert.deepEqual(manual.automaticPace, { minutesPerPage: 2, source: 'library' });
});

test('effort is unknown without a page count or without any pace', () => {
  const noPages = entryEffort({ ...paceBook('a', 0, 0), pageCount: null, currentPage: 0, manualMinutesPerPage: null }, [paceBook('o', 10, 10)]);
  assert.equal(noPages.remainingPages, null);
  assert.equal(noPages.remainingMinutes, null);
  const noPace = entryEffort({ ...paceBook('a', 0, 0), pageCount: 100, currentPage: 0, manualMinutesPerPage: null }, []);
  assert.equal(noPace.remainingPages, 100);
  assert.equal(noPace.minutesPerPage, null);
  assert.equal(noPace.remainingMinutes, null);
  // A manual estimate stands in for a missing automatic pace.
  const manual = entryEffort({ ...paceBook('a', 0, 0), pageCount: 100, currentPage: 0, manualMinutesPerPage: 2 }, []);
  assert.equal(manual.remainingMinutes, 200);
});

const effort = (remainingMinutes: number | null): PlanEffort => ({
  remainingPages: remainingMinutes,
  automaticPace: null,
  minutesPerPage: remainingMinutes === null ? null : 1,
  source: remainingMinutes === null ? null : 'manual',
  remainingMinutes,
});
const queue = (...minutes: (number | null)[]) => minutes.map((m, index) => ({ id: String.fromCharCode(65 + index), effort: effort(m) }));

test('the plan document example: three books at 30 minutes a day from September 16', () => {
  const schedule = scheduleQueue(queue(600, 1200, 1200), { minutesPerDay: 30, todayMinutes: 0 }, NOW);
  assert.equal(schedule.complete, true);
  assert.deepEqual(schedule.entries.map((entry) => [entry.id, ymd(entry.start), ymd(entry.finish)]), [
    ['A', [2026, 9, 16], [2026, 10, 5]],
    ['B', [2026, 10, 6], [2026, 11, 14]],
    ['C', [2026, 11, 15], [2026, 12, 24]],
  ]);
  assert.deepEqual(ymd(schedule.end), [2026, 12, 24]);
  assert.equal(schedule.knownMinutes, 3000);
  // Reordering moves individual dates, never the queue's end.
  const reordered = scheduleQueue(queue(1200, 1200, 600), { minutesPerDay: 30, todayMinutes: 0 }, NOW);
  assert.deepEqual(ymd(reordered.end), [2026, 12, 24]);
  assert.deepEqual(ymd(reordered.entries[0].finish), [2026, 10, 25]);
});

test('today offers only its unused budget and adjacent small books share a day', () => {
  // 45 minutes with 30 left today: 30 today, 15 tomorrow.
  const tomorrow = scheduleQueue(queue(45), { minutesPerDay: 30, todayMinutes: 0 }, NOW);
  assert.deepEqual(ymd(tomorrow.entries[0].finish), [2026, 9, 17]);
  // The same book with 20 minutes already read today: 10 today, 30
  // tomorrow, 5 the day after.
  const later = scheduleQueue(queue(45), { minutesPerDay: 30, todayMinutes: 20 }, NOW);
  assert.deepEqual(ymd(later.entries[0].finish), [2026, 9, 18]);
  // Today exhausted: the queue starts tomorrow.
  const exhausted = scheduleQueue(queue(10), { minutesPerDay: 30, todayMinutes: 30 }, NOW);
  assert.deepEqual(ymd(exhausted.entries[0].start), [2026, 9, 17]);
  assert.deepEqual(ymd(exhausted.entries[0].finish), [2026, 9, 17]);
  // Two 10-minute books both finish today.
  const shared = scheduleQueue(queue(10, 10), { minutesPerDay: 30, todayMinutes: 0 }, NOW);
  assert.deepEqual(shared.entries.map((entry) => ymd(entry.finish)), [[2026, 9, 16], [2026, 9, 16]]);
  // An exact fit ends the day; the next book starts tomorrow.
  const exact = scheduleQueue(queue(30, 30), { minutesPerDay: 30, todayMinutes: 0 }, NOW);
  assert.deepEqual(ymd(exact.entries[0].finish), [2026, 9, 16]);
  assert.deepEqual(ymd(exact.entries[1].start), [2026, 9, 17]);
  assert.deepEqual(ymd(exact.entries[1].finish), [2026, 9, 17]);
  // A finished-length book consumes nothing.
  const empty = scheduleQueue(queue(0, 30), { minutesPerDay: 30, todayMinutes: 0 }, NOW);
  assert.deepEqual(ymd(empty.entries[0].finish), [2026, 9, 16]);
  assert.deepEqual(ymd(empty.entries[1].finish), [2026, 9, 16]);
});

test('unknown effort stops the forecast for itself and later books but keeps the subtotal', () => {
  const schedule = scheduleQueue(queue(30, null, 30), { minutesPerDay: 30, todayMinutes: 0 }, NOW);
  assert.equal(schedule.complete, false);
  assert.equal(schedule.unknownEntries, 1);
  assert.equal(schedule.knownMinutes, 60);
  assert.equal(schedule.end, null);
  assert.deepEqual(schedule.entries.map((entry) => ymd(entry.finish)), [[2026, 9, 16], null, null]);
});

test('a zero budget yields hours but no dates', () => {
  const schedule = scheduleQueue(queue(30), { minutesPerDay: 0, todayMinutes: 0 }, NOW);
  assert.equal(schedule.complete, false);
  assert.equal(schedule.knownMinutes, 30);
  assert.equal(schedule.entries[0].finish, null);
  assert.equal(schedule.end, null);
});

test('dates use calendar days across leap years and daylight-saving changes', () => {
  const leap = scheduleQueue(queue(90), { minutesPerDay: 30, todayMinutes: 0 }, local(2028, 2, 27));
  assert.deepEqual(ymd(leap.entries[0].finish), [2028, 2, 29]);
  // Europe ends summer time on 2026-10-25; the day count is unaffected.
  const autumn = scheduleQueue(queue(90), { minutesPerDay: 30, todayMinutes: 0 }, local(2026, 10, 24));
  assert.deepEqual(ymd(autumn.entries[0].finish), [2026, 10, 26]);
  // A 1 a.m. clock still counts the previous reading day as today.
  const early = scheduleQueue(queue(30), { minutesPerDay: 30, todayMinutes: 0 }, local(2026, 9, 17, 1));
  assert.deepEqual(ymd(early.entries[0].finish), [2026, 9, 16]);
});

test('the year summary reports spare hours or the hours carried past December 31', () => {
  const budget = { minutesPerDay: 30, todayMinutes: 0 };
  // 106 days after today plus today: 3210 budgeted minutes left in 2026.
  const fits = yearSummary(scheduleQueue(queue(600, 1200, 1200), budget, NOW), budget, NOW);
  assert.deepEqual(fits, { year: 2026, endsThisYear: true, spareHours: 3.5, carriedHours: null, crossingEntryId: null });
  const overflow = yearSummary(scheduleQueue(queue(600, 1200, 1200, 600), budget, NOW), budget, NOW);
  assert.deepEqual(overflow, { year: 2026, endsThisYear: false, spareHours: null, carriedHours: 6.5, crossingEntryId: 'D' });
  assert.equal(yearSummary(scheduleQueue(queue(30, null), budget, NOW), budget, NOW), null);
  const spent = { minutesPerDay: 30, todayMinutes: 30 };
  assert.equal(yearSummary(scheduleQueue(queue(3180), spent, NOW), spent, NOW)?.spareHours, 0);
});

const row = (id: string, rank: number | null, kind: 'planned' | 'book' = 'planned'): QueueRow => ({ id, kind, rank });

test('the queue is ranked entries by rank then id, followed by unpositioned unfinished books', () => {
  const entries = [
    { id: 'b', kind: 'planned' as const, rank: 2000 },
    { id: 'zz', kind: 'book' as const, rank: 1000 },
    { id: 'a', kind: 'book' as const, rank: 1000 },
    { id: 'done', kind: 'book' as const, rank: 500 },
  ];
  // 'done' is finished; 'new2' and 'new1' are unfinished books without a
  // position, in reading-list order.
  const rows = orderQueue(entries, ['new2', 'a', 'new1', 'zz']);
  assert.deepEqual(rows, [row('a', 1000, 'book'), row('zz', 1000, 'book'), row('b', 2000), row('new2', null, 'book'), row('new1', null, 'book')]);
});

test('moving among ranked rows writes one midpoint rank', () => {
  const rows = [row('a', 1000), row('b', 2000), row('c', 3000)];
  const plan = planMove(rows, 2, 0);
  assert.deepEqual(plan.writes, [{ id: 'c', kind: 'planned', rank: 0 }]);
  assert.deepEqual(plan.order.map((r) => r.id), ['c', 'a', 'b']);
  assert.equal(plan.rebalanced, false);
  assert.deepEqual(planMove(rows, 0, 1).writes, [{ id: 'a', kind: 'planned', rank: 2500 }]);
  assert.deepEqual(planMove(rows, 0, 2).writes, [{ id: 'a', kind: 'planned', rank: 4000 }]);
});

test('an unpositioned book dropped among ranked rows takes a rank and the others stay implicit', () => {
  const rows = [row('a', 1000), row('b', 2000), row('x', null, 'book'), row('y', null, 'book')];
  const plan = planMove(rows, 3, 1);
  assert.deepEqual(plan.writes, [{ id: 'y', kind: 'book', rank: 1500 }]);
  assert.deepEqual(plan.order.map((r) => [r.id, r.rank]), [['a', 1000], ['y', 1500], ['b', 2000], ['x', null]]);
});

test('dropping among unpositioned books first positions the ones displayed ahead of the drop', () => {
  const rows = [row('a', 1000), row('x', null, 'book'), row('y', null, 'book'), row('z', null, 'book')];
  const plan = planMove(rows, 0, 2);
  assert.deepEqual(plan.writes, [
    { id: 'x', kind: 'book', rank: 1000 },
    { id: 'y', kind: 'book', rank: 2000 },
    { id: 'a', kind: 'planned', rank: 3000 },
  ]);
  assert.deepEqual(plan.order.map((r) => [r.id, r.rank]), [['x', 1000], ['y', 2000], ['a', 3000], ['z', null]]);
  // With no ranked rows at all the sequence starts from the step.
  const fresh = planMove([row('x', null, 'book'), row('y', null, 'book')], 0, 1);
  assert.deepEqual(fresh.writes, [{ id: 'y', kind: 'book', rank: 1000 }, { id: 'x', kind: 'book', rank: 2000 }]);
});

test('neighbours too close together renumber the ranked queue', () => {
  const rows = [row('a', 1), row('b', 1 + 1e-7), row('c', 5), row('x', null, 'book')];
  const plan = planMove(rows, 2, 1);
  assert.equal(plan.rebalanced, true);
  assert.deepEqual(plan.writes, [
    { id: 'a', kind: 'planned', rank: 1000 },
    { id: 'c', kind: 'planned', rank: 2000 },
    { id: 'b', kind: 'planned', rank: 3000 },
  ]);
  assert.deepEqual(plan.order.map((r) => [r.id, r.rank]), [['a', 1000], ['c', 2000], ['b', 3000], ['x', null]]);
});

test('materializing positions an unpositioned row in place and leaves ranked rows alone', () => {
  const rows = [row('a', 1000), row('x', null, 'book'), row('y', null, 'book')];
  assert.deepEqual(planMaterialize(rows, 'a'), []);
  assert.deepEqual(planMaterialize(rows, 'y'), [{ id: 'x', kind: 'book', rank: 2000 }, { id: 'y', kind: 'book', rank: 3000 }]);
  assert.deepEqual(planMaterialize(rows, 'x'), [{ id: 'x', kind: 'book', rank: 2000 }]);
  assert.throws(() => planMaterialize(rows, 'missing'), /not in the queue/);
});

test('plan writes split so no batch positions more than 20 books, the rules lookup limit', () => {
  const creates = Array.from({ length: 45 }, (_, index) => ({ id: `b${index}`, create: true }));
  const chunks = chunkPlanWrites([{ id: 'u', create: false }, ...creates, { id: 'v', create: false }]);
  assert.deepEqual(chunks.map((chunk) => chunk.filter((write) => write.create).length), [20, 20, 5]);
  assert.deepEqual(chunks.flat().map((write) => write.id), ['u', ...creates.map((write) => write.id), 'v']);
  // Updates cost no lookup, and an empty list still yields a batch to append to.
  assert.equal(chunkPlanWrites(Array.from({ length: 300 }, (_, index) => ({ id: `u${index}`, create: false }))).length, 1);
  assert.deepEqual(chunkPlanWrites([]), [[]]);
  assert.equal(chunkPlanWrites(creates.slice(0, 20)).length, 1);
  assert.equal(chunkPlanWrites(creates.slice(0, 21)).length, 2);
});
