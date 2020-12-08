import * as functions from "firebase-functions";

exports.bookIsFinished = functions.firestore
  .document("/books/{bookId}")
  .onUpdate(async (snap, _) => {
    // Grab the current value of what was written to Cloud Firestore.
    const { currentPage, pageCount, finished } = snap.after.data();

    if (currentPage === pageCount) {
      return snap.after.ref.set({ finished: true }, { merge: true });
    } else if (finished) {
      return snap.after.ref.set({ finished: false }, { merge: true });
    }

    return null;
  });
