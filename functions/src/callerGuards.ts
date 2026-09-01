import * as functions from "firebase-functions/v1";
import {getFirestore} from "firebase-admin/firestore";

const db = getFirestore();

// The two questions every data callable asks about its caller. They lived
// as five hand-written copies (catalog, booksapi, telemetry, toggl twice)
// that had already drifted on whether a missing user document counts as
// deleted; one implementation keeps the endpoints from disagreeing again.

// A deleted account is tombstoned, never removed (SEC-006), and its ID
// token stays valid for up to an hour after the deletion, so acting on the
// caller requires a user document with no deletedAt. The two messages are
// distinct because they are distinct states: a tombstone is a deletion,
// while a missing document is an account that was never set up (only the
// sign-up trigger creates one) or one that an operator purge removed.
export function assertLiveAccount(exists: boolean, deletedAt: unknown): void {
  if (deletedAt !== undefined) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This account has been deleted.",
    );
  }
  if (!exists) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This account is not active.",
    );
  }
}

// The same judgement for a caller that has not read the document yet.
export async function requireLiveUser(uid: string): Promise<void> {
  const user = await db.collection("users").doc(uid).get();
  assertLiveAccount(user.exists, user.get("deletedAt"));
}

// Sign-up is open, so a verified email address is the throttle every data
// endpoint sits behind (owner decision 2026-08-31).
export function requireVerifiedUid(
  context: functions.https.CallableContext,
): string {
  if (context.auth === undefined) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Sign in to continue.",
    );
  }
  if (context.auth.token.email_verified !== true) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Verify your email before using this feature.",
    );
  }
  return context.auth.uid;
}
