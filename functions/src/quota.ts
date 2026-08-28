import * as functions from "firebase-functions/v1";
import {Firestore, Timestamp} from "firebase-admin/firestore";

// Per-user fixed-window counter behind a callable. The document lives under
// users/{uid}/functionQuotas/{name}, which has no client rule, so only the
// Admin SDK can read or move it; the transaction makes the read-and-increment
// atomic, so N concurrent calls cannot all see count < limit (the rules-side
// togglQueue quota has that race; a callable does not). A malformed or
// expired window restarts at 1 rather than failing, so a bad document can
// never lock a user out.
export async function consumeQuota(
  db: Firestore,
  path: string,
  limit: number,
  windowMs: number,
  exhaustedMessage: string,
): Promise<void> {
  const quotaRef = db.doc(path);
  const now = Timestamp.now();
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(quotaRef);
    const data = snap.data();
    const windowStartedAt = data?.windowStartedAt;
    const count = data?.count;
    if (!(windowStartedAt instanceof Timestamp) ||
        typeof count !== "number" || !Number.isInteger(count) || count < 0 ||
        windowStartedAt.toMillis() <= now.toMillis() - windowMs) {
      tx.set(quotaRef, {windowStartedAt: now, count: 1});
      return;
    }
    if (count >= limit) {
      throw new functions.https.HttpsError("resource-exhausted", exhaustedMessage);
    }
    tx.update(quotaRef, {count: count + 1});
  });
}
