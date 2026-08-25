import type { Timestamp } from 'firebase/firestore';

export const PROFILE_LINK_TYPES = [
  'twitter', 'github', 'linkedin', 'instagram', 'scholar', 'goodreads',
  'strava', 'homepage', 'other',
] as const;

export type ProfileLinkType = (typeof PROFILE_LINK_TYPES)[number];

export interface ProfileLink {
  type: ProfileLinkType;
  value: string;
  label?: string;
}

export interface ProfileStats {
  totalBooks: number;
  finishedBooks: number;
  readingBooks: number;
  totalTimeReadHours: number;
  totalPagesRead: number;
  booksPerYear: number;
  avgTimePerBook: number;
  authors: number;
}

export interface ProfileYear {
  year: number;
  count: number;
  hours: number;
  pages: number;
}

export interface ProfileDay {
  day: string;
  pagesRead: number;
  timeRead: number;
  sessions: number;
}

export interface Momentum {
  recentPagesPerDay: number;
  lifetimePagesPerDay: number;
  ratio: number | null;
}

export interface PublishedSuperlatives {
  biggestDay: { day: string; pages: number } | null;
  longestSession: { minutes: number } | null;
  medianSessionMinutes: number;
  fastestFinish: { days: number; pageCount: number } | null;
}

export interface ProfileRecords {
  momentum: Momentum | null;
  superlatives: PublishedSuperlatives;
}

export interface ProfilePayload {
  stats: ProfileStats;
  records: ProfileRecords | null;
  years: ProfileYear[];
  days: ProfileDay[];
}

// Normalized profiles returned by the client Firestore decoder. The
// username is the document id; every other field is stored in the doc.
export interface Profile extends ProfilePayload {
  username: string;
  uid: string;
  public: boolean;
  givenName: string;
  familyName: string;
  links: ProfileLink[];
  updatedAt: Timestamp;
}
