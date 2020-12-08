import firebase from "firebase/app"; // rollup bundle issue with ESM import
import { db } from "../firebase";
import { collections } from "../firebase/collections";
import { collectionData } from "rxfire/firestore";
import { startWith } from "rxjs/operators";

class Database {
  static getBooks(finished) {
    const query = db
      .collection("books")
      .where("finished", "==", finished)
      .orderBy("updatedAt", "desc");
    return collectionData(query, "id").pipe(startWith([]));
  }

  static addReading(event) {
    const { id, previousPage, currentPage, timeRead } = event.detail;
    if (timeRead < 0) {
      db.collection(collections.BOOKS).doc(id).update({
        currentPage: currentPage,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      db.collection(collections.BOOKS)
        .doc(id)
        .update({
          currentPage: currentPage,
          timeRead: firebase.firestore.FieldValue.increment(timeRead),
          pagesRead: firebase.firestore.FieldValue.increment(
            currentPage - previousPage
          ),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
    }
  }
}

export { Database };
