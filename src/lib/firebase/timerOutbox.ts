import {
  decodeTimerIntent,
  decodeTimerV2,
} from "../../../shared/timeTracking.ts";
import type { TimerIntent, TimerV2 } from "../../../shared/timeTracking.ts";
import { wireRecord } from "../../../shared/time-tracking-api.ts";

export type OutboxRecord = {
  uid: string;
  id: string;
  intent: TimerIntent;
  timer: TimerV2 | null;
  method: "batch" | "accept" | "clear" | "replace";
  expectedRunning: { key: string; version: string } | null;
  sourceId: string | null;
  correctedProjectId: string | null;
  state: "pending" | "recovery";
  errorCode: string | null;
};
let opened: Promise<IDBDatabase> | undefined;
function database(): Promise<IDBDatabase> {
  opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("book-tracker-timer-outbox", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("operations", {
        keyPath: ["uid", "id"],
      });
      request.result.createObjectStore("locks", { keyPath: "uid" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return opened;
}
function decoded(value: unknown): OutboxRecord {
  if (
    !wireRecord(value) ||
    typeof value.uid !== "string" ||
    typeof value.id !== "string" ||
    (value.method !== "batch" &&
      value.method !== "accept" &&
      value.method !== "clear" &&
      value.method !== "replace") ||
    (value.state !== "pending" && value.state !== "recovery") ||
    (value.errorCode !== null && typeof value.errorCode !== "string") ||
    (value.sourceId !== null && typeof value.sourceId !== "string")
  )
    throw new TypeError("Invalid timer outbox record.");
  if (
    value.correctedProjectId !== null &&
    typeof value.correctedProjectId !== "string"
  )
    throw new TypeError("Invalid corrected project.");
  const intent = decodeTimerIntent(value.intent);
  if (intent.operationId !== value.id)
    throw new TypeError("Outbox operation identity mismatch.");
  let expectedRunning: OutboxRecord["expectedRunning"] = null;
  if (value.expectedRunning !== null) {
    if (
      !wireRecord(value.expectedRunning) ||
      typeof value.expectedRunning.key !== "string" ||
      typeof value.expectedRunning.version !== "string"
    )
      throw new TypeError("Invalid running timer confirmation.");
    expectedRunning = {
      key: value.expectedRunning.key,
      version: value.expectedRunning.version,
    };
  }
  return {
    uid: value.uid,
    id: value.id,
    intent,
    timer: value.timer === null ? null : decodeTimerV2(value.timer),
    method: value.method,
    expectedRunning,
    sourceId: value.sourceId,
    correctedProjectId: value.correctedProjectId,
    state: value.state,
    errorCode: value.errorCode,
  };
}
export async function putOutbox(record: OutboxRecord): Promise<void> {
  const db = await database(),
    row = decoded(record);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("operations", "readwrite"),
      store = tx.objectStore("operations");
    const previous = store.get([row.uid, row.id]);
    previous.onsuccess = () => {
      if (previous.result !== undefined) {
        const old = decoded(previous.result);
        const identity = (value: OutboxRecord) =>
          JSON.stringify({ ...value, state: "pending", errorCode: null });
        if (identity(old) !== identity(row)) {
          tx.abort();
          reject(
            new Error(
              "A saved timer operation cannot change its original intent.",
            ),
          );
          return;
        }
      }
      store.put(row);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  window.dispatchEvent(new CustomEvent("timer-outbox-change"));
}
export async function listOutbox(uid: string): Promise<OutboxRecord[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction("operations")
      .objectStore("operations")
      .getAll(IDBKeyRange.bound([uid, ""], [uid, "\uffff"]));
    request.onsuccess = () => {
      const values: unknown[] = request.result;
      resolve(values.map(decoded));
    };
    request.onerror = () => reject(request.error);
  });
}
export async function removeOutbox(uid: string, id: string): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("operations", "readwrite");
    tx.objectStore("operations").delete([uid, id]);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  window.dispatchEvent(new CustomEvent("timer-outbox-change"));
}
export async function clearOutbox(uid: string): Promise<void> {
  for (const row of await listOutbox(uid)) await removeOutbox(uid, row.id);
}
export async function withTimerLock<T>(
  uid: string,
  work: () => Promise<T>,
): Promise<T> {
  // Web Locks persists ownership for the whole asynchronous reconciliation,
  // including Firestore's reconnect barrier. All supported app browsers have it.
  // Refuse replay without a lock instead of guessing whether another tab sent.
  if (!navigator.locks)
    throw new Error(
      "This browser cannot safely reconcile timers across tabs. Open Book Tracker in a current browser.",
    );
  return navigator.locks.request(`book-tracker-timers:${uid}`, work);
}
