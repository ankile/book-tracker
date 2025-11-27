import {
  collection,
  collectionGroup,
  doc,
  query,
  where,
  orderBy,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  writeBatch,
  increment,
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

  // Returns a Svelte store with all books (for statistics)
  static getAllBooks(userId) {
    const store = writable([]);

    const q = query(
      collection(db, 'users', userId, 'books'),
      orderBy('createdAt', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const books = [];
      snapshot.forEach((doc) => {
        books.push({ id: doc.id, ...doc.data() });
      });
      store.set(books);
    });

    return {
      subscribe: store.subscribe,
      unsubscribe
    };
  }

  static async addPageUpdate({ userId, id, currentPage, previousPage }) {
    const batch = writeBatch(db);
    const bookRef = doc(db, 'users', userId, 'books', id);
    const updateRef = doc(collection(db, 'users', userId, 'books', id, 'updates'));

    // Add the update document
    batch.set(updateRef, {
      book: bookRef,
      type: 'update',
      fromPage: previousPage,
      toPage: currentPage,
      pagesRead: currentPage - previousPage,
      updatedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    });

    // Update book with new currentPage and updatedAt
    batch.update(bookRef, {
      currentPage,
      updatedAt: serverTimestamp(),
    });

    await batch.commit();
  }

  static async addReading({ userId, id, previousPage, currentPage, timeRead }) {
    const batch = writeBatch(db);
    const bookRef = doc(db, 'users', userId, 'books', id);
    const ownerRef = doc(db, 'users', userId);
    const sessionRef = doc(collection(db, 'users', userId, 'books', id, 'updates'));

    const pagesRead = currentPage - previousPage;

    // Add the reading session document
    batch.set(sessionRef, {
      owner: ownerRef,
      book: bookRef,
      type: 'reading',
      timeRead,
      fromPage: previousPage,
      toPage: currentPage,
      pagesRead,
      updatedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    });

    // Update book with incremented aggregates
    batch.update(bookRef, {
      currentPage,
      pagesRead: increment(pagesRead),
      timeRead: increment(timeRead),
      updatedAt: serverTimestamp(),
    });

    await batch.commit();
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

  static async updateReadingSession({ userId, bookId, sessionId, timeRead, fromPage, toPage }) {
    const batch = writeBatch(db);
    const sessionRef = doc(db, 'users', userId, 'books', bookId, 'updates', sessionId);
    const bookRef = doc(db, 'users', userId, 'books', bookId);

    // Read the old session data to calculate deltas
    const sessionSnap = await getDoc(sessionRef);
    if (!sessionSnap.exists()) {
      throw new Error('Session not found');
    }

    const oldData = sessionSnap.data();
    const oldTimeRead = oldData.timeRead || 0;
    const oldPagesRead = oldData.toPage - oldData.fromPage;

    const newPagesRead = toPage - fromPage;
    const deltaTime = timeRead - oldTimeRead;
    const deltaPages = newPagesRead - oldPagesRead;

    // Update the session
    batch.update(sessionRef, {
      timeRead,
      fromPage,
      toPage,
      pagesRead: newPagesRead,
      updatedAt: serverTimestamp(),
    });

    // Update book aggregates with deltas and new currentPage
    batch.update(bookRef, {
      currentPage: toPage,
      pagesRead: increment(deltaPages),
      timeRead: increment(deltaTime),
      updatedAt: serverTimestamp(),
    });

    await batch.commit();
  }

  static async deleteReadingSession(userId, bookId, sessionId) {
    const batch = writeBatch(db);
    const sessionRef = doc(db, 'users', userId, 'books', bookId, 'updates', sessionId);
    const bookRef = doc(db, 'users', userId, 'books', bookId);

    // Read the session data before deleting to know what to decrement
    const sessionSnap = await getDoc(sessionRef);
    if (!sessionSnap.exists()) {
      throw new Error('Session not found');
    }

    const sessionData = sessionSnap.data();
    const timeRead = sessionData.timeRead || 0;
    const pagesRead = sessionData.toPage - sessionData.fromPage;

    // Delete the session
    batch.delete(sessionRef);

    // Update book by decrementing aggregates and setting currentPage to fromPage
    batch.update(bookRef, {
      currentPage: sessionData.fromPage,
      pagesRead: increment(-pagesRead),
      timeRead: increment(-timeRead),
      updatedAt: serverTimestamp(),
    });

    await batch.commit();
  }

  static getReadingSessions(userId, bookId) {
    const store = writable([]);

    const q = query(
      collection(db, 'users', userId, 'books', bookId, 'updates')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const sessions = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        if (data.type === 'reading') {
          sessions.push({ id: doc.id, ...data });
        }
      });
      // Sort by createdAt descending on the client side
      sessions.sort((a, b) => {
        const aTime = a.createdAt?.toMillis?.() || 0;
        const bTime = b.createdAt?.toMillis?.() || 0;
        return bTime - aTime;
      });
      store.set(sessions);
    });

    return {
      subscribe: store.subscribe,
      unsubscribe
    };
  }

  // Get all reading sessions across all books for a user using collectionGroup
  static getAllReadingSessions(userId) {
    const store = writable([]);

    const ownerRef = doc(db, 'users', userId);
    const q = query(
      collectionGroup(db, 'updates'),
      where('owner', '==', ownerRef),
      where('type', '==', 'reading')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const sessions = [];
      snapshot.forEach((doc) => {
        sessions.push({ id: doc.id, ...doc.data() });
      });
      store.set(sessions);
    });

    return {
      subscribe: store.subscribe,
      unsubscribe
    };
  }
}

export { Database };
