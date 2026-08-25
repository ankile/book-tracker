import {
  collection,
  collectionGroup,
  doc,
  query,
  where,
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
  arrayUnion,
  increment,
  Timestamp,
  serverTimestamp,
  initializeFirestore,
  connectFirestoreEmulator,
  persistentLocalCache,
  persistentMultipleTabManager,
  type FirestoreError,
  type WriteBatch,
} from 'firebase/firestore';
import { derived, type Readable, type Unsubscriber } from 'svelte/store';
import { FirebaseError } from 'firebase/app';
import { app } from './index.ts';
import { auth } from './auth.ts';
import { addError } from '../stores/errors.ts';
import { cachedReadable } from '../stores/cached-readable.ts';
import { isFinished } from '../utils/finished.ts';
import {
  isTogglSweepTransactionCandidate,
  readTogglReportedIds,
  togglQueueId,
  writeTogglReportedIds,
} from '../utils/toggl.ts';
import { authorIdFor, joinPersonName } from '../utils/authors.ts';
import { invokeReportedWrite } from '../utils/offlineWrite.ts';
import {
  queueReadingSessionDelete,
  queueReadingSessionUpdate,
} from './readingSessionWrites.ts';
import type { Author, AuthorChip, AuthorKind } from '../interfaces/author.ts';
import type { Book } from '../interfaces/book.ts';
import type { BookMetadata } from '../interfaces/metadata.ts';
import type { Profile, ProfileLink, ProfilePayload } from '../interfaces/profile.ts';
import type { BookUpdate, ReadingSession } from '../interfaces/reading.ts';
import {
  decodeAuthor,
  decodeBook,
  decodeBookUpdate,
  decodeLiveQueueSweepItem,
  decodeProfile,
  decodeQueueSweepBatch,
  decodeUser,
  type NewQueueOperation,
  type UserDocument,
} from './decoders.ts';

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

// The stalled-Toggl-sync sweep runs once per signed-in account per session,
// not once globally: this tab can switch accounts without a reload.
const togglSweptUsers = new Set<string>();

// With the persistent cache, listeners never error on network loss (they
// serve from IndexedDB), so anything reaching this callback is a real
// problem (e.g. permission-denied) that would otherwise render empty lists.
// The listener is dead after this fires; the banner is the only signal.
// Log the full error too: supplying an observer mutes the SDK's own console
// output, which carries details like index-creation URLs.
const listenError = (label: string) => (error: FirestoreError) => {
  console.error(error);
  addError(`Couldn't ${label} (${error.code}).`);
  logIssue({ level: 'error', event: 'firestore.listener_failed', message: `Couldn't ${label}`, code: error.code });
};

// Firestore's IndexedDB cache survives reloads, but each new listener still
// delivers its first snapshot asynchronously. Keep one store per query in
// module memory so route remounts can render the last snapshot immediately.
// cachedReadable stops unused Firestore listeners while retaining their data.
const userStores = new Map<string, Readable<UserDocument | null | undefined>>();
const booksStores = new Map<string, Readable<Book[]>>();
const allBooksStores = new Map<string, Readable<Book[] | undefined>>();
const authorsStores = new Map<string, Readable<Author[] | undefined>>();
const profileStores = new Map<string, Readable<Profile | null | undefined>>();
const readingSessionsStores = new Map<string, Readable<ReadingSession[]>>();
const allReadingSessionsStores = new Map<string, Readable<BookUpdate[] | undefined>>();

type StoreStart<T> = (set: (value: T) => void) => Unsubscriber;

function cachedStore<T>(
  cache: Map<string, Readable<T>>,
  key: string,
  initialValue: T,
  start: StoreStart<T>,
): Readable<T> {
  if (!cache.has(key)) {
    cache.set(key, cachedReadable(initialValue, start));
  }
  const store = cache.get(key);
  if (!store) throw new Error(`cachedStore failed to initialize ${key}`);
  return store;
}

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
interface IssueInput {
  level: 'warn' | 'error';
  event: string;
  message: string;
  code?: string | null;
  detail?: { email: string } | null;
}

export function logIssue({
  level,
  event,
  message,
  code = null,
  detail = null,
}: IssueInput): void {
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

// Decoder failures are schema violations, not missing records. Keep them
// fail-loud so corrupt data can never be mistaken for an empty library or
// republished as zeroed profile statistics, but surface a visible error before
// rethrowing: exceptions raised inside an onSnapshot next callback do not flow
// to the listener's error callback.
function decodeStored<T>(decode: () => T): T {
  try {
    return decode();
  } catch (error) {
    addError('Invalid data.');
    // Anonymous clients can read public profiles, but allowing anonymous
    // decode telemetry would give anyone a free write-spam endpoint.
    if (auth.currentUser !== null) {
      logIssue({
        level: 'error',
        event: 'firestore.decode_failed',
        message: 'Invalid data.',
      });
    }
    throw error;
  }
}

interface AuthorNameInput {
  kind: AuthorKind;
  name: string;
  givenName: string;
  familyName: string;
}

interface ProfileWrite extends ProfilePayload {
  userId: string;
  username: string;
  givenName: string;
  familyName: string;
  links: ProfileLink[];
  isPublic: boolean;
}

interface RenameProfileWrite extends Omit<ProfileWrite, 'username'> {
  oldUsername: string;
  newUsername: string;
}

interface AddProfileLinkInput {
  userId: string;
  username: string;
  link: ProfileLink;
}

interface AddPageUpdateInput {
  userId: string;
  id: string;
  currentPage: number;
  previousPage: number;
  pageCount: number;
  title: string;
}

interface AddReadingInput extends AddPageUpdateInput {
  timeRead: number;
}

interface AddBookInput {
  userId: string;
  authorChips: AuthorChip[];
  title: string;
  pageCount: number;
  currentPage: number;
  isbn: string;
  metadata: BookMetadata;
}

interface UpdateBookInput extends AddBookInput {
  bookId: string;
}

interface UpdateAuthorInput extends AuthorNameInput {
  userId: string;
  authorId: string;
}

interface MergeAuthorsInput {
  userId: string;
  sourceId: string;
  targetId: string;
  sourceName: string;
  targetName: string;
}

interface DeleteAuthorInput {
  userId: string;
  authorId: string;
  name: string;
}

interface UpdateReadingSessionInput {
  userId: string;
  bookId: string;
  session: ReadingSession;
  bookProgress: Pick<Book, 'currentPage' | 'currentPageUpdateId' | 'pageCount'>;
  timeRead: number;
  fromPage: number;
  toPage: number;
  title: string;
}

interface DeleteReadingSessionInput {
  userId: string;
  bookId: string;
  session: ReadingSession;
  bookProgress: Pick<Book, 'currentPage' | 'currentPageUpdateId' | 'pageCount'>;
  title: string;
}

// The stored author-doc name fields for a given kind: persons derive the
// display name from their explicit, user-confirmed parts; other kinds are
// just the raw name. Shared by minting and the authors-page edit.
function authorNameFields({ kind, name, givenName, familyName }: AuthorNameInput) {
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
function resolveAuthorIds(batch: WriteBatch, userId: string, chips: AuthorChip[]): string[] {
  return chips.map((chip) => {
    if (chip.id !== null) return chip.id;
    const fields = authorNameFields(chip.kind === 'person'
      ? chip
      : { ...chip, givenName: '', familyName: '' });
    const id = authorIdFor(fields.name);
    batch.set(
      doc(db, 'users', userId, 'authors', id),
      { ...fields, retirement: deleteField(), updatedAt: Timestamp.now() },
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
  static getUser(userId: string): Readable<UserDocument | null | undefined> {
    return cachedStore(userStores, userId, undefined, (set) => (
      onSnapshot(doc(db, 'users', userId), (snapshot) => {
        set(snapshot.exists()
          ? decodeStored(
            () => decodeUser(snapshot.data(), snapshot.ref.path),
          )
          : null);
      }, listenError('load your profile'))
    ));
  }

  // Returns a Svelte store that listens to book updates
  static getBooks(userId: string, finished: boolean): Readable<Book[]> {
    const key = `${userId}:${finished}`;
    if (!booksStores.has(key)) {
      booksStores.set(key, derived(this.getAllBooks(userId), (books) => (
        (books ?? [])
          .filter((book) => book.finished === finished)
          .toSorted((a, b) => {
            const aTime = a.updatedAt?.toMillis?.() ?? 0;
            const bTime = b.updatedAt?.toMillis?.() ?? 0;
            return bTime - aTime;
          })
      )));
    }
    const store = booksStores.get(key);
    if (!store) throw new Error(`books store ${key} was not initialized`);
    return store;
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
  static getAllBooks(userId: string): Readable<Book[] | undefined> {
    return cachedStore(allBooksStores, userId, undefined, (set) => {
      const q = query(collection(db, 'users', userId, 'books'));

      return onSnapshot(q, (snapshot) => {
        const books = snapshot.docs.map((bookDoc) => decodeStored(
          () => decodeBook(bookDoc.id, bookDoc.data(), bookDoc.ref.path),
        ));
        set(books);
      }, listenError('load your books'));
    });
  }

  // All author docs, for autocomplete and the book-list join. Deliberately
  // unordered (see getAllBooks for why orderBy is a trap); sorted
  // client-side. Starts as undefined (loading, getUser convention) so the
  // join can distinguish "not yet loaded" from an empty collection.
  static getAuthors(userId: string): Readable<Author[] | undefined> {
    return cachedStore(authorsStores, userId, undefined, (set) => {
      const q = query(collection(db, 'users', userId, 'authors'));

      return onSnapshot(q, (snapshot) => {
        const authors = snapshot.docs.map((authorDoc) => decodeStored(
          () => decodeAuthor(authorDoc.id, authorDoc.data(), authorDoc.ref.path),
        ));
        authors.sort((a, b) => (a.nameLower < b.nameLower ? -1 : a.nameLower > b.nameLower ? 1 : 0));
        set(authors);
      }, listenError('load your authors'));
    });
  }

  // The signed-in user's own public profile doc, found by uid because the
  // username is the doc id and only the doc itself records the mapping.
  // The rules restrict list to uid == auth.uid, which this query provably
  // satisfies. undefined → loading, null → no profile (getUser convention).
  static getMyProfile(userId: string): Readable<Profile | null | undefined> {
    return cachedStore(profileStores, userId, undefined, (set) => {
      const q = query(collection(db, 'profiles'), where('uid', '==', userId));

      return onSnapshot(q, (snapshot) => {
        const profileDoc = snapshot.docs[0];
        set(profileDoc
          ? decodeStored(
            () => decodeProfile(profileDoc.id, profileDoc.data(), profileDoc.ref.path),
          )
          : null);
      }, listenError('load your public profile'));
    });
  }

  // One-shot read for the /profiles/<username> page; null when the profile
  // doesn't exist or isn't visible to this viewer. The rules answer
  // permission-denied both for a private profile read by a non-owner and
  // for a missing doc, so the two are deliberately indistinguishable here
  // (username existence must not leak). No listener — a shared link is a
  // snapshot view.
  static async getProfile(username: string): Promise<Profile | null> {
    const snapshot = await getDoc(doc(db, 'profiles', username)).catch((error) => {
      if (error instanceof FirebaseError && error.code === 'permission-denied') return null;
      throw error;
    });
    return snapshot?.exists()
      ? decodeStored(
        () => decodeProfile(snapshot.id, snapshot.data(), snapshot.ref.path),
      )
      : null;
  }

  // setDoc, not addDoc: the username is the doc id. If the username is
  // already taken the rules evaluate this as an update of someone else's
  // doc and reject it, so the caller sees permission-denied and reports
  // "taken" inline — which is why this method is not in writeLabels.
  // isPublic is the explicit share checkbox; profiles are born private.
  static async createProfile({ userId, username, givenName, familyName, links, isPublic, stats, records, years, days }: ProfileWrite): Promise<void> {
    await setDoc(doc(db, 'profiles', username), {
      uid: userId,
      public: isPublic,
      givenName,
      familyName,
      links,
      stats,
      records,
      years,
      days,
      updatedAt: Timestamp.now(),
    });
  }

  // Full overwrite with the freshly computed payload (the Me page keeps the
  // published doc in step with live stats whenever it differs, and the
  // profile-edit form and visibility checkbox write through here too).
  static async updateProfile({ userId, username, givenName, familyName, links, isPublic, stats, records, years, days }: ProfileWrite): Promise<void> {
    await setDoc(doc(db, 'profiles', username), {
      uid: userId,
      public: isPublic,
      givenName,
      familyName,
      links,
      stats,
      records,
      years,
      days,
      updatedAt: Timestamp.now(),
    });
  }

  // Target only the link being added: a full-profile rewrite built from a
  // listener snapshot could overwrite a link accepted concurrently by
  // another client. arrayUnion also deduplicates an exact repeated click.
  static addProfileLink({ username, link }: AddProfileLinkInput): Promise<void> {
    return updateDoc(doc(db, 'profiles', username), {
      links: arrayUnion(link),
      updatedAt: Timestamp.now(),
    });
  }

  // Changing the username means moving the doc (the username IS the doc
  // id): one batch that creates the new doc and deletes the old, so the
  // profile is never gone or doubled — offline included. A taken new
  // username rejects the whole batch (see createProfile), which is why
  // this, like createProfile, stays out of writeLabels and reports inline.
  static async renameProfile({ userId, oldUsername, newUsername, givenName, familyName, links, isPublic, stats, records, years, days }: RenameProfileWrite): Promise<void> {
    const batch = writeBatch(db);
    batch.set(doc(db, 'profiles', newUsername), {
      uid: userId,
      public: isPublic,
      givenName,
      familyName,
      links,
      stats,
      records,
      years,
      days,
      updatedAt: Timestamp.now(),
    });
    batch.delete(doc(db, 'profiles', oldUsername));
    await batch.commit();
  }

  static async deleteProfile({ username }: Pick<ProfileWrite, 'userId' | 'username'>): Promise<void> {
    await deleteDoc(doc(db, 'profiles', username));
  }

  static async addPageUpdate({ userId, id, currentPage, previousPage, pageCount }: AddPageUpdateInput): Promise<void> {
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
      currentPageUpdateId: updateRef.id,
      finished: isFinished(currentPage, pageCount),
      updatedAt: Timestamp.now(),
    });

    await batch.commit();
  }

  static async addReading({ userId, id, previousPage, currentPage, timeRead, pageCount }: AddReadingInput): Promise<void> {
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
      currentPageUpdateId: sessionRef.id,
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
  static addBook({ userId, authorChips, title, pageCount, currentPage, isbn, metadata }: AddBookInput): Promise<void> {
    const batch = writeBatch(db);
    const ownerRef = doc(db, 'users', userId);
    const bookRef = doc(collection(db, 'users', userId, 'books'));

    batch.set(bookRef, {
      authorIds: resolveAuthorIds(batch, userId, authorChips),
      currentPage,
      currentPageUpdateId: null,
      finished: isFinished(currentPage, pageCount),
      owner: ownerRef,
      pageCount,
      pagesRead: 0,
      timeRead: 0,
      title,
      isbn,
      // ISBN-derived metadata (utils/bookMetadata.ts shape), defaults when
      // the caller never looked the ISBN up.
      ...metadata,
      updatedAt: Timestamp.now(),
      createdAt: Timestamp.now(),
    });

    return batch.commit();
  }

  static updateBook({ userId, bookId, authorChips, title, pageCount, currentPage, isbn, metadata }: UpdateBookInput): Promise<void> {
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
      ...metadata,
      updatedAt: Timestamp.now(),
    });

    return batch.commit();
  }

  // Author entity mutations, driven by the /authors page. Rename and
  // kind/name-part edits touch only the author doc — every book shows the
  // new values through the id join, which is the point of id-only refs.
  // The doc id deliberately stays put (opaque after creation). `name` is
  // read only for non-person kinds; persons derive it from the parts.
  static async updateAuthor({ userId, authorId, name, kind, givenName, familyName }: UpdateAuthorInput): Promise<void> {
    await updateDoc(doc(db, 'users', userId, 'authors', authorId), {
      ...authorNameFields({ kind, name, givenName, familyName }),
      updatedAt: Timestamp.now(),
    });
  }

  // Merge by retiring the source as a durable redirect. Existing books do
  // not need rewriting: every read canonicalizes redirects, and omitting
  // those writes avoids clobbering a concurrent book edit with authorIds
  // captured from an older UI snapshot. The transaction reads both author
  // docs, so opposing concurrent merges conflict and cannot form a cycle.
  // sourceName/targetName exist for writeLabels only.
  static async mergeAuthors({ userId, sourceId, targetId }: MergeAuthorsInput): Promise<void> {
    const sourceRef = doc(db, 'users', userId, 'authors', sourceId);
    const targetRef = doc(db, 'users', userId, 'authors', targetId);
    await runTransaction(db, async (tx) => {
      const [source, target] = await Promise.all([
        tx.get(sourceRef),
        tx.get(targetRef),
      ]);
      if (!source.exists() || !target.exists()) throw new Error('Both merge authors must exist.');
      const decodedSource = decodeAuthor(source.id, source.data(), source.ref.path);
      const decodedTarget = decodeAuthor(target.id, target.data(), target.ref.path);
      if (decodedSource.retirement !== undefined || decodedTarget.retirement !== undefined) {
        throw new Error('Retired authors cannot participate in another merge. Reload and try again.');
      }
      tx.update(sourceRef, {
        retirement: { reason: 'merged', targetId },
        updatedAt: Timestamp.now(),
      });
    });
  }

  // Retire rather than physically delete. A concurrent/offline book write
  // can still reference this id after the UI's zero-reference snapshot;
  // retaining the document prevents a dangling id while hiding it from
  // future author selection.
  static async deleteAuthor({ userId, authorId }: DeleteAuthorInput): Promise<void> {
    const ref = doc(db, 'users', userId, 'authors', authorId);
    await runTransaction(db, async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists()) throw new Error('Author does not exist.');
      const author = decodeAuthor(snapshot.id, snapshot.data(), snapshot.ref.path);
      if (author.retirement !== undefined) throw new Error('Author is already retired.');
      tx.update(ref, {
        retirement: { reason: 'deleted' },
        updatedAt: Timestamp.now(),
      });
    });
  }

  // Local (non-Toggl) timers reuse the activeTimer field the Toggl flow
  // writes server-side; no entryId marks the timer as local. updatedAt is
  // deliberately untouched so the book list doesn't reorder mid-session.
  // The trailing `title` on this and the other positional write methods is
  // not used by the method body — writeLabels reads it for error messages.
  static async startLocalTimer(userId: string, bookId: string, title: string): Promise<void> {
    await updateDoc(doc(db, 'users', userId, 'books', bookId), {
      activeTimer: { start: new Date().toISOString() },
    });
  }

  static async stopLocalTimer(userId: string, bookId: string, title: string): Promise<void> {
    await updateDoc(doc(db, 'users', userId, 'books', bookId), {
      activeTimer: null,
    });
  }

  // Clear the local book timer and enqueue its Toggl operation in one
  // offline-capable batch. Either both writes are accepted or neither is,
  // so a rules rejection cannot erase the only copy of the interval, and a
  // failed clear cannot leave a duplicate queue item behind.
  static async stopTimerAndEnqueue(
    userId: string,
    bookId: string,
    title: string,
    entry: NewQueueOperation | null,
  ): Promise<void> {
    const batch = writeBatch(db);
    batch.update(doc(db, 'users', userId, 'books', bookId), {
      activeTimer: null,
    });
    if (entry !== null) {
      // The stable id lets rules prove this is the one queue row coupled to
      // this timer clear and prevents a repeated stop minting another row.
      const queueId = togglQueueId(bookId, entry.start);
      batch.set(doc(db, 'users', userId, 'togglQueue', queueId), {
        ...entry,
        bookId,
        status: 'pending',
        createdAt: Timestamp.now(),
      });
    }
    await batch.commit();
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
  static async retryStalledTogglSync(userId: string): Promise<void> {
    if (togglSweptUsers.has(userId) || !navigator.onLine) return;
    togglSweptUsers.add(userId);
    let items;
    try {
      items = await getDocsFromServer(query(
        collection(db, 'users', userId, 'togglQueue'),
        where('status', 'in', ['pending', 'processing', 'error', 'outcome-unknown'])
      ));
    } catch {
      // navigator.onLine lied; the reconnect flush will handle pending
      // items and the next real online session will sweep the rest.
      togglSweptUsers.delete(userId);
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
    const queueDocs = new Map(items.docs.map((item) => [item.id, item]));
    const decoded = decodeQueueSweepBatch(items.docs.map((item) => ({
      id: item.id,
      value: item.data(),
      path: item.ref.path,
    })));
    const decodedItems = decoded.items.map((item) => {
      const snapshot = queueDocs.get(item.id);
      if (!snapshot) throw new Error(`Missing Toggl queue snapshot ${item.id}`);
      return {ref: snapshot.ref, item};
    });
    const uncertain = decodedItems.filter(({ item }) => item.status === 'outcome-unknown');
    const stuck = decodedItems.filter(({ item }) => {
      const { status, attempts, claimedAt } = item;
      if (attempts < 5) return false;
      if (status === 'processing') {
        if (claimedAt === null) throw new Error(`${item.id}: processing queue item has no claimedAt`);
        return claimedAt.toMillis() < Date.now() - 6 * 60 * 60 * 1000;
      }
      return status === 'error';
    });
    const reportedKey = `togglStuckReported:${userId}`;
    const reported = new Set(readTogglReportedIds(localStorage, reportedKey));
    const freshInvalid = decoded.invalidIds.filter((id) => !reported.has(id));
    const freshUncertain = uncertain.filter(({ item }) => !reported.has(item.id));
    const fresh = stuck.filter(({ item }) => !reported.has(item.id));
    if (freshInvalid.length > 0) {
      addError(`${freshInvalid.length} Toggl ${freshInvalid.length === 1 ? 'entry has' : 'entries have'} invalid stored data and was skipped.`);
      logIssue({
        level: 'error',
        event: 'firestore.decode_failed',
        message: `${freshInvalid.length} invalid Toggl queue ${freshInvalid.length === 1 ? 'entry' : 'entries'} skipped`,
      });
    }
    if (freshUncertain.length > 0) {
      addError(`${freshUncertain.length} Toggl ${freshUncertain.length === 1 ? 'entry has' : 'entries have'} an unknown outcome. Check Toggl before adding again.`);
      logIssue({
        level: 'warn',
        event: 'toggl.sync_stuck',
        message: `${freshUncertain.length} Toggl sync ${freshUncertain.length === 1 ? 'outcome is' : 'outcomes are'} unknown`,
      });
    }
    if (fresh.length > 0) {
      addError(`${fresh.length} Toggl ${fresh.length === 1 ? 'entry' : 'entries'} permanently failed to sync.`);
      logIssue({
        level: 'warn',
        event: 'toggl.sync_stuck',
        message: `${fresh.length} Toggl ${fresh.length === 1 ? 'entry' : 'entries'} permanently failed to sync`,
      });
    }
    writeTogglReportedIds(
      localStorage,
      reportedKey,
      [...decoded.invalidIds, ...stuck.map(({ item }) => item.id), ...uncertain.map(({ item }) => item.id)],
    );

    const retryable = decodedItems.filter(({ item }) =>
      isTogglSweepTransactionCandidate(item)
    );
    await Promise.all(retryable.map(({ ref }) => runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      const item = decodeLiveQueueSweepItem(snap.id, snap.data(), snap.ref.path);
      if (item === null) return;
      if (!isTogglSweepTransactionCandidate(item)) return;
      const { status, attempts, claimedAt, createdAt } = item;
      const retry =
        status === 'error' ||
        (status === 'pending' && createdAt.toMillis() < Date.now() - 10 * 60 * 1000) ||
        (status === 'processing' && claimedAt !== null && claimedAt.toMillis() < Date.now() - 6 * 60 * 60 * 1000);
      if (retry) tx.update(ref, {
        status: 'pending',
        retryRequestedAt: serverTimestamp(),
      });
    })));
  }

  // Only deletes the book document; the deletebookupdates trigger cascades
  // to the updates subcollection server-side. Deleting the subcollection
  // here would be wrong offline: an offline getDocs silently returns only
  // whatever happens to be cached, orphaning the rest forever.
  static async deleteBook(userId: string, bookId: string, title: string): Promise<void> {
    await deleteDoc(doc(db, 'users', userId, 'books', bookId));
  }

  static updateReadingSession({ userId, bookId, session, bookProgress, timeRead, fromPage, toPage }: UpdateReadingSessionInput): Promise<void> {
    // The modal can only submit a decoded session and book rendered by live
    // listeners. Planning from that state lets the batch enter Firestore's
    // local queue synchronously with no online transaction or cache read.
    // Rules correlate these deltas with the server's current session; a
    // stale cross-device edit rejects atomically on reconnect.
    return queueReadingSessionUpdate({
      firestore: db,
      userId,
      bookId,
      sessionId: session.id,
      previous: session,
      book: bookProgress,
      next: { timeRead, fromPage, toPage },
    });
  }

  static deleteReadingSession({ userId, bookId, session, bookProgress }: DeleteReadingSessionInput): Promise<void> {
    return queueReadingSessionDelete({
      firestore: db,
      userId,
      bookId,
      sessionId: session.id,
      previous: session,
      book: bookProgress,
    });
  }

  static getReadingSessions(userId: string, bookId: string): Readable<ReadingSession[]> {
    return cachedStore(readingSessionsStores, `${userId}:${bookId}`, [], (set) => {
      const q = query(
        collection(db, 'users', userId, 'books', bookId, 'updates')
      );

      return onSnapshot(q, (snapshot) => {
        const sessions = snapshot.docs.flatMap((sessionDoc) => {
          const update = decodeStored(
            () => decodeBookUpdate(
              sessionDoc.id,
              sessionDoc.data(),
              sessionDoc.ref.path,
            ),
          );
          return update.type === 'reading' ? [update] : [];
        });
        // Sort by createdAt descending on the client side
        sessions.sort((a, b) => {
          const aTime = a.createdAt?.toMillis?.() || 0;
          const bTime = b.createdAt?.toMillis?.() || 0;
          return bTime - aTime;
        });
        set(sessions);
      }, listenError('load reading sessions'));
    });
  }

  // Get all update docs across all books for a user using collectionGroup:
  // 'reading' sessions plus page-only 'update' corrections. The analytics
  // need both — a page-only update can be what finishes a book — and the
  // 'in' filter rides the same owner+type composite index the equality
  // filter used. Starts as undefined (loading, getUser convention): the
  // Me page's profile sync must be able to tell "no snapshot yet" from "no
  // sessions", or it would blank the published heatmap on page load.
  static getAllReadingSessions(userId: string): Readable<BookUpdate[] | undefined> {
    return cachedStore(allReadingSessionsStores, userId, undefined, (set) => {
      const ownerRef = doc(db, 'users', userId);
      const q = query(
        collectionGroup(db, 'updates'),
        where('owner', '==', ownerRef),
        where('type', 'in', ['reading', 'update'])
      );

      return onSnapshot(q, (snapshot) => {
        const sessions = snapshot.docs.map((sessionDoc) => decodeStored(
          () => decodeBookUpdate(sessionDoc.id, sessionDoc.data(), sessionDoc.ref.path),
        ));
        set(sessions);
      }, listenError('load reading sessions'));
    });
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
function errorCode(error: unknown): string {
  if (error instanceof FirebaseError) return error.code;
  if (error instanceof Error) return error.message;
  return String(error);
}

function reportWriteFailures<Args extends unknown[]>(
  name: string,
  writer: (...args: Args) => string,
  label: (...args: Args) => string,
  method: (...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
  return (...args) => invokeReportedWrite(
    () => method(...args),
    (error) => {
      // A queued rejection can arrive after a sign-out or account switch.
      // Never paint one user's title or failure onto another user's screen.
      if (auth.currentUser?.uid === writer(...args)) {
        const code = errorCode(error);
        addError(`Couldn't ${label(...args)} (${code}).`);
        logIssue({
          level: 'error',
          event: 'firestore.write_failed',
          message: `${name} failed`,
          code,
        });
      }
    },
  );
}

Database.updateProfile = reportWriteFailures(
  'updateProfile', ({ userId }) => userId,
  ({ username }) => `update your public profile "${username}"`, Database.updateProfile,
);
Database.addProfileLink = reportWriteFailures(
  'addProfileLink', ({ userId }) => userId,
  ({ username }) => `add a link to your public profile "${username}"`, Database.addProfileLink,
);
Database.deleteProfile = reportWriteFailures(
  'deleteProfile', ({ userId }) => userId,
  ({ username }) => `disable your public profile "${username}"`, Database.deleteProfile,
);
Database.addPageUpdate = reportWriteFailures(
  'addPageUpdate', ({ userId }) => userId,
  ({ title }) => `save the page update for "${title}"`, Database.addPageUpdate,
);
Database.addReading = reportWriteFailures(
  'addReading', ({ userId }) => userId,
  ({ title }) => `save the reading session for "${title}"`, Database.addReading,
);
Database.addBook = reportWriteFailures(
  'addBook', ({ userId }) => userId,
  ({ title }) => `add "${title}"`, Database.addBook,
);
Database.updateBook = reportWriteFailures(
  'updateBook', ({ userId }) => userId,
  ({ title }) => `save changes to "${title}"`, Database.updateBook,
);
Database.updateAuthor = reportWriteFailures(
  'updateAuthor', ({ userId }) => userId,
  ({ name }) => `save changes to author "${name}"`, Database.updateAuthor,
);
Database.mergeAuthors = reportWriteFailures(
  'mergeAuthors', ({ userId }) => userId,
  ({ sourceName, targetName }) => `merge "${sourceName}" into "${targetName}"`, Database.mergeAuthors,
);
Database.deleteAuthor = reportWriteFailures(
  'deleteAuthor', ({ userId }) => userId,
  ({ name }) => `delete author "${name}"`, Database.deleteAuthor,
);
Database.startLocalTimer = reportWriteFailures(
  'startLocalTimer', (userId) => userId,
  (_userId, _bookId, title) => `start the timer for "${title}"`, Database.startLocalTimer,
);
Database.stopLocalTimer = reportWriteFailures(
  'stopLocalTimer', (userId) => userId,
  (_userId, _bookId, title) => `stop the timer for "${title}"`, Database.stopLocalTimer,
);
Database.stopTimerAndEnqueue = reportWriteFailures(
  'stopTimerAndEnqueue', (userId) => userId,
  (_userId, _bookId, title) => `stop and queue the timer for "${title}"`, Database.stopTimerAndEnqueue,
);
Database.retryStalledTogglSync = reportWriteFailures(
  'retryStalledTogglSync', (userId: string) => userId,
  (_userId: string) => 'retry stalled Toggl syncs', Database.retryStalledTogglSync,
);
Database.deleteBook = reportWriteFailures(
  'deleteBook', (userId) => userId,
  (_userId, _bookId, title) => `delete "${title}"`, Database.deleteBook,
);
Database.updateReadingSession = reportWriteFailures(
  'updateReadingSession', ({ userId }) => userId,
  ({ title }) => `update the reading session for "${title}"`, Database.updateReadingSession,
);
Database.deleteReadingSession = reportWriteFailures(
  'deleteReadingSession', ({ userId }) => userId,
  ({ title }) => `delete the reading session for "${title}"`, Database.deleteReadingSession,
);

export { Database };
