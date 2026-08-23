import {
  collection,
  collectionGroup,
  doc,
  query,
  where,
  orderBy,
  onSnapshot,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  deleteField,
  getDoc,
  getDocsFromServer,
  runTransaction,
  writeBatch,
  increment,
  Timestamp,
  serverTimestamp,
  initializeFirestore,
  connectFirestoreEmulator,
  persistentLocalCache,
  persistentMultipleTabManager
} from 'firebase/firestore';
import { writable } from 'svelte/store';
import { app } from './index.js';
import { auth } from './auth.js';
import { addError } from '../stores/errors.js';
import { isFinished } from '../utils/finished.js';
import { authorIdFor, joinPersonName } from '../utils/authors.js';

// Persistent local cache makes the app work offline: snapshots serve from
// IndexedDB and writes queue locally, syncing when connectivity returns.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

// Migration-rehearsal hook (MIGRATIONS.md): VITE_EMULATOR=1 npm run dev
// points the dev client at the local emulators to exercise real client
// code against migrated snapshot data. DEV-gated so it cannot ship.
if (import.meta.env.DEV && import.meta.env.VITE_EMULATOR) {
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}

// The stalled-Toggl-sync sweep runs at most once per session, not on every
// remount of the book list.
let togglSweepDone = false;

// With the persistent cache, listeners never error on network loss (they
// serve from IndexedDB), so anything reaching this callback is a real
// problem (e.g. permission-denied) that would otherwise render empty lists.
// The listener is dead after this fires; the banner is the only signal.
// Log the full error too: supplying an observer mutes the SDK's own console
// output, which carries details like index-creation URLs.
const listenError = (label) => (error) => {
  console.error(error);
  addError(`Couldn't ${label} (${error.code}).`);
  logIssue({ level: 'error', event: 'firestore.listener_failed', message: `Couldn't ${label}`, code: error.code });
};

// How long a logged issue is kept. Written as an absolute expiry because
// that is what a Firestore TTL policy consumes: the policy deletes a doc
// once the timestamp in its TTL field has passed.
const ISSUE_RETENTION_DAYS = 90;

// Persist a warn/error event to the logEvents collection, where the admin
// overview surfaces it. Rules pin uid to the current session (null when
// signed out — failed sign-ins carry the attempted address in detail.email
// instead). Never pass secrets in message/code/detail, and prefer operation
// names over user content: the operator reads this log, so another user's
// book titles do not belong in it. Fire-and-forget with a console-only
// catch: the logger reporting the app's failures must not feed back into
// addError, or a Firestore outage would recurse.
//
// createdAt is serverTimestamp(), not a device clock, because the admin
// panel orders by it: a client-chosen value lets anyone pin rows to the top
// of that view forever, and a skewed clock silently drops honest rows out
// of the query window. The cost is that an issue logged offline is stamped
// when the queue flushes rather than when it happened — the right trade for
// a feed whose ordering has to be trustworthy.
export function logIssue({ level, event, message, code = null, detail = null }) {
  addDoc(collection(db, 'logEvents'), {
    level,
    // Every field is truncated to the cap the rules enforce; one oversized
    // value would otherwise reject the whole row and lose the event.
    event: event.slice(0, 100),
    message: message.slice(0, 1000),
    code: code === null ? null : String(code).slice(0, 100),
    uid: auth.currentUser?.uid ?? null,
    detail: detail?.email ? { email: detail.email.slice(0, 320) } : null,
    createdAt: serverTimestamp(),
    expiresAt: Timestamp.fromMillis(
      Date.now() + ISSUE_RETENTION_DAYS * 24 * 60 * 60 * 1000
    ),
  }).catch((error) => console.error('logIssue failed', error));
}

// The stored author-doc name fields for a given kind: persons derive the
// display name from their explicit, user-confirmed parts; other kinds are
// just the raw name. Shared by minting and the authors-page edit.
function authorNameFields({ kind, name, givenName, familyName }) {
  const person = kind === 'person';
  const displayName = person
    ? joinPersonName({ givenName: givenName.trim().replace(/\s+/g, ' '), familyName: familyName.trim().replace(/\s+/g, ' ') })
    : name.trim().replace(/\s+/g, ' ');
  return {
    name: displayName,
    nameLower: displayName.toLowerCase(),
    kind,
    // deleteField() rather than omission so an edit can change kind or
    // clear a mononym's given name without leaving stale parts behind.
    givenName: person && givenName.trim() !== '' ? givenName.trim().replace(/\s+/g, ' ') : deleteField(),
    familyName: person ? familyName.trim().replace(/\s+/g, ' ') : deleteField(),
  };
}

// Resolve author chips into the id array stored on the book, minting
// author docs for new authors in the same batch as the book write so the
// collection can never disagree with the books that reference it —
// offline included. Existing chips ({id, name}) pass through untouched: a
// book write must never rewrite an author doc, or renames made on the
// authors page would be silently reverted. New chips carry the kind and
// the user-confirmed name parts from the entry form and mint with the
// deterministic creation-time id (convergent offline merge-upserts).
function resolveAuthorIds(batch, userId, chips) {
  return chips.map((chip) => {
    if (chip.id !== null) return chip.id;
    const fields = authorNameFields(chip);
    const id = authorIdFor(fields.name);
    batch.set(
      doc(db, 'users', userId, 'authors', id),
      { ...fields, updatedAt: Timestamp.now() },
      { merge: true }
    );
    return id;
  });
}

class Database {
  // Returns a Svelte store that listens to the user document.
  // Starts as undefined (loading) so consumers can distinguish "not yet
  // loaded" from the first snapshot; user docs always exist (created by
  // the createUserDocument auth trigger).
  static getUser(userId) {
    const store = writable(undefined);

    const unsubscribe = onSnapshot(doc(db, 'users', userId), (snapshot) => {
      store.set(snapshot.data() ?? null);
    }, listenError('load your profile'));

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
    }, listenError('load your books'));

    // Return store with unsubscribe method
    return {
      subscribe: store.subscribe,
      unsubscribe
    };
  }

  // Returns a Svelte store with all books (for statistics). Deliberately
  // unordered: orderBy('createdAt') silently omits documents that lack the
  // field, and books created by early versions of the app do — which made
  // this store, and every statistic derived from it, quietly undercount.
  // Nothing downstream depends on the order.
  //
  // Starts as undefined (loading, getUser convention): the Me page's
  // profile sync must be able to tell "no snapshot yet" from "library is
  // empty", or it would publish zeroed stats on every page load.
  static getAllBooks(userId) {
    const store = writable(undefined);

    const q = query(collection(db, 'users', userId, 'books'));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const books = [];
      snapshot.forEach((doc) => {
        books.push({ id: doc.id, ...doc.data() });
      });
      store.set(books);
    }, listenError('load your books'));

    return {
      subscribe: store.subscribe,
      unsubscribe
    };
  }

  // All author docs, for autocomplete and the book-list join. Deliberately
  // unordered (see getAllBooks for why orderBy is a trap); sorted
  // client-side. Starts as undefined (loading, getUser convention) so the
  // join can distinguish "not yet loaded" from an empty collection.
  static getAuthors(userId) {
    const store = writable(undefined);

    const q = query(collection(db, 'users', userId, 'authors'));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const authors = [];
      snapshot.forEach((doc) => {
        authors.push({ id: doc.id, ...doc.data() });
      });
      authors.sort((a, b) => (a.nameLower < b.nameLower ? -1 : a.nameLower > b.nameLower ? 1 : 0));
      store.set(authors);
    }, listenError('load your authors'));

    return {
      subscribe: store.subscribe,
      unsubscribe
    };
  }

  // The signed-in user's own public profile doc, found by uid because the
  // username is the doc id and only the doc itself records the mapping.
  // The rules restrict list to uid == auth.uid, which this query provably
  // satisfies. undefined → loading, null → no profile (getUser convention).
  static getMyProfile(userId) {
    const store = writable(undefined);

    const q = query(collection(db, 'profiles'), where('uid', '==', userId));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const profileDoc = snapshot.docs[0];
      store.set(profileDoc ? { username: profileDoc.id, ...profileDoc.data() } : null);
    }, listenError('load your public profile'));

    return {
      subscribe: store.subscribe,
      unsubscribe
    };
  }

  // One-shot read for the /profiles/<username> page; null when the profile
  // doesn't exist or isn't visible to this viewer. The rules answer
  // permission-denied both for a private profile read by a non-owner and
  // for a missing doc, so the two are deliberately indistinguishable here
  // (username existence must not leak). No listener — a shared link is a
  // snapshot view.
  static async getProfile(username) {
    const snapshot = await getDoc(doc(db, 'profiles', username)).catch((error) => {
      if (error.code === 'permission-denied') return null;
      throw error;
    });
    return snapshot?.exists() ? { username: snapshot.id, ...snapshot.data() } : null;
  }

  // setDoc, not addDoc: the username is the doc id. If the username is
  // already taken the rules evaluate this as an update of someone else's
  // doc and reject it, so the caller sees permission-denied and reports
  // "taken" inline — which is why this method is not in writeLabels.
  // isPublic is the explicit share checkbox; profiles are born private.
  static async createProfile({ userId, username, givenName, familyName, isPublic, stats, years }) {
    await setDoc(doc(db, 'profiles', username), {
      uid: userId,
      public: isPublic,
      givenName,
      familyName,
      stats,
      years,
      updatedAt: Timestamp.now(),
    });
  }

  // Full overwrite with the freshly computed payload (the Me page keeps the
  // published doc in step with live stats whenever it differs, and the
  // profile-edit form and visibility checkbox write through here too).
  static async updateProfile({ userId, username, givenName, familyName, isPublic, stats, years }) {
    await setDoc(doc(db, 'profiles', username), {
      uid: userId,
      public: isPublic,
      givenName,
      familyName,
      stats,
      years,
      updatedAt: Timestamp.now(),
    });
  }

  // Changing the username means moving the doc (the username IS the doc
  // id): one batch that creates the new doc and deletes the old, so the
  // profile is never gone or doubled — offline included. A taken new
  // username rejects the whole batch (see createProfile), which is why
  // this, like createProfile, stays out of writeLabels and reports inline.
  static async renameProfile({ userId, oldUsername, newUsername, givenName, familyName, isPublic, stats, years }) {
    const batch = writeBatch(db);
    batch.set(doc(db, 'profiles', newUsername), {
      uid: userId,
      public: isPublic,
      givenName,
      familyName,
      stats,
      years,
      updatedAt: Timestamp.now(),
    });
    batch.delete(doc(db, 'profiles', oldUsername));
    await batch.commit();
  }

  static async deleteProfile({ userId, username }) {
    await deleteDoc(doc(db, 'profiles', username));
  }

  static async addPageUpdate({ userId, id, currentPage, previousPage, pageCount }) {
    const batch = writeBatch(db);
    const bookRef = doc(db, 'users', userId, 'books', id);
    const updateRef = doc(collection(db, 'users', userId, 'books', id, 'updates'));

    // Add the update document. Client timestamps, not serverTimestamp():
    // offline writes sync hours later and would otherwise be stamped with
    // the reconnect time, landing on the wrong day in the heatmap.
    batch.set(updateRef, {
      owner: doc(db, 'users', userId),
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
      finished: isFinished(currentPage, pageCount),
      updatedAt: Timestamp.now(),
    });

    await batch.commit();
  }

  static async addReading({ userId, id, previousPage, currentPage, timeRead, pageCount }) {
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
      finished: isFinished(currentPage, pageCount),
      pagesRead: increment(pagesRead),
      timeRead: increment(timeRead),
      updatedAt: Timestamp.now(),
    });

    await batch.commit();
  }

  // Books reference authors by id only; names live on the author docs and
  // are joined client-side (bookAuthors). updateBook also deletes the
  // legacy author/authors fields, so their presence on any doc proves an
  // old client wrote it last — the invariant the legacy-wins read rule
  // and the migration re-run policy both stand on.
  static async addBook({ userId, authorChips, title, pageCount, currentPage, isbn }) {
    const batch = writeBatch(db);
    const ownerRef = doc(db, 'users', userId);
    const bookRef = doc(collection(db, 'users', userId, 'books'));

    batch.set(bookRef, {
      authorIds: resolveAuthorIds(batch, userId, authorChips),
      currentPage,
      finished: isFinished(currentPage, pageCount),
      owner: ownerRef,
      pageCount,
      pagesRead: 0,
      timeRead: 0,
      title,
      isbn,
      updatedAt: Timestamp.now(),
      createdAt: Timestamp.now(),
    });

    await batch.commit();
  }

  static async updateBook({ userId, bookId, authorChips, title, pageCount, currentPage, isbn }) {
    const batch = writeBatch(db);
    const bookRef = doc(db, 'users', userId, 'books', bookId);

    // currentPage is the book's existing value, passed in only so the
    // finished flag tracks the (possibly edited) pageCount; the page
    // itself is not written here.
    batch.update(bookRef, {
      authorIds: resolveAuthorIds(batch, userId, authorChips),
      author: deleteField(),
      authors: deleteField(),
      title,
      pageCount,
      finished: isFinished(currentPage, pageCount),
      isbn,
      updatedAt: Timestamp.now(),
    });

    await batch.commit();
  }

  // Author entity mutations, driven by the /authors page. Rename and
  // kind/name-part edits touch only the author doc — every book shows the
  // new values through the id join, which is the point of id-only refs.
  // The doc id deliberately stays put (opaque after creation). `name` is
  // read only for non-person kinds; persons derive it from the parts.
  static async updateAuthor({ userId, authorId, name, kind, givenName, familyName }) {
    await updateDoc(doc(db, 'users', userId, 'authors', authorId), {
      ...authorNameFields({ kind, name, givenName, familyName }),
      updatedAt: Timestamp.now(),
    });
  }

  // The caller passes the referencing books ({id, authorIds}, legacy refs
  // already resolved) from its live snapshot, so the merge is one
  // offline-capable batch with no server read. Replacing source with
  // target in place preserves author order and dedupes when a book lists
  // both; legacy fields are deleted on every touched book (old-client-
  // wrote-last invariant); updatedAt is deliberately untouched so a merge
  // never reorders the reading list; and the source doc is deleted LAST
  // so nothing ever references a doc the batch didn't also fix. One op
  // per referencing book + 1 delete stays far under the 500-op batch
  // limit at this library's size — commit() throws loudly if that ever
  // changes. sourceName/targetName exist for writeLabels only.
  static async mergeAuthors({ userId, sourceId, targetId, sourceName, targetName, books }) {
    const batch = writeBatch(db);
    for (const book of books) {
      const authorIds = [];
      for (const id of book.authorIds) {
        const mapped = id === sourceId ? targetId : id;
        if (!authorIds.includes(mapped)) authorIds.push(mapped);
      }
      batch.update(doc(db, 'users', userId, 'books', book.id), {
        authorIds,
        author: deleteField(),
        authors: deleteField(),
      });
    }
    batch.delete(doc(db, 'users', userId, 'authors', sourceId));
    await batch.commit();
  }

  // Only reachable from the authors page at zero references; the page's
  // live count is the guard, not a re-check here.
  static async deleteAuthor({ userId, authorId, name }) {
    await deleteDoc(doc(db, 'users', userId, 'authors', authorId));
  }

  // Local (non-Toggl) timers reuse the activeTimer field the Toggl flow
  // writes server-side; no entryId marks the timer as local. updatedAt is
  // deliberately untouched so the book list doesn't reorder mid-session.
  // The trailing `title` on this and the other positional write methods is
  // not used by the method body — writeLabels reads it for error messages.
  static async startLocalTimer(userId, bookId, title) {
    await updateDoc(doc(db, 'users', userId, 'books', bookId), {
      activeTimer: { start: new Date().toISOString() },
    });
  }

  static async stopLocalTimer(userId, bookId, title) {
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
  // Flipping status back to 'pending' re-fires the syncqueue trigger. Must
  // read from the server, never the cache: the client has no togglQueue
  // listener, so cached docs are frozen at the locally-written 'pending'
  // and requeuing from them would replay already-synced items.
  //
  // Each flip runs in a transaction so the decision is made against the
  // doc's live state, never the query snapshot: a reconnect-flushed item
  // that a function invocation claimed in the meantime reads 'processing'
  // with a fresh claimedAt and is left alone. Requeuing 'pending' (lost
  // trigger event) and 'error' items is always safe — the server's own
  // claim transaction dedupes concurrent runs — but un-claiming
  // 'processing' could double-sync a live invocation, so that window is
  // six hours: far beyond any function timeout or plausible device clock
  // skew, while still recovering claims whose invocation died.
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
    // Items past the retry cap are poison: the sweep below skips them
    // forever, and the rules allow no client delete, so they sit in the
    // queue for good. Report each one once per device (localStorage), not
    // on every launch — the user can't act on it beyond taking note.
    // attempts increments at claim time, so a doc whose fifth invocation
    // died mid-run sits at 'processing' with attempts 5, just as stuck as
    // a five-time 'error' — but a *live* fifth claim isn't stuck yet, so
    // 'processing' only counts past the same six-hour window the requeue
    // uses. Counted before the requeue transactions so a transaction
    // failure can't swallow the report.
    const stuck = items.docs.filter((item) => {
      const { status, attempts = 0, claimedAt } = item.data();
      if (attempts < 5) return false;
      if (status === 'processing') {
        return claimedAt.toMillis() < Date.now() - 6 * 60 * 60 * 1000;
      }
      return status === 'error';
    });
    const reported = new Set(JSON.parse(localStorage.getItem('togglStuckReported') ?? '[]'));
    const fresh = stuck.filter((item) => !reported.has(item.id));
    if (fresh.length > 0) {
      addError(`${fresh.length} Toggl ${fresh.length === 1 ? 'entry' : 'entries'} permanently failed to sync.`);
      logIssue({
        level: 'warn',
        event: 'toggl.sync_stuck',
        message: `${fresh.length} Toggl ${fresh.length === 1 ? 'entry' : 'entries'} permanently failed to sync`,
      });
    }
    localStorage.setItem('togglStuckReported', JSON.stringify(stuck.map((item) => item.id)));

    await Promise.all(items.docs.map((item) => runTransaction(db, async (tx) => {
      const snap = await tx.get(item.ref);
      const { status, attempts = 0, claimedAt, createdAt } = snap.data() ?? {};
      if (attempts >= 5) return;
      const retry =
        status === 'error' ||
        (status === 'pending' && createdAt.toMillis() < Date.now() - 10 * 60 * 1000) ||
        (status === 'processing' && claimedAt.toMillis() < Date.now() - 6 * 60 * 60 * 1000);
      if (retry) tx.update(item.ref, { status: 'pending' });
    })));
  }

  // Only deletes the book document; the deletebookupdates trigger cascades
  // to the updates subcollection server-side. Deleting the subcollection
  // here would be wrong offline: an offline getDocs silently returns only
  // whatever happens to be cached, orphaning the rest forever.
  static async deleteBook(userId, bookId, title) {
    await deleteDoc(doc(db, 'users', userId, 'books', bookId));
  }

  static async updateReadingSession({ userId, bookId, sessionId, timeRead, fromPage, toPage, pageCount }) {
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
      finished: isFinished(toPage, pageCount),
      pagesRead: increment(deltaPages),
      timeRead: increment(deltaTime),
      updatedAt: Timestamp.now(),
    });

    await batch.commit();
  }

  static async deleteReadingSession(userId, bookId, sessionId, title, pageCount) {
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
      finished: isFinished(sessionData.fromPage, pageCount),
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
    }, listenError('load reading sessions'));

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
    }, listenError('load reading sessions'));

    return {
      subscribe: store.subscribe,
      unsubscribe
    };
  }
}

// Flush-time rejections (offline-queued writes failing on reconnect: rules
// rejections, batch.update on a doc another device deleted) would otherwise
// vanish — the local cache already showed success and callers deliberately
// don't await. Wrap every write so its rejection lands in the global error
// banner, then rethrow so a future awaiting caller still sees it. Only the
// tab that issued a write can observe its rejection: if that tab closes,
// another tab (or the next app start) replays the queued batch with no
// promise attached and the SDK exposes no API for its outcome — the
// multi-tab mutation channel deliberately no-ops callbacks for batches
// that originated elsewhere. Best-effort by design.
const writeLabels = {
  updateProfile: ({ username }) => `update your public profile "${username}"`,
  deleteProfile: ({ username }) => `disable your public profile "${username}"`,
  addPageUpdate: ({ title }) => `save the page update for "${title}"`,
  addReading: ({ title }) => `save the reading session for "${title}"`,
  addBook: ({ title }) => `add "${title}"`,
  updateBook: ({ title }) => `save changes to "${title}"`,
  updateAuthor: ({ name }) => `save changes to author "${name}"`,
  mergeAuthors: ({ sourceName, targetName }) => `merge "${sourceName}" into "${targetName}"`,
  deleteAuthor: ({ name }) => `delete author "${name}"`,
  startLocalTimer: (userId, bookId, title) => `start the timer for "${title}"`,
  stopLocalTimer: (userId, bookId, title) => `stop the timer for "${title}"`,
  enqueueTogglEntry: (userId, entry) => `queue the Toggl entry for "${entry.bookTitle}"`,
  retryStalledTogglSync: () => `retry stalled Toggl syncs`,
  deleteBook: (userId, bookId, title) => `delete "${title}"`,
  updateReadingSession: ({ title }) => `update the reading session for "${title}"`,
  deleteReadingSession: (userId, bookId, sessionId, title) => `delete the reading session for "${title}"`,
};

for (const [name, label] of Object.entries(writeLabels)) {
  const method = Database[name];
  if (!method) throw new Error(`writeLabels: no Database.${name}`);
  Database[name] = (...args) =>
    method.apply(Database, args).catch((error) => {
      // Only banner the account that issued the write: a rejection can
      // arrive after a sign-out or account switch (the offline queue
      // flushes on reconnect, denied by rules for the stale uid), and it
      // must not paint one user's book titles over another's screen.
      // Every write method takes userId first, bare or in an args object.
      const writer = typeof args[0] === 'object' ? args[0].userId : args[0];
      // Same guard for the durable log: the rules pin the row's uid to the
      // current session, so a rejection flushed after an account switch
      // would be misattributed to whoever is signed in now.
      if (auth.currentUser?.uid === writer) {
        addError(`Couldn't ${label(...args)} (${error.code ?? error.message}).`);
        // The banner names the book because it is the user's own screen;
        // the log names only the operation, because the operator reads it
        // and other people's book titles are their private content.
        logIssue({
          level: 'error',
          event: 'firestore.write_failed',
          message: `${name} failed`,
          code: error.code ?? null,
        });
      }
      throw error;
    });
}

export { Database };
