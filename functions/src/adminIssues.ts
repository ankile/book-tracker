import {Timestamp} from "firebase-admin/firestore";
import {createHash} from "node:crypto";
import {decodeStoredIssue, isRecord} from "./decoders";

// Per-account cap and the cap for rows without a uid, both enforced at
// query time (admin.ts readIssuesFor) and reported on the wire so the panel
// can say which accounts hit them. Documented in README and the admin page.
export const ISSUES_PER_UID = 10;
export const ANONYMOUS_ISSUE_LIMIT = 25;

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
  rows: AdminIssueRow[];
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
// without a uid), each already limited by Firestore to cap + 1 rows. A cap
// applied at query time is what makes the feed flood-proof: no volume from
// one account can push another account's rows out of the scan, because
// there is no shared scan (SEC-038). Rows without a uid — historical
// anonymous sign-in failures, which no client can produce any more, and
// malformed rows that lost the field — are read under their own cap. A
// malformed row that still carries a uid is capped with its account,
// because the cap is on the stored field, not the decoded one.
export function assembleIssueFeed(
  groups: readonly IssueGroup[],
  perAccountLimit: number,
  anonymousLimit: number,
  identities: ReadonlyMap<string, IssueIdentity>,
): IssueFeed {
  const rows: AdminIssueRow[] = [];
  let cappedAccounts = 0;
  let anonymousCapped = false;
  for (const group of groups) {
    const limit = group.uid === null ? anonymousLimit : perAccountLimit;
    if (group.documents.length > limit) {
      if (group.uid === null) anonymousCapped = true;
      else cappedAccounts += 1;
    }
    for (const document of group.documents.slice(0, limit)) {
      rows.push(mapIssueDocument(document, identities));
    }
  }
  rows.sort((a, b) => b.at - a.at);
  return {rows, cappedAccounts, anonymousCapped};
}
