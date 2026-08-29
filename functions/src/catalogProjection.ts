import {createHash} from "node:crypto";
import {
  DocumentData,
  FieldPath,
  getFirestore,
  Timestamp,
} from "firebase-admin/firestore";
import {logger} from "firebase-functions";
import {onDocumentWritten} from "firebase-functions/v2/firestore";
import {EVENT_INGRESS, FUNCTIONS_RUNTIME_SERVICE_ACCOUNT} from "./runtime";

const MAX_OWNER_WORKS = 200;
const MAX_LINKED_BOOKS = 500;
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

function eligibleSetting(data: DocumentData | undefined): boolean {
  const username = text(data, "profileUsername");
  const timeZone = text(data, "timeZone");
  if (typeof username !== "string" || !/^[a-z0-9-]{3,30}$/.test(username) ||
      typeof timeZone !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", {timeZone}).format();
    return true;
  } catch {
    return false;
  }
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
    const settingData = setting.data();
    let consent = setting.exists && user.exists &&
      user.get("deletedAt") === undefined && eligibleSetting(settingData);
    if (consent) {
      const username = setting.get("profileUsername") as string;
      const profile = await transaction.get(db.collection("profiles").doc(username));
      consent = profile.exists && profile.get("uid") === uid &&
        profile.get("public") === true && profile.get("deletedAt") === undefined;
    }
    if (consent && !linkedBooks.empty) {
      transaction.set(projection, {workId, uid, updatedAt: Timestamp.now()});
    } else {
      transaction.delete(projection);
    }
  });
}

async function refreshOwner(uid: string): Promise<void> {
  const db = getFirestore();
  const [user, setting] = await Promise.all([
    db.collection("users").doc(uid).get(),
    db.doc(`users/${uid}/settings/bookSharing`).get(),
  ]);
  let consent = user.exists && user.get("deletedAt") === undefined &&
    setting.exists && eligibleSetting(setting.data());
  if (consent) {
    const profile = await db.collection("profiles")
      .doc(setting.get("profileUsername") as string).get();
    consent = profile.exists && profile.get("uid") === uid &&
      profile.get("public") === true && profile.get("deletedAt") === undefined;
  }
  const candidates = consent ?
    await db.collection(`users/${uid}/books`).where("workId", "!=", null)
      .orderBy("workId")
      .limit(MAX_LINKED_BOOKS + 1).get() :
    await db.collection("sharedWorkOwners").where("uid", "==", uid)
      .orderBy(FieldPath.documentId()).limit(MAX_OWNER_WORKS + 1).get();
  if (consent && candidates.size > MAX_LINKED_BOOKS) {
    logger.error("catalog.shared_work_owner.catalog_bound_exceeded", {
      uid,
      maximum: MAX_LINKED_BOOKS,
      source: "linked-books",
    });
    return;
  }
  const workIds = new Set<string>();
  for (const snapshot of candidates.docs) {
    const workId = snapshot.get("workId");
    if (typeof workId === "string") workIds.add(workId);
  }
  if (workIds.size > MAX_OWNER_WORKS) {
    logger.error("catalog.shared_work_owner.catalog_bound_exceeded", {
      uid,
      maximum: MAX_OWNER_WORKS,
      source: "owner-works",
    });
    return;
  }
  const bounded = [...workIds];
  for (let index = 0; index < bounded.length; index += REFRESH_CONCURRENCY) {
    await Promise.all(bounded.slice(index, index + REFRESH_CONCURRENCY).map((workId) =>
      refreshSharedWorkOwner(uid, workId),
    ));
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
