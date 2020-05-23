import firebase from "firebase/app"; // rollup bundle issue with ESM import
import { db } from "../firebase";
import { collectionData } from "rxfire/firestore";
import { startWith } from "rxjs/operators";

class Database {
  static getBooks() {
    const query = db.collection("books").orderBy("updatedAt", "desc");
    return collectionData(query, "id").pipe(startWith([]));
  }

  static addReading(event) {
    console.log(event);
    const { id, previousPage, currentPage, timeRead } = event.detail;
    db.collection("books")
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

export { Database };
