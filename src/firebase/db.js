import firebase from "firebase/app"; // rollup bundle issue with ESM import
import { collectionData } from "rxfire/firestore";
import { startWith } from "rxjs/operators";
import { db } from "../firebase";

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
    const bookRef = db
      .collection("users")
      .doc(userId)
      .collection("books")
      .doc(id);

    bookRef.collection("updates").add({
      book: bookRef,
      type: "update",
      fromPage: previousPage,
      toPage: currentPage,
      pagesRead: currentPage - previousPage,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  static addReading({ userId, id, previousPage, currentPage, timeRead }) {
    const bookRef = db
      .collection("users")
      .doc(userId)
      .collection("books")
      .doc(id);

    bookRef.collection("updates").add({
      book: bookRef,
      type: "reading",
      timeRead,
      fromPage: previousPage,
      toPage: currentPage,
      pagesRead: currentPage - previousPage,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  static addBook({ userId, author, title, pageCount, currentPage, isbn }) {
    const owner = db.collection("users").doc(userId);

    owner.collection("books").add({
      author,
      currentPage,
      finished: false,
      owner,
      pageCount,
      pagesRead: 0,
      timeRead: 0,
      title,
      isbn,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }
}

export { Database };
