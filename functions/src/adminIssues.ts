import {Timestamp} from "firebase-admin/firestore";
import {createHash} from "node:crypto";
import {decodeStoredIssue, isRecord} from "./decoders";

// Per-account cap and the cap for rows without a uid, both enforced at
// query time (admin.ts readIssuesFor) and reported on the wire so the panel
// can say which accounts hit them. Documented in README and the admin page.
export const ISSUES_PER_UID = 10;
export const ANONYMOUS_ISSUE_LIMIT = 25;
// Absolute bound on the assembled feed. The per-account caps bound what any
// one account contributes; this bounds the response itself, which would
// otherwise grow with the number of accounts — and sign-up is open, so
// that number is attacker-chosen (round-2 red-team: ~170 flooding accounts
// × 10 rows × 6 KB messages would push admin-overview past the 10 MB
// gen-1 response limit and take the users table down with it).
export const FEED_LIMIT = 200;

export interface IssueIdentity {
  email: string;
  verified: boolean;
}

export interface AdminIssueRow {
  id: string;
  at: number;
  level: "warn" | "error";
  event: string;
  code: string | null;
  message: string;
  uid: string | null;
  email: string;
  emailVerified: boolean;
  malformed: boolean;
}

export interface StoredIssueDocument {
  id: string;
  value: unknown;
  fallbackAt: number;
}

// One per-account (or uid-null) query result: up to limit + 1 documents,
// newest first, so the assembler can tell "exactly at the cap" from "more
// than the cap" without a second read.
export interface IssueGroup {
  uid: string | null;
  documents: readonly StoredIssueDocument[];
}

export interface IssueFeed {
  // Newest first, at most feedLimit rows, chosen round-robin across groups.
  rows: AdminIssueRow[];
  // Rows that passed the per-group caps, before the feed limit.
  total: number;
  // Accounts whose rows in the window exceeded the per-account cap.
  cappedAccounts: number;
  // Whether the uid-null group exceeded its own cap.
  anonymousCapped: boolean;
}

const MALFORMED_EVENT = "logEvents.malformed";
const MALFORMED_CODE = "MALFORMED_STORED_ISSUE";
const MALFORMED_MESSAGE =
  "Stored issue record is malformed. Its fields were hidden.";
const MALFORMED_IDENTITY = "(malformed issue)";

function opaqueIssueId(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("hex");
}

function safeIssueTime(value: unknown, fallbackAt: number): number {
  if (!isRecord(value) || !(value.createdAt instanceof Timestamp)) {
    return fallbackAt;
  }
  return value.createdAt.toMillis();
}

function mapIssueDocument(
  document: StoredIssueDocument,
  identities: ReadonlyMap<string, IssueIdentity>,
): AdminIssueRow {
  const issue = decodeStoredIssue(document.value);
  const id = opaqueIssueId(document.id);
  if (issue === null) {
    return {
      id,
      at: safeIssueTime(document.value, document.fallbackAt),
      level: "error",
      event: MALFORMED_EVENT,
      code: MALFORMED_CODE,
      message: MALFORMED_MESSAGE,
      uid: null,
      email: MALFORMED_IDENTITY,
      emailVerified: false,
      malformed: true,
    };
  }

  const uid = issue.uid;
  const identity = uid ?
    identities.get(uid) ?? {email: "(deleted user)", verified: false} :
    // Pre-auth detail was historically user-entered and can be a password
    // even when it looks like an address. Keep old rows visible without
    // returning that value to the admin client.
    {email: "(anonymous)", verified: false};
  return {
    id,
    at: issue.createdAt.toMillis(),
    level: issue.level,
    event: issue.event,
    code: issue.code,
    message: issue.message,
    uid,
    email: identity.email,
    emailVerified: identity.verified,
    malformed: false,
  };
}

// The feed is assembled from one query per account (plus one for rows
// whose uid field is null), each already limited by Firestore to cap + 1
// rows. A cap applied at query time is what makes the feed flood-proof: no
// volume from one account can push another account's rows out of the
// scan, because there is no shared scan (SEC-038). The uid-null group is
// historical anonymous sign-in failures, which no client can produce any
// more. A malformed row that still carries its uid is capped with its
// account, because the cap is on the stored field, not the decoded one; a
// row with no uid field, or a non-string one, matches no query at all and
// is invisible to this feed (Firestore's `== null` is IS_NULL, and the
// index does not contain documents lacking the field). Only the Admin SDK
// writes the collection and every writer sets uid, so such a row would be
// a server bug rather than an attack.
//
// The cut to feedLimit is round-robin, not newest-first: the newest row of
// every group, then the second newest of every group, until the budget is
// spent, and only then sorted by time for display. A newest-first cut
// re-coupled the accounts the per-group queries had just separated — twenty
// accounts writing exactly the cap each (so nothing reported them as
// capped) pushed an honest account's rows below the cut entirely (round-3
// red-team). Round-robin guarantees every group at least
// floor(feedLimit / groups) of its rows; at twenty groups or fewer nothing
// is cut at all, and at two hundred every account still shows its newest
// row. `total` is how many rows passed the per-group caps, so the page can
// say how many the cut hid.
export function assembleIssueFeed(
  groups: readonly IssueGroup[],
  perAccountLimit: number,
  anonymousLimit: number,
  feedLimit: number,
  identities: ReadonlyMap<string, IssueIdentity>,
): IssueFeed {
  let cappedAccounts = 0;
  let anonymousCapped = false;
  const perGroup = groups.map((group) => {
    const limit = group.uid === null ? anonymousLimit : perAccountLimit;
    if (group.documents.length > limit) {
      if (group.uid === null) anonymousCapped = true;
      else cappedAccounts += 1;
    }
    return group.documents.slice(0, limit)
      .map((document) => mapIssueDocument(document, identities))
      .sort((a, b) => b.at - a.at);
  });
  const total = perGroup.reduce((sum, groupRows) => sum + groupRows.length, 0);
  const deepest = Math.max(0, ...perGroup.map((groupRows) => groupRows.length));
  const rows: AdminIssueRow[] = [];
  for (let rank = 0; rank < deepest && rows.length < feedLimit; rank += 1) {
    for (const groupRows of perGroup) {
      if (rows.length >= feedLimit) break;
      if (rank < groupRows.length) rows.push(groupRows[rank]);
    }
  }
  rows.sort((a, b) => b.at - a.at);
  return {rows, total, cappedAccounts, anonymousCapped};
}
