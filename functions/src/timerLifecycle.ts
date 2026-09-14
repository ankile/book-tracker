import { DocumentReference, getFirestore } from "firebase-admin/firestore";
import {
  ActiveTimer,
  TimerClaim,
  decodeActiveTimerFromBook,
  decodeTimerClaim,
} from "./decoders";

const db = getFirestore();

export function claimForTimer(bookId: string, timer: ActiveTimer): TimerClaim {
  if (!("state" in timer)) {
    if ("entryId" in timer) {
      return {
        version: 1,
        state: "remote",
        bookId,
        entryId: timer.entryId,
        start: timer.start,
      };
    }
    if (timer.operationId === undefined) {
      throw new Error("Local timer is missing its operation id.");
    }
    return {
      version: 1,
      state: "local",
      bookId,
      operationId: timer.operationId,
      start: timer.start,
    };
  }
  return { version: 1, ...timer, bookId };
}

export function timerMatchesClaim(
  bookId: string,
  timer: ActiveTimer | null,
  claim: TimerClaim,
): boolean {
  if (timer === null || claim.state === "idle" || claim.bookId !== bookId)
    return false;
  const expected = claimForTimer(bookId, timer);
  if (expected.state !== claim.state || expected.start !== claim.start)
    return false;
  if (expected.state === "local") {
    return (
      claim.state === "local" && expected.operationId === claim.operationId
    );
  }
  if (expected.state === "remote") {
    return claim.state === "remote" && expected.entryId === claim.entryId;
  }
  if (expected.state === "stopping") {
    return (
      claim.state === "stopping" &&
      expected.entryId === claim.entryId &&
      expected.queueId === claim.queueId
    );
  }
  if (expected.state === "starting") {
    return (
      claim.state === "starting" &&
      expected.operationId === claim.operationId &&
      expected.claimedAt.isEqual(claim.claimedAt)
    );
  }
  return (
    claim.state === "outcome-unknown" &&
    expected.operationId === claim.operationId &&
    expected.claimedAt.isEqual(claim.claimedAt) &&
    expected.error === claim.error
  );
}

export async function transitionStartClaim(
  bookRef: DocumentReference,
  claimRef: DocumentReference,
  operationId: string,
  replacement: ActiveTimer | null,
): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const [snap, claimSnap] = await Promise.all([
      tx.get(bookRef),
      tx.get(claimRef),
    ]);
    if (!snap.exists || !claimSnap.exists) return false;
    const current = decodeActiveTimerFromBook(snap.data());
    const claim = decodeTimerClaim(claimSnap.data());
    if (
      !current ||
      !("state" in current) ||
      current.state !== "starting" ||
      current.operationId !== operationId ||
      claim.state !== "starting" ||
      claim.operationId !== operationId ||
      !timerMatchesClaim(bookRef.id, current, claim)
    ) {
      return false;
    }
    tx.update(bookRef, { activeTimer: replacement });
    if (replacement === null)
      tx.set(claimRef, { version: 1, state: "idle", cleared: claim });
    else tx.set(claimRef, claimForTimer(bookRef.id, replacement));
    return true;
  });
}

export async function clearMatchedTimer(
  bookRef: DocumentReference,
  claimRef: DocumentReference,
  expectedTimer: ActiveTimer,
): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const [bookSnap, claimSnap] = await Promise.all([
      tx.get(bookRef),
      tx.get(claimRef),
    ]);
    if (!bookSnap.exists || !claimSnap.exists) return false;
    const timer = decodeActiveTimerFromBook(bookSnap.data());
    const claim = decodeTimerClaim(claimSnap.data());
    const expectedClaim = claimForTimer(bookRef.id, expectedTimer);
    if (
      !timerMatchesClaim(bookRef.id, timer, expectedClaim) ||
      claim.state === "idle" ||
      !timerMatchesClaim(bookRef.id, timer, claim)
    ) {
      return false;
    }
    tx.update(bookRef, { activeTimer: null });
    tx.set(claimRef, { version: 1, state: "idle", cleared: claim });
    return true;
  });
}
