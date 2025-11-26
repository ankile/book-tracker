import { 
  collection,
  doc,
  query,
  where,
  orderBy,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp
} from 'firebase/firestore';
import { writable } from 'svelte/store';
import { db } from './index.js';

class Database {
  // Returns a Svelte store that listens to book updates
  static getBooks(userId, finished) {
    const store = writable([]);

    const q = query(
      collection(db, 'users', userId, 'books'),
      where('finished', '==', finished),
      orderBy('updatedAt', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const books = [];
      snapshot.forEach((doc) => {
        books.push({ id: doc.id, ...doc.data() });
      });
      store.set(books);
    });

    // Return store with unsubscribe method
    return {
      subscribe: store.subscribe,
      unsubscribe
    };
  }

  static async addPageUpdate({ userId, id, currentPage, previousPage }) {
    const bookRef = doc(db, 'users', userId, 'books', id);

    await addDoc(collection(db, 'users', userId, 'books', id, 'updates'), {
      book: bookRef,
      type: 'update',
      fromPage: previousPage,
      toPage: currentPage,
      pagesRead: currentPage - previousPage,
      updatedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    });

    await updateDoc(bookRef, {
      currentPage,
    });
  }

  static async addReading({ userId, id, previousPage, currentPage, timeRead }) {
    const bookRef = doc(db, 'users', userId, 'books', id);

    await addDoc(collection(db, 'users', userId, 'books', id, 'updates'), {
      book: bookRef,
      type: 'reading',
      timeRead,
      fromPage: previousPage,
      toPage: currentPage,
      pagesRead: currentPage - previousPage,
      updatedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    });

    await updateDoc(bookRef, {
      currentPage,
    });
  }

  static async addBook({ userId, author, title, pageCount, currentPage, isbn }) {
    const ownerRef = doc(db, 'users', userId);

    await addDoc(collection(db, 'users', userId, 'books'), {
      author,
      currentPage,
      finished: false,
      owner: ownerRef,
      pageCount,
      pagesRead: 0,
      timeRead: 0,
      title,
      isbn,
      updatedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    });
  }

  static async updateBook({ userId, bookId, author, title, pageCount, isbn }) {
    const bookRef = doc(db, 'users', userId, 'books', bookId);

    await updateDoc(bookRef, {
      author,
      title,
      pageCount,
      isbn,
      updatedAt: serverTimestamp(),
    });
  }

  static async deleteBook(userId, bookId) {
    const bookRef = doc(db, 'users', userId, 'books', bookId);
    await deleteDoc(bookRef);
  }
}

export { Database };
