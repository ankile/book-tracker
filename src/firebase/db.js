import firebase from "firebase/app"; // rollup bundle issue with ESM import
import { db, auth } from "../firebase";
import { collections } from "../firebase/collections";
import { collectionData } from "rxfire/firestore";
import { startWith } from "rxjs/operators";

class Database {
  static getBooks(userId, finished) {
    const query = db
      .collection("users")
      .doc(userId)
      .collection("books")
      .where("finished", "==", finished)
      .orderBy("updatedAt", "desc");
    return collectionData(query, "id").pipe(startWith([]));
  }

  static updateCurrentPage({ userId, id, currentPage }) {
    db.collection(`users/${userId}/books`).doc(id).update({
      currentPage,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  static addReading({ userId, id, previousPage, currentPage, timeRead }) {
    db.collection(collections.BOOKS)
      .doc(id)
      .collection("readings")
      .add({
        book: id,
        timeRead,
        fromPage: previousPage,
        toPage: currentPage,
        pagesRead: currentPage - previousPage,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        readingDate: firebase.firestore.FieldValue.serverTimestamp(),
      });
  }
}

export { Database };
