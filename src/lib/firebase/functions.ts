import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { app } from './index.ts';

export interface TogglConfigResponse {
  workspaceId: number;
  projectId: number;
}

export interface TogglStartResponse {
  entryId: number;
  start: string;
}

export interface TogglStopResponse {
  seconds: number;
  minutes: number;
}

export interface GoogleVolumeInfo {
  title?: string;
  authors?: string[];
  pageCount?: number;
  publisher?: string;
  publishedDate?: string;
  categories?: string[];
  imageLinks?: { thumbnail?: string };
}

export interface AdminUserRow {
  uid: string;
  email: string | null;
  emailVerified: boolean | null;
  signedUpAt: number | null;
  lastSignInAt: number | null;
  lastActiveAt: number | null;
  anomaly: string | null;
  books: number;
  pagesRead: number;
  timeRead: number;
  finishedBooks: number;
  readingSessions: number;
  lastReadAt: number | null;
  lastEditAt: number | null;
}

export interface AdminIssueRow {
  id: string;
  at: number;
  level: string;
  event: string;
  code: string | null;
  message: string;
  uid: string | null;
  email: string;
  emailVerified: boolean;
}

export interface AdminOverview {
  users: AdminUserRow[];
  issues: AdminIssueRow[];
  issueWindowDays: number;
  truncated: { app: number | null; anonymous: number | null };
}

const fns = getFunctions(app, 'europe-west1');

if (import.meta.env.DEV && import.meta.env.VITE_EMULATOR) {
  connectFunctionsEmulator(fns, '127.0.0.1', 5001);
}

export const togglSaveToken = httpsCallable<{ token: string }, TogglConfigResponse>(fns, 'toggl-savetoken');
export const togglStart = httpsCallable<{ bookId: string }, TogglStartResponse>(fns, 'toggl-start');
export const togglStop = httpsCallable<{ bookId: string }, TogglStopResponse>(fns, 'toggl-stop');
export const adminOverview = httpsCallable<Record<string, never>, AdminOverview>(fns, 'admin-overview');
export const lookupIsbn = httpsCallable<{ isbn: string }, { volume: GoogleVolumeInfo | null }>(fns, 'booksapi-lookupisbn');
