import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

admin.initializeApp();

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

exports.newReading = functions.firestore
  .document("/books/{bookId}/readings/{readingId}")
  .onCreate(async (snap, context) => {
    const bookId = context.params.bookId;
    // Grab the current value of what was written to Cloud Firestore.
    const { fromPage, toPage, timeRead } = snap.data();

    await admin
      .firestore()
      .collection("books")
      .doc(bookId)
      .update({
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        currentPage: toPage,
        pagesRead: admin.firestore.FieldValue.increment(toPage - fromPage),
        timeRead: admin.firestore.FieldValue.increment(timeRead),
      });

    return null;
  });
