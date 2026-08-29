import * as functions from "firebase-functions/v1";
import {onDocumentDeleted} from "firebase-functions/v2/firestore";
import {initializeApp} from "firebase-admin/app";
import {FieldPath, FieldValue, getFirestore} from "firebase-admin/firestore";
import type {QueryDocumentSnapshot} from "firebase-admin/firestore";
import {publicweb} from "./publicWeb";
import {
  syncbooksharingprojection,
  syncsharingprofileprojection,
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
// profile. The one thing deletion prunes is the profileDiscovery marker —
// a search-index opt-in pointer, not retained content: a deleted account
// leaves the search index, so its uid-matched markers are removed (the
// profile itself, the actual content, is kept and tombstoned). This is a
// deliberate, narrow exception to the soft-delete default. A physical purge is an operator-run
// migration (migrate-purge-deleted-accounts.ts), never this trigger.
//
// failurePolicy makes a failed delivery retry, and every step is
// idempotent: deletedAt is written only where it is absent, so a
// redelivery never moves a timestamp. Rules allow one profile per account
// (SEC-032), but accounts from before that cap may hold more, so the
// profile pass pages by document id (the tombstone does not change the
// query, so a limit-only loop would never advance).
const PROFILE_TOMBSTONE_PAGE = 100;

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
    // A sharing-setting delete lets the projection trigger remove discovery
    // rows promptly. Live account checks still make any stale row inert while
    // the retryable Auth trigger converges.
    await db.doc(`users/${user.uid}/settings/bookSharing`).delete();
    await tombstoneUser(user.uid);
    await tombstoneProfiles(user.uid);
    return null;
  });

exports.syncbooksharingprojection = syncbooksharingprojection;
exports.syncsharingsettingprojection = syncsharingsettingprojection;
exports.syncsharingprofileprojection = syncsharingprofileprojection;

exports.admin = require("./admin");
exports.booksapi = require("./booksapi");
const catalog = require("./catalog");
exports.catalog = {
  search: catalog.search,
  workreaders: catalog.workreaders,
};
exports.telemetry = require("./telemetry");
exports.toggl = require("./toggl");
exports.publicweb = publicweb;
