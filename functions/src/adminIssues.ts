import {Timestamp} from "firebase-admin/firestore";
import {createHash} from "node:crypto";
import {decodeStoredIssue, isRecord} from "./decoders";

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

export interface MappedIssues {
  rows: AdminIssueRow[];
  truncated: boolean;
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

// Newest-first rows, at most `limit` in total and `perUidLimit` per account.
// The per-account cap is what keeps the feed readable now that the
// callable quota bounds a single account to a rate rather than a total:
// twenty rows an hour still fills a hundred-row feed in five hours, but
// ten rows per account means blinding it costs ten accounts (SEC-038).
// Rows without a uid (server rows for deleted users, historical anonymous
// sign-in failures, malformed rows) are outside the cap: none of them can
// be produced by a client any more. `truncated` is true when any row in
// the scanned window was left out, for either reason, so the panel can say
// the feed is incomplete instead of looking finished.
export function mapIssueDocuments(
  documents: readonly StoredIssueDocument[],
  limit: number,
  identities: ReadonlyMap<string, IssueIdentity>,
  perUidLimit: number,
): MappedIssues {
  const rows: AdminIssueRow[] = [];
  const shownPerUid = new Map<string, number>();
  for (const document of documents) {
    if (rows.length >= limit) break;
    const row = mapIssueDocument(document, identities);
    if (row.uid !== null) {
      const shown = shownPerUid.get(row.uid) ?? 0;
      if (shown >= perUidLimit) continue;
      shownPerUid.set(row.uid, shown + 1);
    }
    rows.push(row);
  }
  return {rows, truncated: rows.length < documents.length};
}
