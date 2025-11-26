import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

admin.initializeApp();

// Automatically mark book as finished when currentPage reaches pageCount
exports.bookIsFinished = functions
  .region("europe-west1")
  .firestore.document("/users/{userId}/books/{bookId}")
  .onUpdate(async (snap, _) => {
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

// Create a user document when a new user signs up
exports.createUserDocument = functions
  .region("europe-west1")
  .auth.user()
  .onCreate(async (user) => {
    await admin.firestore().collection("users").doc(user.uid).set({
      email: user.email,
      uid: user.uid,
    });
    return null;
  });

exports.deleteUserDocument = functions
  .region("europe-west1")
  .auth.user()
  .onDelete(async (user) => {
    await admin.firestore().collection("users").doc(user.uid).delete();
    return null;
  });

exports.booksapi = require("./booksapi");
