import {createHash} from "node:crypto";
import {
  DocumentData,
  DocumentSnapshot,
  FieldPath,
  getFirestore,
  Timestamp,
} from "firebase-admin/firestore";
import {onDocumentWritten} from "firebase-functions/v2/firestore";
import {EVENT_INGRESS, FUNCTIONS_RUNTIME_SERVICE_ACCOUNT} from "./runtime";
import {profileConsents, sharingSetting} from "./sharingConsent";

// Page size only, not a bound on the owner: both directions page to the end
// (see withdrawOwner and refreshOwner).
const REFRESH_PAGE = 200;
const REFRESH_CONCURRENCY = 10;
const TRIGGER_OPTIONS = {
  region: "europe-west1",
  retry: true,
  timeoutSeconds: 120,
  maxInstances: 5,
  serviceAccount: FUNCTIONS_RUNTIME_SERVICE_ACCOUNT,
  ingressSettings: EVENT_INGRESS,
} as const;

export function sharedWorkOwnerId(workId: string, uid: string): string {
  return createHash("sha256").update(`${workId}\0${uid}`).digest("hex");
}

function text(data: DocumentData | undefined, field: string): unknown {
  return data?.[field];
}

async function refreshSharedWorkOwner(uid: string, workId: string): Promise<void> {
  if (workId === "" || workId.includes("/")) return;
  const db = getFirestore();
  const projection = db.collection("sharedWorkOwners")
    .doc(sharedWorkOwnerId(workId, uid));
  await db.runTransaction(async (transaction) => {
    const settingRef = db.doc(`users/${uid}/settings/bookSharing`);
    const userRef = db.collection("users").doc(uid);
    const [setting, user, linkedBooks] = await Promise.all([
      transaction.get(settingRef),
      transaction.get(userRef),
      transaction.get(db.collection(`users/${uid}/books`)
        .where("workId", "==", workId).limit(1)),
    ]);
    const consented = sharingSetting(user, setting);
    const consent = consented !== null && profileConsents(
      await transaction.get(db.collection("profiles").doc(consented.username)),
      uid,
    );
    if (consent && !linkedBooks.empty) {
      transaction.set(projection, {workId, uid, updatedAt: Timestamp.now()});
    } else {
      transaction.delete(projection);
    }
  });
}

// Withdrawn consent removes every projection row the owner has, however
// many: the per-link path bounds nothing per owner, so a reader who linked
// works one at a time can hold any number of rows, and a revoke that
// refused above a bound would leave them all behind — each a wasted read on
// every work page, forever. So it pages to the end.
async function withdrawOwner(uid: string): Promise<void> {
  const db = getFirestore();
  let cursor: DocumentSnapshot | null = null;
  for (;;) {
    let query = db.collection("sharedWorkOwners").where("uid", "==", uid)
      .orderBy(FieldPath.documentId()).limit(REFRESH_PAGE);
    if (cursor !== null) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.empty) return;
    for (let index = 0; index < page.size; index += REFRESH_CONCURRENCY) {
      await Promise.all(page.docs.slice(index, index + REFRESH_CONCURRENCY).map((row) =>
        refreshSharedWorkOwner(uid, String(row.get("workId"))),
      ));
    }
    if (page.size < REFRESH_PAGE) return;
    cursor = page.docs[page.size - 1];
  }
}

async function refreshOwner(uid: string): Promise<void> {
  const db = getFirestore();
  const [user, setting] = await Promise.all([
    db.collection("users").doc(uid).get(),
    db.doc(`users/${uid}/settings/bookSharing`).get(),
  ]);
  const consented = sharingSetting(user, setting);
  const consent = consented !== null && profileConsents(
    await db.collection("profiles").doc(consented.username).get(),
    uid,
  );
  if (!consent) {
    await withdrawOwner(uid);
    return;
  }
  // Granted consent pages to the end too. Refusing above a bound left the
  // reader's every projection row unwritten and their sharing silently
  // doing nothing, forever, with nothing to tell them so.
  const workIds = new Set<string>();
  let cursor: DocumentSnapshot | null = null;
  for (;;) {
    let query = db.collection(`users/${uid}/books`).where("workId", "!=", null)
      .orderBy("workId").limit(REFRESH_PAGE);
    if (cursor !== null) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.empty) break;
    const pending: string[] = [];
    for (const snapshot of page.docs) {
      const workId = snapshot.get("workId");
      if (typeof workId === "string" && !workIds.has(workId)) {
        workIds.add(workId);
        pending.push(workId);
      }
    }
    for (let index = 0; index < pending.length; index += REFRESH_CONCURRENCY) {
      await Promise.all(pending.slice(index, index + REFRESH_CONCURRENCY).map((workId) =>
        refreshSharedWorkOwner(uid, workId),
      ));
    }
    if (page.size < REFRESH_PAGE) break;
    cursor = page.docs[page.size - 1];
  }
}

export const syncbooksharingprojection = onDocumentWritten(
  {
    ...TRIGGER_OPTIONS,
    document: "users/{userId}/books/{bookId}",
  },
  async (event) => {
    const before = event.data?.before.get("workId");
    const after = event.data?.after.get("workId");
    if (before === after) return;
    const uid = event.params.userId;
    const workIds = new Set([before, after].filter(
      (value): value is string => typeof value === "string",
    ));
    for (const workId of workIds) await refreshSharedWorkOwner(uid, workId);
  },
);

export const syncsharingsettingprojection = onDocumentWritten(
  {
    ...TRIGGER_OPTIONS,
    document: "users/{userId}/settings/bookSharing",
  },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (text(before, "profileUsername") === text(after, "profileUsername") &&
        text(before, "timeZone") === text(after, "timeZone")) return;
    await refreshOwner(event.params.userId);
  },
);

export const syncsharingprofileprojection = onDocumentWritten(
  {
    ...TRIGGER_OPTIONS,
    document: "profiles/{username}",
  },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    const uids = new Set([text(before, "uid"), text(after, "uid")].filter(
      (value): value is string => typeof value === "string",
    ));
    if (text(before, "uid") === text(after, "uid") &&
        text(before, "public") === text(after, "public") &&
        text(before, "deletedAt") === text(after, "deletedAt")) return;
    for (const uid of uids) await refreshOwner(uid);
  },
);
