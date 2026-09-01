import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { app } from './index.ts';
import type {
  AdminCatalogApplyRequest,
  AdminCatalogApplyResponse,
  AdminCatalogPreviewRequest,
  AdminCatalogPreviewResponse,
  CatalogCreateRequest,
  CatalogCreateResponse,
  CatalogSearchRequest,
  CatalogSearchResponse,
  EnsureCatalogAuthorsRequest,
  EnsureCatalogAuthorsResponse,
  WorkReadersRequest,
  WorkReadersResponse,
} from '../interfaces/catalog.ts';
import {
  decodeAdminCatalogApplyResponse,
  decodeAdminCatalogPreviewResponse,
} from '../utils/adminCatalog.ts';
import {
  decodeCatalogCreateResponse,
  decodeCatalogSearchResponse,
  decodeEnsureCatalogAuthorsResponse,
  decodeWorkReadersResponse,
} from '../utils/catalogClient.ts';
import type { IssueReport } from '../utils/issueReport.ts';

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
  level: 'warn' | 'error';
  event: string;
  code: string | null;
  message: string;
  uid: string | null;
  email: string;
  emailVerified: boolean;
  malformed: boolean;
}

export interface AdminOverview {
  users: AdminUserRow[];
  issues: AdminIssueRow[];
  issueWindowDays: number;
  // Feed caps, enforced per account at query time; cappedAccounts is how
  // many accounts had more rows in the window than perAccount.
  issueCaps: {
    perAccount: number;
    cappedAccounts: number;
    anonymous: number;
    anonymousCapped: boolean;
    // Rows shown of the rows that passed the per-account caps.
    shown: number;
    total: number;
    // Accounts (plus the anonymous group) with rows in the window, and how
    // many of them the 200-row cut left with at least one row shown.
    groupsWithRows: number;
    groupsShown: number;
    // Accounts whose read failed; their rows are missing from this feed.
    unreadAccounts: number;
    // Whether the read for rows without a uid failed.
    anonymousUnread: boolean;
  };
}

const fns = getFunctions(app, 'europe-west1');

if (import.meta.env.DEV && import.meta.env.VITE_EMULATOR) {
  connectFunctionsEmulator(fns, '127.0.0.1', 5001);
}

export const togglSaveToken = httpsCallable<{ token: string }, TogglConfigResponse>(fns, 'toggl-savetoken');
export const togglStart = httpsCallable<{ bookId: string }, TogglStartResponse>(fns, 'toggl-start');
export const togglStop = httpsCallable<{ bookId: string }, TogglStopResponse>(fns, 'toggl-stop');
export const togglClearStopping = httpsCallable<{ bookId: string }, { cleared: true }>(fns, 'toggl-clearstopping');
export const togglClearToken = httpsCallable<Record<string, never>, { cleared: true }>(fns, 'toggl-cleartoken');
export const adminOverview = httpsCallable<Record<string, never>, AdminOverview>(fns, 'admin-overview');
export const lookupIsbn = httpsCallable<{ isbn: string }, { volume: GoogleVolumeInfo | null }>(fns, 'booksapi-lookupisbn');
export const reportIssue = httpsCallable<IssueReport, { recorded: true }>(fns, 'telemetry-reportissue');

const catalogSearchCallable = httpsCallable<CatalogSearchRequest, unknown>(fns, 'catalog-search');
const ensureCatalogAuthorsCallable = httpsCallable<EnsureCatalogAuthorsRequest, unknown>(fns, 'catalog-ensureauthors');
const workReadersCallable = httpsCallable<WorkReadersRequest, unknown>(fns, 'catalog-workreaders');
const catalogCreateCallable = httpsCallable<CatalogCreateRequest, unknown>(fns, 'catalog-create');
const adminCatalogPreviewCallable = httpsCallable<AdminCatalogPreviewRequest, unknown>(fns, 'admin-catalogpreview');
const adminCatalogApplyCallable = httpsCallable<AdminCatalogApplyRequest, unknown>(fns, 'admin-catalogapply');

export async function catalogSearch(request: CatalogSearchRequest): Promise<CatalogSearchResponse> {
  return decodeCatalogSearchResponse((await catalogSearchCallable(request)).data);
}

export async function ensureCatalogAuthors(
  request: EnsureCatalogAuthorsRequest,
): Promise<EnsureCatalogAuthorsResponse> {
  return decodeEnsureCatalogAuthorsResponse(
    (await ensureCatalogAuthorsCallable(request)).data,
    request.authors.length,
  );
}

export async function catalogCreate(request: CatalogCreateRequest): Promise<CatalogCreateResponse> {
  return decodeCatalogCreateResponse((await catalogCreateCallable(request)).data);
}

export async function workReaders(request: WorkReadersRequest): Promise<WorkReadersResponse> {
  return decodeWorkReadersResponse((await workReadersCallable(request)).data);
}

export async function adminCatalogPreview(
  request: AdminCatalogPreviewRequest,
): Promise<AdminCatalogPreviewResponse> {
  return decodeAdminCatalogPreviewResponse((await adminCatalogPreviewCallable(request)).data);
}

export async function adminCatalogApply(
  request: AdminCatalogApplyRequest,
): Promise<AdminCatalogApplyResponse> {
  return decodeAdminCatalogApplyResponse((await adminCatalogApplyCallable(request)).data);
}
