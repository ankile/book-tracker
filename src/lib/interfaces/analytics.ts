import type { Momentum, ProfileDay } from './profile.ts';

export interface BookTimeline {
  firstAt: Date;
  lastAt: Date;
  activeDays: number;
  totalMinutes: number;
  totalPages: number;
  sessionCount: number;
}

export interface MonthlyAggregate {
  month: string;
  label: string;
  year: number;
  pages: number;
  minutes: number;
  sessions: number;
  books: number;
  pagesPerHour: number | null;
}

export interface TimeBucket {
  label: string;
  minutes: number;
  sessions: number;
}

export interface HourBucket {
  hour: number;
  minutes: number;
  sessions: number;
  pagesPerHour: number | null;
}

export interface WeekdayBucket extends TimeBucket {
  pagesPerHour: number | null;
}

export interface AuthorLeaderboardRow {
  name: string;
  books: number;
  finishedBooks: number;
  pages: number;
  minutes: number;
}

export interface Superlatives {
  biggestDay: { day: string; pages: number } | null;
  longestSession: { minutes: number; title: string | null; date: Date } | null;
  medianSessionMinutes: number;
  fastestFinish: { title: string; days: number; pageCount: number } | null;
}

export interface LibraryStats {
  totalBooks: number;
  finishedBooks: number;
  readingBooks: number;
  totalTimeRead: number;
  totalTimeReadHours: number;
  totalPagesRead: number;
  booksPerYear: number | string;
  avgTimePerBook: number;
  firstFinishedAt: Date | null;
  lastFinishedAt: Date | null;
  firstBookAddedAt: Date | null;
}

export type { Momentum, ProfileDay };
