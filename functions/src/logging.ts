import {getFirestore, Timestamp} from "firebase-admin/firestore";

// Durable issue log, Admin-SDK-only since SEC-001: firestore.rules has no
// logEvents match block, so every row comes through here — the triggers
// directly, clients via the telemetry-reportissue callable (quota-checked
// and allowlisted before it reaches this function). Every row is a
// warn/error worth surfacing, which is what lets the admin overview read
// the collection wholesale with only a time filter. Never put secrets
// (passwords, tokens, MFA codes) in message/code; detail is always null
// and exists only so historical rows and this one decode alike.
interface Issue {
  level: "warn" | "error";
  event: string;
  message: string;
  code?: string;
  uid?: string;
}

// The TTL policy on expiresAt is what actually bounds the collection's
// growth; the per-user callable quota bounds how fast it fills.
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
