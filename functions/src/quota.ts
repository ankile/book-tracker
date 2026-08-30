import {DocumentReference, Firestore, Timestamp, Transaction} from "firebase-admin/firestore";

export type QuotaDecision =
  | {granted: true}
  // firstRefusal is true exactly once per window, so callers can log a
  // refusal without the log line becoming an attacker-controlled cost.
  | {granted: false; firstRefusal: boolean};

// Per-user fixed-window counter behind a callable or trigger. The document
// lives under users/{uid}/functionQuotas/{name}, which has no client rule,
// so only the Admin SDK can move it; the transaction makes the
// read-and-increment atomic, so N concurrent calls cannot all see
// count < limit. A malformed or expired window restarts at 1 rather than
// failing, so a bad document can never lock a user out — and that forgiving
// branch is only safe because no client can write the document: junk
// written before every call would otherwise be an unlimited quota.
//
// Refusals cost one billed read each (the transaction has to look). All
// but the first refusal of a window commit nothing, so they cannot contend
// and are never retried (the Admin SDK retries only on gRPC contention
// codes). The first refusal is recorded by moving count to limit + 1 — one
// write per window — which is what lets a caller log it once instead of
// once per rejected call, and that write is also what makes "once" hold
// under concurrency: two instances that both read count == limit both try
// to write, Firestore aborts one commit, and its retry reads limit + 1 and
// reports firstRefusal false. Without the write the two transactions would
// not conflict and both would log.
//
// applyQuota is the same decision inside a caller's own transaction, for
// counters that must move atomically with another write (the Toggl queue
// counts a row in the transaction that first touches it, so a redelivered
// event cannot count it twice). The read must have happened in that
// transaction already; the writes are queued on it.
export function applyQuota(
  tx: Transaction,
  quotaRef: DocumentReference,
  data: Record<string, unknown> | undefined,
  limit: number,
  windowMs: number,
  now: Timestamp,
  amount = 1,
): QuotaDecision {
  if (!Number.isInteger(amount) || amount <= 0 || amount > limit) {
    throw new RangeError("Quota amount must be a positive integer no greater than its limit.");
  }
  const windowStartedAt = data?.windowStartedAt;
  const count = data?.count;
  if (!(windowStartedAt instanceof Timestamp) ||
      typeof count !== "number" || !Number.isInteger(count) || count < 0 ||
      windowStartedAt.toMillis() <= now.toMillis() - windowMs) {
    tx.set(quotaRef, {windowStartedAt: now, count: amount});
    return {granted: true};
  }
  if (count + amount > limit) {
    const firstRefusal = count <= limit;
    if (firstRefusal) tx.update(quotaRef, {count: limit + 1});
    return {granted: false, firstRefusal};
  }
  tx.update(quotaRef, {count: count + amount});
  return {granted: true};
}

export async function consumeQuota(
  db: Firestore,
  path: string,
  limit: number,
  windowMs: number,
  amount = 1,
): Promise<QuotaDecision> {
  const quotaRef = db.doc(path);
  const now = Timestamp.now();
  return db.runTransaction(async (tx): Promise<QuotaDecision> => {
    const snap = await tx.get(quotaRef);
    return applyQuota(tx, quotaRef, snap.data(), limit, windowMs, now, amount);
  });
}
