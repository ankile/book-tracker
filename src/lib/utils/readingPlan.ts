// The to-read queue forecast (docs/to-read-plan.md): how much the reader
// reads per day lately, how much effort each queued book still needs, and
// the dates that fall out of reading the queue in order on that budget.
// Everything here is pure and takes its clock as an argument.
//
// Two separate quantities: minutes per calendar day comes from the last
// fourteen completed reading days (the app's 3 a.m. day boundary in
// stats.ts), minutes per page comes from paceFor's lifetime evidence or a
// manual override. Full precision throughout; callers round for display.
import type { BookUpdateView } from '../interfaces/reading.ts';
import { paceFor, type Pace, type PaceBook, type PaceSource } from './paceEstimate.ts';
import { dayKeyOf, shiftedDay } from './stats.ts';

export const PLAN_WINDOW_DAYS = 14;
const MS_PER_MINUTE = 60_000;
// Floating-point slack when a book ends exactly on a day's budget.
const EPSILON = 1e-9;

// ---------------------------------------------------------------------------
// Reading days

// The local calendar date of the reading day `now` falls in: local midnight
// after the 3 a.m. shift, so 01:00 on the 16th is still the 15th.
export function readingDayOf(now: Date): Date {
  const shifted = shiftedDay(now);
  return new Date(shifted.getFullYear(), shifted.getMonth(), shifted.getDate());
}

// Local calendar arithmetic: a day is a date, not 24 hours, so daylight
// saving changes never shift a forecast by an hour.
export function addDays(day: Date, days: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + days);
}

// ---------------------------------------------------------------------------
// Daily budget

export interface DailyBudget {
  // Recorded minutes over the window divided by its length, empty days
  // included.
  minutesPerDay: number;
  totalMinutes: number;
  // Window days with any recorded reading, and sessions in the window.
  readingDays: number;
  sessions: number;
  // Reading-day dates, both inclusive; the current partial day is excluded.
  windowStart: Date;
  windowEnd: Date;
  // Reading already recorded on the current reading day, across the library.
  todayMinutes: number;
}

// Only 'reading' updates carry time; page corrections add none. Sessions
// on every book count, finished or not: the budget measures the reader,
// not the queue.
export function dailyBudget(sessions: readonly BookUpdateView[], now: Date): DailyBudget {
  const today = readingDayOf(now);
  const todayKey = dayKeyOf(today);
  const windowStart = addDays(today, -PLAN_WINDOW_DAYS);
  const windowEnd = addDays(today, -1);
  const startKey = dayKeyOf(windowStart);
  const endKey = dayKeyOf(windowEnd);
  let totalMinutes = 0;
  let todayMinutes = 0;
  let count = 0;
  const days = new Set<string>();
  for (const session of sessions) {
    if (session.type !== 'reading') continue;
    const key = dayKeyOf(shiftedDay(session.createdAt.toDate()));
    if (key === todayKey) {
      todayMinutes += session.timeRead;
    } else if (key >= startKey && key <= endKey) {
      totalMinutes += session.timeRead;
      count += 1;
      if (session.timeRead > 0) days.add(key);
    }
  }
  return {
    minutesPerDay: totalMinutes / PLAN_WINDOW_DAYS,
    totalMinutes,
    readingDays: days.size,
    sessions: count,
    windowStart,
    windowEnd,
    todayMinutes,
  };
}

// ---------------------------------------------------------------------------
// Effort per entry

export interface EffortBook extends PaceBook {
  // null for a planned book whose length the reader has not supplied.
  pageCount: number | null;
  currentPage: number;
  manualMinutesPerPage: number | null;
}

export type EffortSource = PaceSource | 'manual';

export interface PlanEffort {
  remainingPages: number | null;
  // What paceFor says, shown beside a manual override in the editor.
  automaticPace: Pace | null;
  minutesPerPage: number | null;
  source: EffortSource | null;
  // null when either the pages or the pace is unknown.
  remainingMinutes: number | null;
}

export function entryEffort(book: EffortBook, library: readonly PaceBook[]): PlanEffort {
  const remainingPages = book.pageCount === null ? null : Math.max(0, book.pageCount - book.currentPage);
  const automaticPace = paceFor(book, library);
  const manual = book.manualMinutesPerPage !== null && book.manualMinutesPerPage > 0;
  const minutesPerPage = manual ? book.manualMinutesPerPage : automaticPace?.minutesPerPage ?? null;
  const source: EffortSource | null = manual ? 'manual' : automaticPace?.source ?? null;
  return {
    remainingPages,
    automaticPace,
    minutesPerPage,
    source,
    remainingMinutes: remainingPages === null || minutesPerPage === null
      ? null
      : remainingPages * minutesPerPage,
  };
}

// ---------------------------------------------------------------------------
// Schedule

export interface Budget {
  minutesPerDay: number;
  todayMinutes: number;
}

export interface ScheduledEntry {
  id: string;
  effort: PlanEffort;
  // Expected reading-day dates; null without a complete forecast.
  start: Date | null;
  finish: Date | null;
}

export interface Schedule {
  entries: ScheduledEntry[];
  // Every entry has a finish date.
  complete: boolean;
  // Sum of the known remaining minutes, a subtotal when incomplete.
  knownMinutes: number;
  unknownEntries: number;
  // The last finish date, when the forecast is complete.
  end: Date | null;
}

// One shared daily budget flows through the queue in order. Today offers
// only what the recorded reading has not used; every later day offers the
// full budget. Unused minutes carry into the next book on the same day.
// An entry with unknown effort keeps its place but stops the dates for
// itself and everything after it.
export function scheduleQueue(
  entries: readonly { id: string; effort: PlanEffort }[],
  budget: Budget,
  now: Date,
): Schedule {
  const today = readingDayOf(now);
  const perDay = budget.minutesPerDay;
  const capacity = (day: number) => (day === 0 ? Math.max(0, perDay - budget.todayMinutes) : perDay);
  let cursor = 0;
  let used = 0;
  let broken = false;
  let knownMinutes = 0;
  let unknownEntries = 0;
  let end: Date | null = null;
  const scheduled: ScheduledEntry[] = [];
  for (const entry of entries) {
    const minutes = entry.effort.remainingMinutes;
    if (minutes === null) {
      unknownEntries += 1;
      broken = true;
      scheduled.push({ id: entry.id, effort: entry.effort, start: null, finish: null });
      continue;
    }
    knownMinutes += minutes;
    if (broken || perDay <= 0) {
      scheduled.push({ id: entry.id, effort: entry.effort, start: null, finish: null });
      continue;
    }
    // Skip an exhausted day before placing anything on it.
    if (used >= capacity(cursor) - EPSILON) {
      cursor += 1;
      used = 0;
    }
    const start = addDays(today, cursor);
    let remaining = minutes;
    let free = capacity(cursor) - used;
    if (remaining > free + EPSILON) {
      remaining -= free;
      cursor += 1;
      used = 0;
      // Whole days at the full budget, without walking them one by one.
      const fullDays = Math.ceil(remaining / perDay - EPSILON);
      cursor += Math.max(0, fullDays - 1);
      used = remaining - Math.max(0, fullDays - 1) * perDay;
    } else {
      used += remaining;
    }
    const finish = addDays(today, cursor);
    end = finish;
    scheduled.push({ id: entry.id, effort: entry.effort, start, finish });
  }
  const complete = !broken && perDay > 0;
  return {
    entries: scheduled,
    complete,
    knownMinutes,
    unknownEntries,
    end: complete ? end : null,
  };
}

// ---------------------------------------------------------------------------
// Year boundary

export interface YearSummary {
  year: number;
  endsThisYear: boolean;
  // Budgeted hours left in the year after the queue, when it fits.
  spareHours: number | null;
  // Queue hours that fall after December 31, when it does not.
  carriedHours: number | null;
  // The first entry expected to finish next year or later.
  crossingEntryId: string | null;
}

export function yearSummary(schedule: Schedule, budget: Budget, now: Date): YearSummary | null {
  if (!schedule.complete || budget.minutesPerDay <= 0) return null;
  const today = readingDayOf(now);
  const year = today.getFullYear();
  const lastDay = new Date(year, 11, 31);
  const daysAfterToday = Math.round((lastDay.getTime() - today.getTime()) / (24 * 60 * MS_PER_MINUTE));
  const thisYearCapacity = Math.max(0, budget.minutesPerDay - budget.todayMinutes)
    + daysAfterToday * budget.minutesPerDay;
  const crossing = schedule.entries.find((entry) => entry.finish !== null && entry.finish.getFullYear() > year);
  const endsThisYear = crossing === undefined;
  return {
    year,
    endsThisYear,
    spareHours: endsThisYear ? (thisYearCapacity - schedule.knownMinutes) / 60 : null,
    carriedHours: endsThisYear ? null : (schedule.knownMinutes - thisYearCapacity) / 60,
    crossingEntryId: crossing?.id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Queue order and ranks

export const RANK_STEP = 1000;
// Below this gap between neighbours a midpoint stops being safe; the whole
// ranked queue is renumbered instead.
export const MIN_RANK_GAP = 1e-6;
// Firestore commits at most 500 writes in one batch.
const MAX_BATCH_WRITES = 500;

export interface QueueRow {
  id: string;
  kind: 'planned' | 'book';
  // null for an unfinished book the reader has not positioned yet.
  rank: number | null;
}

export interface RankWrite {
  id: string;
  kind: 'planned' | 'book';
  rank: number;
}

// Ranked entries by rank then id, then every unfinished book without an
// entry in the reading list's order. A 'book' entry whose book is finished
// or gone is left out but keeps its document, so reopening restores it.
export function orderQueue(
  entries: readonly { id: string; kind: 'planned' | 'book'; rank: number }[],
  unfinishedBookIds: readonly string[],
): QueueRow[] {
  const unfinished = new Set(unfinishedBookIds);
  const ranked = entries
    .filter((entry) => entry.kind === 'planned' || unfinished.has(entry.id))
    .toSorted((a, b) => (a.rank - b.rank) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((entry): QueueRow => ({ id: entry.id, kind: entry.kind, rank: entry.rank }));
  const positioned = new Set(entries.map((entry) => entry.id));
  const implicit = unfinishedBookIds
    .filter((id) => !positioned.has(id))
    .map((id): QueueRow => ({ id, kind: 'book', rank: null }));
  return [...ranked, ...implicit];
}

export function moveIndex<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export interface MovePlan {
  order: QueueRow[];
  writes: RankWrite[];
  rebalanced: boolean;
}

// The writes that persist moving rows[from] to position `to`. Ordinarily
// one: the moved row takes the midpoint of its new neighbours. Dropping a
// row among still-unpositioned books first gives those ahead of it a rank
// (they stay in their displayed order), so the drop is visible on every
// device. Neighbours too close together renumber the ranked queue.
export function planMove(rows: readonly QueueRow[], from: number, to: number): MovePlan {
  const order = moveIndex(rows, from, to);
  const moved = order[to];
  const before = order.slice(0, to);
  const after = order.slice(to + 1);
  const previous = before.at(-1);
  const next = after[0];
  const writes: RankWrite[] = [];
  let rebalanced = false;
  if (previous !== undefined && previous.rank === null) {
    let rank = Math.max(...before.map((row) => row.rank ?? Number.NEGATIVE_INFINITY), 0);
    for (const row of before) {
      if (row.rank !== null) continue;
      rank += RANK_STEP;
      writes.push({ id: row.id, kind: row.kind, rank });
    }
    writes.push({ id: moved.id, kind: moved.kind, rank: rank + RANK_STEP });
  } else if (next === undefined || next.rank === null) {
    const rank = previous === undefined ? RANK_STEP : (previous.rank as number) + RANK_STEP;
    writes.push({ id: moved.id, kind: moved.kind, rank });
  } else {
    const low = previous === undefined ? next.rank - 2 * RANK_STEP : (previous.rank as number);
    const high = next.rank;
    const mid = (low + high) / 2;
    if (high - low < 2 * MIN_RANK_GAP || mid <= low || mid >= high) {
      rebalanced = true;
      let rank = 0;
      for (const row of order) {
        if (row.rank === null && row.id !== moved.id) continue;
        rank += RANK_STEP;
        writes.push({ id: row.id, kind: row.kind, rank });
      }
    } else {
      writes.push({ id: moved.id, kind: moved.kind, rank: mid });
    }
  }
  if (writes.length > MAX_BATCH_WRITES) {
    throw new Error(`Moving this book needs ${writes.length} writes; the limit is ${MAX_BATCH_WRITES}.`);
  }
  const ranks = new Map(writes.map((write) => [write.id, write.rank]));
  return {
    order: order.map((row) => (ranks.has(row.id) ? { ...row, rank: ranks.get(row.id) as number } : row)),
    writes,
    rebalanced,
  };
}

// Give an unpositioned row (and the unpositioned rows displayed ahead of
// it) a rank without moving anything, so an edit can be stored on it.
export function planMaterialize(rows: readonly QueueRow[], id: string): RankWrite[] {
  const index = rows.findIndex((row) => row.id === id);
  if (index < 0) throw new Error(`Row ${id} is not in the queue.`);
  if (rows[index].rank !== null) return [];
  return planMove(rows, index, index).writes;
}
