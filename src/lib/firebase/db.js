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
  getDocsFromServer,
  writeBatch,
  increment,
  Timestamp,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager
} from 'firebase/firestore';
import { writable } from 'svelte/store';
import { app } from './index.js';

// Persistent local cache makes the app work offline: snapshots serve from
// IndexedDB and writes queue locally, syncing when connectivity returns.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

// The stalled-Toggl-sync sweep runs at most once per session, not on every
// remount of the book list.
let togglSweepDone = false;

class Database {
  // Returns a Svelte store that listens to the user document.
  // Starts as undefined (loading) so consumers can distinguish "not yet
  // loaded" from the first snapshot; user docs always exist (created by
  // the createUserDocument auth trigger).
  static getUser(userId) {
    const store = writable(undefined);

    const unsubscribe = onSnapshot(doc(db, 'users', userId), (snapshot) => {
      store.set(snapshot.data() ?? null);
    });

    return {
      subscribe: store.subscribe,
      unsubscribe
    };
  }

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

    // Add the update document. Client timestamps, not serverTimestamp():
    // offline writes sync hours later and would otherwise be stamped with
    // the reconnect time, landing on the wrong day in the heatmap.
    batch.set(updateRef, {
      book: bookRef,
      type: 'update',
      fromPage: previousPage,
      toPage: currentPage,
      pagesRead: currentPage - previousPage,
      updatedAt: Timestamp.now(),
      createdAt: Timestamp.now(),
    });

    // Update book with new currentPage and updatedAt
    batch.update(bookRef, {
      currentPage,
      updatedAt: Timestamp.now(),
    });

    await batch.commit();
  }

  static async addReading({ userId, id, previousPage, currentPage, timeRead }) {
    const batch = writeBatch(db);
    const bookRef = doc(db, 'users', userId, 'books', id);
    const ownerRef = doc(db, 'users', userId);
    const sessionRef = doc(collection(db, 'users', userId, 'books', id, 'updates'));

    const pagesRead = currentPage - previousPage;

    // Add the reading session document. Client timestamps so sessions
    // logged offline keep the day they actually happened (see addPageUpdate).
    batch.set(sessionRef, {
      owner: ownerRef,
      book: bookRef,
      type: 'reading',
      timeRead,
      fromPage: previousPage,
      toPage: currentPage,
      pagesRead,
      updatedAt: Timestamp.now(),
      createdAt: Timestamp.now(),
    });

    // Update book with incremented aggregates
    batch.update(bookRef, {
      currentPage,
      pagesRead: increment(pagesRead),
      timeRead: increment(timeRead),
      updatedAt: Timestamp.now(),
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
      updatedAt: Timestamp.now(),
      createdAt: Timestamp.now(),
    });
  }

  static async updateBook({ userId, bookId, author, title, pageCount, isbn }) {
    const bookRef = doc(db, 'users', userId, 'books', bookId);

    await updateDoc(bookRef, {
      author,
      title,
      pageCount,
      isbn,
      updatedAt: Timestamp.now(),
    });
  }

  // Local (non-Toggl) timers reuse the activeTimer field the Toggl flow
  // writes server-side; no entryId marks the timer as local. updatedAt is
  // deliberately untouched so the book list doesn't reorder mid-session.
  static async startLocalTimer(userId, bookId) {
    await updateDoc(doc(db, 'users', userId, 'books', bookId), {
      activeTimer: { start: new Date().toISOString() },
    });
  }

  static async stopLocalTimer(userId, bookId) {
    await updateDoc(doc(db, 'users', userId, 'books', bookId), {
      activeTimer: null,
    });
  }

  // Queue a Toggl operation for the toggl-syncqueue Cloud Function. The doc
  // write sits in the offline queue with everything else, so the trigger
  // fires exactly when connectivity returns — no client-side sync loop.
  static async enqueueTogglEntry(userId, entry) {
    await addDoc(collection(db, 'users', userId, 'togglQueue'), {
      ...entry,
      status: 'pending',
      createdAt: Timestamp.now(),
    });
  }

  // Requeue Toggl sync items that failed or got stuck, once per session.
  // Flipping status back to 'pending' re-fires the syncqueue onWrite
  // trigger. Must read from the server, never the cache: the client has no
  // togglQueue listener, so cached docs are frozen at the locally-written
  // 'pending' and requeuing from them would replay already-synced items.
  // 'error' items retry up to the attempt cap; 'processing' only when the
  // claim is older than 10 minutes (far beyond the 60s function timeout,
  // so no live invocation can still own the item); 'pending' only when
  // stale, meaning the original trigger event was lost.
  static async retryStalledTogglSync(userId) {
    if (togglSweepDone || !navigator.onLine) return;
    togglSweepDone = true;
    let items;
    try {
      items = await getDocsFromServer(query(
        collection(db, 'users', userId, 'togglQueue'),
        where('status', 'in', ['pending', 'processing', 'error'])
      ));
    } catch {
      // navigator.onLine lied; the reconnect flush will handle pending
      // items and the next real online session will sweep the rest.
      togglSweepDone = false;
      return;
    }
    const staleBefore = Date.now() - 10 * 60 * 1000;
    await Promise.all(items.docs.map((item) => {
      const { status, attempts = 0, claimedAt, createdAt } = item.data();
      const stale = (claimedAt ?? createdAt).toMillis() < staleBefore;
      const retry = status === 'error' ? attempts < 5 : stale;
      return retry ? updateDoc(item.ref, { status: 'pending' }) : null;
    }));
  }

  // Only deletes the book document; the deleteBookUpdates trigger cascades
  // to the updates subcollection server-side. Deleting the subcollection
  // here would be wrong offline: an offline getDocs silently returns only
  // whatever happens to be cached, orphaning the rest forever.
  static async deleteBook(userId, bookId) {
    await deleteDoc(doc(db, 'users', userId, 'books', bookId));
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
      updatedAt: Timestamp.now(),
    });

    // Update book aggregates with deltas and new currentPage
    batch.update(bookRef, {
      currentPage: toPage,
      pagesRead: increment(deltaPages),
      timeRead: increment(deltaTime),
      updatedAt: Timestamp.now(),
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
      updatedAt: Timestamp.now(),
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
