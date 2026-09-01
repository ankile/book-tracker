import * as functions from "firebase-functions/v1";
import {onDocumentDeleted} from "firebase-functions/v2/firestore";
import {initializeApp} from "firebase-admin/app";
import {FieldPath, FieldValue, getFirestore} from "firebase-admin/firestore";
import type {QueryDocumentSnapshot} from "firebase-admin/firestore";
import {publicweb} from "./publicWeb";
import {
  syncbooksharingprojection,
  syncsharingaccountprojection,
  syncsharingsettingprojection,
} from "./catalogProjection";
import {AUTH_TRIGGER_MAX_INSTANCES, EVENT_INGRESS, FUNCTIONS_RUNTIME_SERVICE_ACCOUNT} from "./runtime";

initializeApp();
const db = getFirestore();

// No trigger touches book content: the client maintains finished in the
// same writeBatch as every page mutation (src/lib/utils/finished.ts), and
// migrate-normalize-books.ts repairs any drift a stale cached client
// leaves behind. The bookIsFinished backstop trigger was deleted
// 2026-08-11; note that eur3 rejects newly created gen1 Firestore
// triggers, so any future book trigger must be gen2 (lowercase name).

// Cascade-delete a book's updates subcollection. Runs server-side because
// the client may delete a book while offline, where it cannot reliably
// enumerate the subcollection (a cache-only getDocs would silently orphan
// whatever was not cached). v2 trigger: the eur3 multi-region database
// rejects newly created gen1 Firestore triggers, and gen2 requires
// lowercase function names.
// Generous timeout: recursiveDelete of a long-lived book's updates
// subcollection can outrun the 60s default. retry: recursiveDelete is
// idempotent, and without it one failed delivery (a transient Firestore
// error, an ingress misclassification) would orphan the subcollection
// silently and permanently.
exports.deletebookupdates = onDocumentDeleted(
  {
    document: "users/{userId}/books/{bookId}",
    region: "europe-west1",
    timeoutSeconds: 300,
    retry: true,
    // Any signed-in account can create and delete its own books at will, so
    // this trigger is a free invocation amplifier; a small instance cap
    // keeps the spend rate bounded (deliveries queue) while real deletions
    // are rare.
    maxInstances: 5,
    serviceAccount: FUNCTIONS_RUNTIME_SERVICE_ACCOUNT,
    ingressSettings: EVENT_INGRESS,
  },
  async (event) => {
    if (!event.data) return;
    await db.recursiveDelete(event.data.ref);
  });

// Create a user document when a new user signs up
exports.createUserDocument = functions
  .region("europe-west1")
  // failurePolicy: the user document is created only here (users/{uid} has
  // no client write rule and savetoken refuses to create it), so a dropped
  // sign-up event would leave an account that can never connect Toggl. The
  // handler is idempotent (merge-set + conditional lifecycle create).
  .runWith({
    serviceAccount: FUNCTIONS_RUNTIME_SERVICE_ACCOUNT,
    maxInstances: AUTH_TRIGGER_MAX_INSTANCES,
    failurePolicy: true,
  })
  .auth.user()
  .onCreate(async (user) => {
    const userRef = db.collection("users").doc(user.uid);
    const lifecycleRef = userRef.collection("timerLifecycle").doc("current");
    await db.runTransaction(async (tx) => {
      const lifecycle = await tx.get(lifecycleRef);
      tx.set(userRef, {
        email: user.email,
        uid: user.uid,
      }, {merge: true});
      if (!lifecycle.exists) {
        tx.set(lifecycleRef, {
          version: 1,
          state: "idle",
          cleared: null,
        });
      }
    });
    return null;
  });

// Account deletion is a soft delete (SEC-006, owner decision 2026-08-29):
// nothing is removed. The user document and every profile of the uid get
// a server-pinned `deletedAt`, and everything that acts on the account
// treats that tombstone as absence — the public renderer and the sitemap
// (publicWeb.ts), the Toggl callables and queue worker (toggl.ts), the
// admin overview, and the rules, which refuse the identity's profile
// writes for the hour its ID token outlives the account (verifiedAccount).
// Reading data, authors, queue rows, quotas and the ownership record stay
// exactly as they were; a username stays reserved by its tombstoned
// profile. Deletion prunes exactly two things, both deliberate, narrow
// exceptions to the soft-delete default and neither retained content:
// the profileDiscovery markers (search-index opt-in pointers — a deleted
// account leaves the search index; removed only while they still name
// this uid) and the Toggl credential in the secrets database (SEC-004: a
// live credential for the user's whole Toggl account is not data to
// retain for an account that can never use it; the status-only mirror in
// users/{uid}.toggl stays, tombstoned with the rest). A physical purge is
// an operator-run migration (migrate-purge-deleted-accounts.ts), never
// this trigger.
//
// failurePolicy makes a failed delivery retry, and every step is
// idempotent: deletedAt is written only where it is absent, so a
// redelivery never moves a timestamp. Rules allow one profile per account
// (SEC-032), but accounts from before that cap may hold more, so the
// profile pass pages by document id (the tombstone does not change the
// query, so a limit-only loop would never advance).
const PROFILE_TOMBSTONE_PAGE = 100;

async function deleteTogglCredential(uid: string): Promise<void> {
  // The secrets database (SEC-004); deleting a missing document is a
  // no-op, so a redelivery converges.
  await getFirestore("secrets").doc(`togglTokens/${uid}`).delete();
}

async function tombstoneUser(uid: string): Promise<void> {
  const userRef = db.collection("users").doc(uid);
  await db.runTransaction(async (tx) => {
    const user = await tx.get(userRef);
    if (user.get("deletedAt") !== undefined) return;
    tx.set(userRef, {uid, deletedAt: FieldValue.serverTimestamp()}, {merge: true});
  });
}

async function tombstoneProfiles(uid: string): Promise<void> {
  let after: QueryDocumentSnapshot | undefined;
  for (;;) {
    let query = db.collection("profiles")
      .where("uid", "==", uid)
      .orderBy(FieldPath.documentId())
      .limit(PROFILE_TOMBSTONE_PAGE);
    if (after !== undefined) query = query.startAfter(after);
    const page = await query.get();
    if (!page.empty) {
      // A freed username's marker may now belong to another account, so a
      // marker is removed only while it still names this uid.
      const markers = await db.getAll(
        ...page.docs.map((profile) => db.collection("profileDiscovery").doc(profile.id)),
      );
      const batch = db.batch();
      let ops = 0;
      page.docs.forEach((profile, index) => {
        if (profile.get("deletedAt") === undefined) {
          batch.set(profile.ref, {deletedAt: FieldValue.serverTimestamp()}, {merge: true});
          ops += 1;
        }
        const marker = markers[index];
        if (marker.exists && marker.get("uid") === uid) {
          batch.delete(marker.ref);
          ops += 1;
        }
      });
      if (ops > 0) await batch.commit();
    }
    if (page.size < PROFILE_TOMBSTONE_PAGE) break;
    after = page.docs[page.size - 1];
  }
}

exports.deleteUserDocument = functions
  .region("europe-west1")
  .runWith({
    serviceAccount: FUNCTIONS_RUNTIME_SERVICE_ACCOUNT,
    failurePolicy: true,
    maxInstances: AUTH_TRIGGER_MAX_INSTANCES,
  })
  .auth.user()
  .onDelete(async (user) => {
    // Tombstone FIRST, credential second: savetoken re-checks the
    // tombstone after writing a credential and undoes itself, so any
    // credential that lands after this delete step is written by a call
    // that will see the already-set tombstone and remove it (review F4 —
    // the reverse order left a race where a still-valid ID token could
    // strand a live credential on a deleted account).
    await tombstoneUser(user.uid);
    // Each cleanup must run even if another subsystem is temporarily down,
    // and retries converge both. The sharing setting is kept like every
    // other document: tombstoning the profile withdraws consent through the
    // projection trigger (withdrawOwner deletes every sharedWorkOwners row
    // the account has), so deleting the setting removed data without
    // changing what anyone can see.
    const cleanup = await Promise.allSettled([
      tombstoneProfiles(user.uid),
      deleteTogglCredential(user.uid),
    ]);
    const failures = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "Account deletion cleanup failed.");
    }
    return null;
  });

exports.syncbooksharingprojection = syncbooksharingprojection;
exports.syncsharingsettingprojection = syncsharingsettingprojection;
exports.syncsharingaccountprojection = syncsharingaccountprojection;

exports.admin = require("./admin");
exports.booksapi = require("./booksapi");
exports.catalog = require("./catalogEndpoints");
exports.telemetry = require("./telemetry");
exports.toggl = require("./toggl");
exports.publicweb = publicweb;
