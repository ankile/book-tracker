import {
  DocumentReference,
  FieldValue,
  getFirestore,
  Timestamp,
} from "firebase-admin/firestore";

const db = getFirestore();

interface QueueClaimToken {
  attempts: number;
  claimedAt: Timestamp;
}

// A successful remote stop can still fail while clearing its correlated
// local timer. Only the exact worker claim that performed that PUT may mark
// the row failed: a lost commit acknowledgement can leave it synced, and a
// stale Eventarc delivery can observe a later processing claim.
export async function markCorrelatedStopFailure(
  queueRef: DocumentReference,
  token: QueueClaimToken,
  entryId: number,
  message: string,
): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(queueRef);
    if (!snap.exists) return false;
    const value = snap.data();
    if (value === undefined) throw new Error("Existing Toggl queue has no data.");
    if (value.status !== "processing" || value.attempts !== token.attempts ||
        !(value.claimedAt instanceof Timestamp) ||
        !value.claimedAt.isEqual(token.claimedAt)) {
      return false;
    }
    tx.update(queueRef, {
      status: "error",
      entryId,
      error: message.slice(0, 1000),
      retryRequestedAt: FieldValue.delete(),
    });
    return true;
  });
}
