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

export function mapIssueDocuments(
  documents: readonly StoredIssueDocument[],
  limit: number,
  identities: ReadonlyMap<string, IssueIdentity>,
): MappedIssues {
  return {
    rows: documents.slice(0, limit)
      .map((document) => mapIssueDocument(document, identities)),
    truncated: documents.length > limit,
  };
}
