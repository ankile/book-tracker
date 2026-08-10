import {getFirestore, Timestamp} from "firebase-admin/firestore";

// Durable issue log shared with the client (src/lib/firebase/db.js writes
// the same collection under rules validation): every row is a warn/error
// worth surfacing, which is what lets the admin overview read the
// collection wholesale with only a time filter. Never put secrets
// (passwords, tokens, MFA codes) in message/code/detail.
interface Issue {
  level: "warn" | "error";
  event: string;
  message: string;
  code?: string;
  uid?: string;
}

// Kept in step with ISSUE_RETENTION_DAYS in src/lib/firebase/db.js; the TTL
// policy on expiresAt is what actually bounds the collection's growth.
const RETENTION_DAYS = 90;

export async function logIssue(issue: Issue): Promise<void> {
  const now = Timestamp.now();
  await getFirestore().collection("logEvents").add({
    level: issue.level,
    event: issue.event,
    message: issue.message,
    code: issue.code ?? null,
    uid: issue.uid ?? null,
    detail: null,
    createdAt: now,
    expiresAt: Timestamp.fromMillis(
      now.toMillis() + RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ),
  });
}
