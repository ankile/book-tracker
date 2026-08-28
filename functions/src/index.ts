import * as functions from "firebase-functions/v1";
import {onDocumentDeleted} from "firebase-functions/v2/firestore";
import {initializeApp} from "firebase-admin/app";
import {getFirestore} from "firebase-admin/firestore";
import {publicweb} from "./publicWeb";
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

// Profiles per account are not capped by rules yet (SEC-032), so deletion
// pages through them: each page is one bounded batch (≤ 2 × page ops),
// and the markers of a page are fetched with one getAll. failurePolicy
// makes a failed delivery retry — every step here is idempotent, and
// without it a transient error would leave a deleted account's profiles
// public and in the sitemap forever (no client can delete them once the
// auth user is gone).
const PROFILE_DELETE_PAGE = 100;

exports.deleteUserDocument = functions
  .region("europe-west1")
  .runWith({
    serviceAccount: FUNCTIONS_RUNTIME_SERVICE_ACCOUNT,
    failurePolicy: true,
    maxInstances: AUTH_TRIGGER_MAX_INSTANCES,
  })
  .auth.user()
  .onDelete(async (user) => {
    // Account deletion must immediately remove both the public document and
    // its search opt-in. Otherwise a deleted account could remain in Google
    // and in the sitemap indefinitely.
    await db.collection("users").doc(user.uid).delete();
    for (;;) {
      const page = await db.collection("profiles")
        .where("uid", "==", user.uid)
        .limit(PROFILE_DELETE_PAGE)
        .get();
      if (page.empty) break;
      // The marker is deleted only when it is still this user's: a freed
      // username is first-writer-wins, so by now the marker under the same
      // id may belong to another account (SEC-036).
      const markers = await db.getAll(
        ...page.docs.map((profile) => db.collection("profileDiscovery").doc(profile.id)),
      );
      const batch = db.batch();
      page.docs.forEach((profile, index) => {
        batch.delete(profile.ref);
        const marker = markers[index];
        if (marker.exists && marker.get("uid") === user.uid) batch.delete(marker.ref);
      });
      await batch.commit();
      if (page.size < PROFILE_DELETE_PAGE) break;
    }
    return null;
  });

exports.admin = require("./admin");
exports.booksapi = require("./booksapi");
exports.telemetry = require("./telemetry");
exports.toggl = require("./toggl");
exports.publicweb = publicweb;
