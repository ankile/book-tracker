import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

admin.initializeApp();

exports.bookIsFinished = functions.firestore
  .document("/users/{userId}/books/{bookId}")
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

exports.createBookUpdate = functions.firestore
  .document("/users/{userId}/books/{bookId}/updates/{updateId}")
  .onCreate(async (snap, context) => {
    const { bookId, userId } = context.params;
    // Grab the current value of what was written to Cloud Firestore.
    const { type, fromPage, toPage } = snap.data();

    const timeRead = type === "reading" ? snap.data().timeRead : 0;
    const pagesRead = type === "reading" ? toPage - fromPage : 0;

    await admin
      .firestore()
      .collection("users")
      .doc(userId)
      .collection("books")
      .doc(bookId)
      .update({
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        currentPage: toPage,
        pagesRead: admin.firestore.FieldValue.increment(pagesRead),
        timeRead: admin.firestore.FieldValue.increment(timeRead),
      });

    return null;
  });

exports.deleteBookUpdate = functions.firestore
  .document("/users/{userId}/books/{bookId}/updates/{updateId}")
  .onDelete(async (snap, context) => {
    const { bookId, userId } = context.params;
    // Grab the current value of what was written to Cloud Firestore.
    const { type, fromPage, toPage } = snap.data();

    const timeRead = type === "reading" ? snap.data().timeRead : 0;

    await admin
      .firestore()
      .collection("users")
      .doc(userId)
      .collection("books")
      .doc(bookId)
      .update({
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        currentPage: fromPage,
        pagesRead: admin.firestore.FieldValue.increment(-(toPage - fromPage)),
        timeRead: admin.firestore.FieldValue.increment(-timeRead),
      });

    return null;
  });

exports.createUserDocument = functions.auth.user().onCreate(async (user) => {
  await admin.firestore().collection("users").doc(user.uid).set({
    email: user.email,
    uid: user.uid,
  });
  return null;
});

exports.deleteUserDocument = functions.auth.user().onDelete(async (user) => {
  await admin.firestore().collection("users").doc(user.uid).delete();
  return null;
});
