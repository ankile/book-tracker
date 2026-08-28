import {Firestore, Timestamp} from "firebase-admin/firestore";

export type QuotaDecision =
  | {granted: true}
  // firstRefusal is true exactly once per window, so callers can log a
  // refusal without the log line becoming an attacker-controlled cost.
  | {granted: false; firstRefusal: boolean};

// Per-user fixed-window counter behind a callable. The document lives under
// users/{uid}/functionQuotas/{name}, which has no client rule, so only the
// Admin SDK can read or move it; the transaction makes the read-and-increment
// atomic, so N concurrent calls cannot all see count < limit (the rules-side
// togglQueue quota has that race; a callable does not). A malformed or
// expired window restarts at 1 rather than failing, so a bad document can
// never lock a user out — and that forgiving branch is only safe because no
// client can write the document: junk written before every call would
// otherwise be an unlimited quota.
//
// Refusals cost one billed read each (the transaction has to look), never a
// retry: the Admin SDK retries transactions only on gRPC contention codes,
// and a refusal commits nothing. The first refusal of a window is recorded
// by moving count to limit + 1 (one write per window), which is what lets a
// caller log it once instead of once per rejected call. That write is also
// what makes "once" hold under concurrency: two instances that both read
// count == limit both try to write, Firestore aborts one commit, and its
// retry reads limit + 1 and reports firstRefusal false. Without the write
// the two transactions would not conflict and both would log.
export async function consumeQuota(
  db: Firestore,
  path: string,
  limit: number,
  windowMs: number,
): Promise<QuotaDecision> {
  const quotaRef = db.doc(path);
  const now = Timestamp.now();
  return db.runTransaction(async (tx): Promise<QuotaDecision> => {
    const snap = await tx.get(quotaRef);
    const data = snap.data();
    const windowStartedAt = data?.windowStartedAt;
    const count = data?.count;
    if (!(windowStartedAt instanceof Timestamp) ||
        typeof count !== "number" || !Number.isInteger(count) || count < 0 ||
        windowStartedAt.toMillis() <= now.toMillis() - windowMs) {
      tx.set(quotaRef, {windowStartedAt: now, count: 1});
      return {granted: true};
    }
    if (count >= limit) {
      const firstRefusal = count === limit;
      if (firstRefusal) tx.update(quotaRef, {count: count + 1});
      return {granted: false, firstRefusal};
    }
    tx.update(quotaRef, {count: count + 1});
    return {granted: true};
  });
}
