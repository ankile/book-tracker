import * as functions from "firebase-functions/v1";
import {initializeApp} from "firebase-admin/app";
import {getFirestore} from "firebase-admin/firestore";

initializeApp();
const db = getFirestore();

// Automatically mark book as finished when currentPage reaches pageCount
exports.bookIsFinished = functions
  .region("europe-west1")
  .firestore.document("/users/{userId}/books/{bookId}")
  .onUpdate(async (snap) => {
    // Grab the current value of what was written to Cloud Firestore.
    const { currentPage, pageCount, finished } = snap.after.data();

    if (currentPage === pageCount) {
      if (!finished) {
        return snap.after.ref.set({ finished: true }, { merge: true });
      }
    } else if (finished) {
      return snap.after.ref.set({ finished: false }, { merge: true });
    }

    return null;
  });

// Cascade-delete a book's updates subcollection. Runs server-side because
// the client may delete a book while offline, where it cannot reliably
// enumerate the subcollection (a cache-only getDocs would silently orphan
// whatever was not cached).
exports.deleteBookUpdates = functions
  .region("europe-west1")
  .firestore.document("/users/{userId}/books/{bookId}")
  .onDelete(async (snap) => {
    await db.recursiveDelete(snap.ref);
  });

// Create a user document when a new user signs up
exports.createUserDocument = functions
  .region("europe-west1")
  .auth.user()
  .onCreate(async (user) => {
    await db.collection("users").doc(user.uid).set({
      email: user.email,
      uid: user.uid,
    });
    return null;
  });

exports.deleteUserDocument = functions
  .region("europe-west1")
  .auth.user()
  .onDelete(async (user) => {
    await db.collection("users").doc(user.uid).delete();
    return null;
  });

exports.booksapi = require("./booksapi");
exports.toggl = require("./toggl");
