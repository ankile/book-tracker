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

  static addPageUpdate({ userId, id, currentPage, previousPage }) {
    db.collection("users")
      .doc(userId)
      .collection(books)
      .doc(id)
      .add({
        book: db.collection("users").doc(userId).collection("books").doc(id),
        type: "update",
        fromPage: previousPage,
        toPage: currentPage,
        pagesRead: currentPage - previousPage,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
  }

  static addReading({ userId, id, previousPage, currentPage, timeRead }) {
    db.collection("users")
      .doc(userId)
      .collection("books")
      .doc(id)
      .collection("readings")
      .add({
        book: db.collection("users").doc(userId).collection("books").doc(id),
        type: "reading",
        timeRead,
        fromPage: previousPage,
        toPage: currentPage,
        pagesRead: currentPage - previousPage,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
  }
}

export { Database };
