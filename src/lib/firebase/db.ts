import {
  clearIndexedDbPersistence,
  collection,
  collectionGroup,
  doc,
  terminate,
  query,
  where,
  onSnapshot,
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
} from 'firebase/firestore';
import { derived, type Readable, type Unsubscriber } from 'svelte/store';
import { FirebaseError } from 'firebase/app';
import { app } from './index.ts';
import { auth } from './auth.ts';
import { reportIssue } from './functions.ts';
import { issueReportPayload, type IssueInput } from '../utils/issueReport.ts';
import { addError } from '../stores/errors.ts';
import { cachedReadable } from '../stores/cached-readable.ts';
import { finishedAtPatch, isFinished } from '../utils/finished.ts';
import {
  isExpectedTogglRetryMarkerDenial,
  isTogglSweepTransactionCandidate,
  readTogglReportedIds,
  togglQueueId,
  writeTogglReportedIds,
} from '../utils/toggl.ts';
import { joinPersonName } from '../utils/authors.ts';
import { MAX_BOOK_AUTHORS } from '../utils/bookForm.ts';
import { invokeReportedWrite } from '../utils/offlineWrite.ts';
import { runRetryableSessionTask } from '../utils/sessionTask.ts';
import {
  activeTimerClaim,
  idleTimerClaim,
  stoppingTimer,
} from '../utils/timerClaim.ts';
import {
  createReadingSessionWriteStore,
  queueReadingSessionDelete,
  queueReadingSessionUpdate,
} from './readingSessionWrites.ts';
import type {
  Author,
  AuthorChip,
  ExistingAuthorChip,
  UnresolvedAuthorChip,
} from '../interfaces/author.ts';
import type { ActiveTimer, Book } from '../interfaces/book.ts';
import type { CatalogSelection } from '../interfaces/catalog.ts';
import type { BookMetadata } from '../interfaces/metadata.ts';
import type {
  Profile,
  ProfileDiscovery,
  ProfileLink,
  ProfilePayload,
  ProfileView,
} from '../interfaces/profile.ts';
import type { BookUpdate, ReadingSession } from '../interfaces/reading.ts';
import { assertProfileViewFor, resolveProfileView } from '../utils/profileRead.ts';
import {
  decodeCatalogAuthor,
  decodeBook,
  decodeBookUpdate,
  decodeLiveQueueSweepItem,
  decodeProfile,
  decodeProfileDiscovery,
  decodeProfileView,
  profileView,
  decodeQueueSweepBatch,
  decodeUser,
  type NewQueueOperation,
  type UserDocument,
} from './decoders.ts';
import { ensureCatalogAuthors } from './functions.ts';

// Persistent local cache makes the app work offline: snapshots serve from
// IndexedDB and writes queue locally, syncing when connectivity returns.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});
const readingSessionWriteStore = createReadingSessionWriteStore(db);

// Migration-rehearsal hook (MIGRATIONS.md): VITE_EMULATOR=1 npm run dev
// points the dev client at the local emulators to exercise real client
// code against migrated snapshot data. DEV-gated so it cannot ship.
if (import.meta.env.DEV && import.meta.env.VITE_EMULATOR) {
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}

// Sign-out tail (SEC-004): terminate the client, drop the IndexedDB
// mirror, and land on the front page with a clean reload — terminate()
// invalidates every listener this module handed out, so the only way
// back is a fresh document. clearIndexedDbPersistence refuses while
// another tab holds the cache (multi-tab persistence); that tab keeps
// its mirror until it closes, which nothing here can change, so the
// refusal is logged and the reload proceeds.
export async function clearLocalData(): Promise<void> {
  // Account-scoped sweep-dedup state (togglStuckReported:<uid>) lives in
  // localStorage and must not survive a sign-out either (review F5).
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('togglStuckReported:')) localStorage.removeItem(key);
  }
  try {
    await terminate(db);
    await clearIndexedDbPersistence(db);
  } catch (error) {
    // clearIndexedDbPersistence refuses while another tab holds the
    // multi-tab persistence lease. That tab keeps the mirror until every
    // tab is closed — a silent console.warn hid exactly the shared-device
    // residual SEC-004 exists to close (review F1), so tell the user.
    console.warn('local cache not cleared', error);
    alert(
      'Signed out, but the locally cached data could not be cleared — ' +
      'another tab of this app is probably open. Close every tab of this ' +
      'site to remove the cached data from this device.',
    );
  } finally {
    location.replace('/');
  }
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
const profileStores = new Map<string, Readable<Profile | null | undefined>>();
const profileDiscoveryStores = new Map<string, Readable<ProfileDiscovery | null | undefined>>();
const bookSharingStores = new Map<string, Readable<BookSharingSettings | null | undefined>>();
const bookUpdatesStores = new Map<string, Readable<BookUpdate[]>>();
const allReadingSessionsStores = new Map<string, Readable<BookUpdate[] | undefined>>();
const catalogAuthorsStore: Readable<Author[] | undefined> = cachedReadable<Author[] | undefined>(
  undefined,
  (set) => onSnapshot(query(collection(db, 'catalogAuthors')), (snapshot) => {
    const authors = snapshot.docs.map((authorDoc) => decodeStored(
      () => decodeCatalogAuthor(authorDoc.id, authorDoc.data(), authorDoc.ref.path),
    ));
    authors.sort((a, b) => (a.nameLower < b.nameLower ? -1 : a.nameLower > b.nameLower ? 1 : 0));
    set(authors);
  }, listenError('load the author catalog')),
);

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

// Report a warn/error event to the durable issue log the admin overview
// surfaces. The row is written by the telemetry-reportissue callable, not
// by this client: the callable pins uid to the caller, allowlists the event,
// bounds every field and counts reports per user (twenty an hour), so
// nothing here can flood the collection or the operator's feed (SEC-001,
// SEC-038). Signed-out clients report nothing (issueReportPayload). Never
// pass secrets in message/code, and prefer operation names over user
// content: the operator reads this log, so another user's book titles do
// not belong in it. Fire-and-forget with a console-only catch: a telemetry
// failure must never become user-visible (an addError here would put the
// callable's rejection text in the banner on every backend hiccup), and
// tests/issue-report.test.ts pins both this line and the session check
// below, since nothing else can import this module. There is no offline
// queue — a report made offline is dropped, not retried — and timestamps
// and retention are server-side.
export function logIssue(input: IssueInput): void {
  const payload = issueReportPayload(auth.currentUser !== null, input);
  if (payload === null) return;
  reportIssue(payload).catch((error) => console.error('logIssue failed', error));
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
    // Anonymous clients decode public profile JSON too; logIssue drops the
    // report when there is no session.
    logIssue({
      level: 'error',
      event: 'firestore.decode_failed',
      message: 'Invalid data.',
    });
    throw error;
  }
}

interface ProfileWrite extends ProfilePayload {
  userId: string;
  username: string;
  givenName: string;
  familyName: string;
  links: ProfileLink[];
  isPublic: boolean;
  removeDiscovery?: boolean;
  removeBookSharing?: boolean;
}

interface RenameProfileWrite extends Omit<ProfileWrite, 'username'> {
  oldUsername: string;
  newUsername: string;
  isDiscoverable: boolean;
  bookSharing: BookSharingSettings | null;
}

export interface BookSharingSettings {
  profileUsername: string;
  timeZone: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

interface EnableBookSharingInput {
  userId: string;
  profileUsername: string;
  timeZone: string;
}

interface ProfileDiscoveryWrite {
  userId: string;
  username: string;
}

function decodeBookSharingSettings(value: unknown, path: string): BookSharingSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${path}: expected an object.`);
  }
  const data = value as Record<string, unknown>;
  const keys = Object.keys(data).sort();
  const expected = ['createdAt', 'profileUsername', 'timeZone', 'updatedAt'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${path}: expected only ${expected.join(', ')}.`);
  }
  if (typeof data.profileUsername !== 'string' || !/^[a-z0-9-]{3,30}$/.test(data.profileUsername)) {
    throw new TypeError(`${path}.profileUsername: expected a profile username.`);
  }
  if (typeof data.timeZone !== 'string' || data.timeZone.length === 0 || data.timeZone.length > 100) {
    throw new TypeError(`${path}.timeZone: expected a non-empty string of at most 100 characters.`);
  }
  if (!(data.createdAt instanceof Timestamp) || !(data.updatedAt instanceof Timestamp)) {
    throw new TypeError(`${path}: expected Firestore timestamps.`);
  }
  return {
    profileUsername: data.profileUsername,
    timeZone: data.timeZone,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  };
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

interface BookInputBase {
  userId: string;
  authorChips: AuthorChip[];
  title: string;
  pageCount: number;
  currentPage: number;
  isbn: string;
  metadata: BookMetadata;
}

interface AddBookInput extends BookInputBase {
  catalogLink: CatalogSelection | null;
}

interface UpdateBookInput extends BookInputBase {
  bookId: string;
  // The stored flag before this edit, so finishedAt is stamped only when
  // the edit is what finishes the book (a shrunk page count can).
  previouslyFinished: boolean;
  pageCountClampFrom: number | null;
  catalogLink?: CatalogSelection | null;
}

function catalogLinkFields(catalogLink: CatalogSelection | null) {
  if (catalogLink === null) {
    return {workId: null, editionId: null, matchMethod: null, linkedAt: null};
  }
  return {...catalogLink, linkedAt: Timestamp.now()};
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
  previousProgressUpdate: Pick<BookUpdate, 'id' | 'toPage'> | null;
  title: string;
}

function storedAuthorIds(chips: AuthorChip[]): string[] {
  if (chips.length > MAX_BOOK_AUTHORS) {
    throw new Error(`A personal book may have at most ${MAX_BOOK_AUTHORS} authors.`);
  }
  const ids = chips.map((chip) => {
    if (chip.id === null) throw new Error('Resolve each new author before saving the book.');
    if ('unresolved' in chip) throw new Error('Replace each unresolved author before saving the book.');
    return chip.id;
  });
  if (new Set(ids).size !== ids.length) {
    throw new Error('A personal book cannot reference the same author twice.');
  }
  return ids;
}

// Public profile projection from the publicweb function. Under `vite dev`
// nothing serves /profiles/*.json — the path falls through to the SPA
// shell — so other people's profiles only resolve against a deployed or
// emulated Hosting stack; the content-type check turns that into a clear
// error instead of a JSON parse failure.
// The renderer inlines the profile as <script id="profile-bootstrap"> on a
// fresh /profiles/<username> load, so the SPA hydrates synchronously instead
// of fetching /profiles/<username>.json and flashing "Loading…". Consumed
// once: the element is removed on read, so a client-side navigation to
// another profile — or a return visit — falls through to the fetch and gets
// fresh data. A malformed or mismatched block is ignored, not surfaced, so a
// broken inline can only cost the fetch it would have replaced.
function readInlineProfile(username: string): ProfileView | undefined {
  if (typeof document === 'undefined') return undefined;
  const element = document.getElementById('profile-bootstrap');
  if (element === null) return undefined;
  const text = element.textContent ?? '';
  element.remove();
  if (text.trim() === '') return undefined;
  try {
    const payload: unknown = JSON.parse(text);
    return assertProfileViewFor(decodeProfileView(payload, `profiles/${username} (inline)`), username);
  } catch {
    return undefined;
  }
}

async function fetchPublicProfile(username: string): Promise<ProfileView | null> {
  // credentials: 'omit' — the CDN varies on cookie, so a first-party cookie
  // would turn the shared cache entry into one per viewer (SEC-092).
  const response = await fetch(`/profiles/${encodeURIComponent(username)}.json`, { credentials: 'omit' });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Public profile request failed with status ${response.status}.`);
  }
  const contentType = response.headers.get('Content-Type') ?? '';
  if (!contentType.startsWith('application/json')) {
    throw new Error(
      `Public profile request returned ${contentType || 'no content type'}; `
      + '/profiles/<username>.json is served by the publicweb function, not by vite dev.',
    );
  }
  const payload: unknown = await response.json();
  // Not decodeStored: that wrapper reports *this* user's own data as
  // broken (error banner + a firestore.decode_failed row written under the
  // viewer's uid). A stranger's malformed public profile must fail only
  // the page it belongs to — the throw is handled by the profile route.
  return assertProfileViewFor(decodeProfileView(payload, `profiles/${username}.json`), username);
}

// The usernames of the signed-in user's own profile documents as last
// confirmed by the server through the getMyProfile listener (the app
// prefetch attaches it on private routes, so this is populated after a
// visit to /me or the library, not on a cold /profiles load): absent until
// a server snapshot has arrived, an empty set when they have none. Only
// server snapshots count — an offline or cache-only snapshot can be empty
// or stale and must not make the owner's own page unreachable — and the
// entry is dropped with the listener. Lets getProfile skip a Firestore
// read that rules would deny for someone else's page; unknown keeps the
// try-then-fall-through order, so the skip can only save a read.
const ownProfileUsernames = new Map<string, Set<string>>();

class Database {
  // Existing catalog authors remain fully offline-capable. A genuinely new
  // author needs one bounded callable so clients cannot edit or merge shared
  // catalog documents directly. The response order matches the new-chip order
  // and ensureCatalogAuthors rejects a response of any other length, so the
  // ids line up positionally. Two chips can name the same author, in which
  // case the catalog answers with one id twice and the duplicate is dropped.
  static async resolveBookAuthors(chips: AuthorChip[]): Promise<AuthorChip[]> {
    if (chips.length > MAX_BOOK_AUTHORS) {
      throw new Error(`A personal book may have at most ${MAX_BOOK_AUTHORS} authors.`);
    }
    const newChips = chips.filter((chip) => chip.id === null);
    if (newChips.length === 0) return chips;
    const response = await ensureCatalogAuthors({
      authors: newChips.map((chip) => ({
        canonicalName: chip.kind === 'person' ? joinPersonName(chip) : chip.name.trim().replace(/\s+/g, ' '),
        sortName: chip.kind === 'person' ? chip.familyName.trim().replace(/\s+/g, ' ') : chip.name.trim().replace(/\s+/g, ' '),
        kind: chip.kind,
      })),
    });
    let newIndex = 0;
    const seen = new Set<string>();
    const resolved: AuthorChip[] = [];
    for (const chip of chips) {
      const entry: ExistingAuthorChip | UnresolvedAuthorChip = chip.id === null
        ? {id: response.authorIds[newIndex++], name: chip.name}
        : chip;
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      resolved.push(entry);
    }
    return resolved;
  }

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

  // The shared author catalog, for autocomplete and the book-list join. One
  // store for everyone: the catalog is not per-user, and the whole collection
  // is listened to on purpose — it is bounded at 5000 documents, and
  // autocomplete needs all of them locally. Deliberately unordered (see
  // getAllBooks for why orderBy is a trap); sorted client-side. Starts as
  // undefined (loading, getUser convention) so the join can distinguish
  // "not yet loaded" from an empty collection.
  static getAuthors(): Readable<Author[] | undefined> {
    return catalogAuthorsStore;
  }

  // The signed-in user's own public profile doc, found by uid because the
  // username is the doc id and only the doc itself records the mapping.
  // The rules restrict list to uid == auth.uid, which this query provably
  // satisfies. undefined → loading, null → no profile (getUser convention).
  static getMyProfile(userId: string): Readable<Profile | null | undefined> {
    return cachedStore(profileStores, userId, undefined, (set) => {
      const q = query(collection(db, 'profiles'), where('uid', '==', userId));

      const stop = onSnapshot(q, (snapshot) => {
        const profileDoc = snapshot.docs[0];
        if (!snapshot.metadata.fromCache) {
          ownProfileUsernames.set(userId, new Set(snapshot.docs.map((d) => d.id)));
        }
        // updatedAt is a serverTimestamp(); the optimistic local snapshot
        // would otherwise carry null until the server acknowledges.
        set(profileDoc
          ? decodeStored(
            () => decodeProfile(
              profileDoc.id,
              profileDoc.data({ serverTimestamps: 'estimate' }),
              profileDoc.ref.path,
            ),
          )
          : null);
      }, listenError('load your public profile'));
      return () => {
        stop();
        ownProfileUsernames.delete(userId);
      };
    });
  }

  // One-shot read for the /profiles/<username> page; null when the profile
  // doesn't exist or isn't visible to this viewer, and the two are
  // deliberately indistinguishable on every read path (a create attempt is
  // the one place a taken username is distinguishable from a free one —
  // first-writer-wins needs that). Public profiles are served by the
  // publicweb function as /profiles/<username>.json — CDN- and
  // instance-cached, no uid on the wire — so a stranger never reads the
  // raw document (SEC-019); the rules allow profile gets only to the owner.
  // A signed-in viewer asks Firestore first unless their own listener has
  // already shown the username is not theirs: the own read succeeds only
  // for their own profile, public or private, and gives the owner a fresh
  // copy instead of a cached one. No listener — a shared link is a snapshot
  // view.
  static async getProfile(username: string): Promise<ProfileView | null> {
    // The owner-vs-public decision reads auth.currentUser, so wait for the
    // session to finish restoring — but only here, not on the public fast
    // path (getPublicProfile), so a public profile still loads without it.
    await auth.authStateReady();
    const viewer = auth.currentUser;
    const own = viewer === null ? undefined : ownProfileUsernames.get(viewer.uid);
    const mayOwn = viewer !== null && (own === undefined || own.has(username));
    return resolveProfileView(
      mayOwn,
      () => Database.getOwnProfile(username),
      () => fetchPublicProfile(username),
    );
  }

  // The public projection alone (no auth). Returns null for a missing or
  // private profile; the caller falls back to getProfile for the owner read.
  // A fresh page load carries the profile inline, so it hydrates with no
  // fetch (and no loading flash); a client-side navigation fetches.
  static getPublicProfile(username: string): Promise<ProfileView | null> {
    const inline = readInlineProfile(username);
    if (inline !== undefined) return Promise.resolve(inline);
    return fetchPublicProfile(username);
  }

  static async getOwnProfile(username: string): Promise<ProfileView | null> {
    const snapshot = await getDoc(doc(db, 'profiles', username)).catch((error) => {
      if (error instanceof FirebaseError && error.code === 'permission-denied') return null;
      throw error;
    });
    return snapshot?.exists()
      ? profileView(decodeStored(
        () => decodeProfile(snapshot.id, snapshot.data(), snapshot.ref.path),
      ))
      : null;
  }

  static getProfileDiscovery(username: string): Readable<ProfileDiscovery | null | undefined> {
    return cachedStore(profileDiscoveryStores, username, undefined, (set) => (
      onSnapshot(doc(db, 'profileDiscovery', username), (snapshot) => {
        // createdAt is a serverTimestamp(); the optimistic local snapshot
        // would otherwise carry null until the server acknowledges.
        set(snapshot.exists()
          ? decodeStored(
            () => decodeProfileDiscovery(
              snapshot.data({ serverTimestamps: 'estimate' }),
              snapshot.ref.path,
            ),
          )
          : null);
      }, listenError('load your profile search setting'))
    ));
  }

  // Per-book sharing is separate from the profile document because cached
  // clients replace profiles wholesale. The setting's existence is consent;
  // the work-readers callable still checks that the named profile is public.
  static getBookSharingSettings(userId: string): Readable<BookSharingSettings | null | undefined> {
    return cachedStore(bookSharingStores, userId, undefined, (set) => (
      onSnapshot(doc(db, 'users', userId, 'settings', 'bookSharing'), (snapshot) => {
        set(snapshot.exists()
          ? decodeStored(() => decodeBookSharingSettings(
            snapshot.data({ serverTimestamps: 'estimate' }),
            snapshot.ref.path,
          ))
          : null);
      }, listenError('load your book-sharing setting'))
    ));
  }

  static enableBookSharing({ userId, profileUsername, timeZone }: EnableBookSharingInput): Promise<void> {
    return setDoc(doc(db, 'users', userId, 'settings', 'bookSharing'), {
      profileUsername,
      timeZone,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  static disableBookSharing(userId: string): Promise<void> {
    return deleteDoc(doc(db, 'users', userId, 'settings', 'bookSharing'));
  }

  // setDoc, not addDoc: the username is the doc id. If the username is
  // already taken the rules evaluate this as an update of someone else's
  // doc and reject it, so the caller sees permission-denied and reports
  // "taken" inline — which is why this method is not in writeLabels.
  // isPublic is the explicit share checkbox; profiles are born private.
  // updatedAt is serverTimestamp(): the rules pin it to request.time
  // because the shared sitemap publishes it as <lastmod>. The ownership
  // record travels in the same batch — the rules allow one profile per
  // account, keyed by that record (SEC-032).
  static async createProfile({ userId, username, givenName, familyName, links, isPublic, stats, records, years, days }: ProfileWrite): Promise<void> {
    const batch = writeBatch(db);
    batch.set(doc(db, 'profiles', username), {
      uid: userId,
      public: isPublic,
      givenName,
      familyName,
      links,
      stats,
      records,
      years,
      days,
      updatedAt: serverTimestamp(),
    });
    batch.set(doc(db, 'profileOwners', userId), { username });
    await batch.commit();
  }

  // Full overwrite with the freshly computed payload (the Me page keeps the
  // published doc in step with live stats whenever it differs, and the
  // profile-edit form and visibility checkbox write through here too).
  static async updateProfile({ userId, username, givenName, familyName, links, isPublic, removeDiscovery = false, removeBookSharing = false, stats, records, years, days }: ProfileWrite): Promise<void> {
    const profileRef = doc(db, 'profiles', username);
    const profile = {
      uid: userId,
      public: isPublic,
      givenName,
      familyName,
      links,
      stats,
      records,
      years,
      days,
      updatedAt: serverTimestamp(),
    };
    // The ownership record rides along on every update too, so a profile
    // from before the record existed converges on the next stats sync
    // instead of waiting for a rename.
    const batch = writeBatch(db);
    batch.set(profileRef, profile);
    batch.set(doc(db, 'profileOwners', userId), { username });
    if (removeDiscovery) batch.delete(doc(db, 'profileDiscovery', username));
    if (removeBookSharing) {
      batch.delete(doc(db, 'users', userId, 'settings', 'bookSharing'));
    }
    await batch.commit();
  }

  static async enableProfileDiscovery({ userId, username }: ProfileDiscoveryWrite): Promise<void> {
    // Idempotent by design. Rules forbid updating a marker (allow update:
    // false), and a setDoc over an existing document is an update, not a
    // create — so a blind create is a permanent permission-denied whenever
    // the marker already exists but a stale local cache showed it absent.
    // The transaction reads the server copy, bypassing that cache, and
    // creates only when the marker is genuinely missing.
    await runTransaction(db, async (tx) => {
      const ref = doc(db, 'profileDiscovery', username);
      const existing = await tx.get(ref);
      if (existing.exists()) return;
      tx.set(ref, { uid: userId, createdAt: serverTimestamp() });
    });
  }

  static disableProfileDiscovery({ username }: ProfileDiscoveryWrite): Promise<void> {
    return deleteDoc(doc(db, 'profileDiscovery', username));
  }

  // Target only the link being added: a full-profile rewrite built from a
  // listener snapshot could overwrite a link accepted concurrently by
  // another client. arrayUnion also deduplicates an exact repeated click.
  static addProfileLink({ username, link }: AddProfileLinkInput): Promise<void> {
    return updateDoc(doc(db, 'profiles', username), {
      links: arrayUnion(link),
      updatedAt: serverTimestamp(),
    });
  }

  // Changing the username means moving the doc (the username IS the doc
  // id): one batch that creates the new doc and deletes the old, so the
  // profile is never gone or doubled — offline included. A taken new
  // username rejects the whole batch (see createProfile), which is why
  // this, like createProfile, stays out of writeLabels and reports inline.
  static async renameProfile({ userId, oldUsername, newUsername, givenName, familyName, links, isPublic, isDiscoverable, bookSharing, stats, records, years, days }: RenameProfileWrite): Promise<void> {
    if (bookSharing !== null && bookSharing.profileUsername !== oldUsername) {
      throw new Error('Book-sharing settings do not match the profile being renamed.');
    }
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
      updatedAt: serverTimestamp(),
    });
    batch.delete(doc(db, 'profiles', oldUsername));
    batch.set(doc(db, 'profileOwners', userId), { username: newUsername });
    // A merge so createdAt stays whatever the server holds: the local copy
    // may be an estimate (sharing enabled offline in this session), and the
    // update rule requires createdAt unchanged — a copied estimate would
    // reject the whole rename batch, which /me reports as a taken name.
    if (bookSharing !== null) {
      batch.set(doc(db, 'users', userId, 'settings', 'bookSharing'), {
        profileUsername: newUsername,
        timeZone: bookSharing.timeZone,
        updatedAt: serverTimestamp(),
      }, { merge: true });
    }
    if (isDiscoverable) {
      batch.set(doc(db, 'profileDiscovery', newUsername), {
        uid: userId,
        createdAt: serverTimestamp(),
      });
    }
    // Always clear the old marker. This is a no-op when it is absent and a
    // privacy-safe cleanup if local discovery state was stale.
    batch.delete(doc(db, 'profileDiscovery', oldUsername));
    await batch.commit();
  }

  static async deleteProfile({ userId, username }: ProfileDiscoveryWrite): Promise<void> {
    const batch = writeBatch(db);
    batch.delete(doc(db, 'profiles', username));
    batch.delete(doc(db, 'profileDiscovery', username));
    batch.delete(doc(db, 'profileOwners', userId));
    batch.delete(doc(db, 'users', userId, 'settings', 'bookSharing'));
    await batch.commit();
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
      ...finishedAtPatch(
        isFinished(previousPage, pageCount),
        isFinished(currentPage, pageCount),
        Timestamp.now(),
      ),
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
      ...finishedAtPatch(
        isFinished(previousPage, pageCount),
        isFinished(currentPage, pageCount),
        Timestamp.now(),
      ),
      pagesRead: increment(pagesRead),
      timeRead: increment(timeRead),
      updatedAt: Timestamp.now(),
    });

    await batch.commit();
  }

  // Books reference authors by id only; names live in the shared catalog and
  // are joined client-side (bookAuthors). updateBook also deletes the
  // legacy author/authors fields, so their presence on any doc proves an
  // old client wrote it last — the invariant the legacy-wins read rule
  // and the migration re-run policy both stand on.
  static addBook({ userId, authorChips, title, pageCount, currentPage, isbn, metadata, catalogLink }: AddBookInput): Promise<void> {
    const authorIds = storedAuthorIds(authorChips);
    const batch = writeBatch(db);
    const ownerRef = doc(db, 'users', userId);
    const bookRef = doc(collection(db, 'users', userId, 'books'));

    batch.set(bookRef, {
      authorIds,
      currentPage,
      currentPageUpdateId: null,
      finished: isFinished(currentPage, pageCount),
      finishedAt: isFinished(currentPage, pageCount) ? Timestamp.now() : null,
      owner: ownerRef,
      pageCount,
      pagesRead: 0,
      timeRead: 0,
      title,
      isbn,
      ...catalogLinkFields(catalogLink),
      // ISBN-derived metadata (utils/bookMetadata.ts shape), defaults when
      // the caller never looked the ISBN up.
      ...metadata,
      updatedAt: Timestamp.now(),
      createdAt: Timestamp.now(),
    });

    return batch.commit();
  }

  static updateBook({ userId, bookId, authorChips, title, pageCount, currentPage, previouslyFinished, pageCountClampFrom, isbn, metadata, catalogLink }: UpdateBookInput): Promise<void> {
    const authorIds = storedAuthorIds(authorChips);
    const batch = writeBatch(db);
    const bookRef = doc(db, 'users', userId, 'books', bookId);
    let correctionId: string | null = null;
    if (pageCountClampFrom !== null) {
      const correctionRef = doc(collection(db, 'users', userId, 'books', bookId, 'updates'));
      correctionId = correctionRef.id;
      batch.set(correctionRef, {
        owner: doc(db, 'users', userId),
        book: bookRef,
        type: 'update',
        fromPage: pageCountClampFrom,
        toPage: currentPage,
        pagesRead: currentPage - pageCountClampFrom,
        updatedAt: Timestamp.now(),
        createdAt: Timestamp.now(),
      });
    }

    // Ordinarily metadata edits do not rewrite progress. Shrinking below the
    // rendered page creates a correlated correction row in the same batch.
    // Its fromPage is the optimistic-concurrency claim enforced by rules, so
    // a newer remote reading rejects the whole stale offline edit.
    batch.update(bookRef, {
      authorIds,
      author: deleteField(),
      authors: deleteField(),
      title,
      pageCount,
      ...(correctionId === null ? {} : {
        currentPage,
        currentPageUpdateId: correctionId,
      }),
      finished: isFinished(currentPage, pageCount),
      ...finishedAtPatch(previouslyFinished, isFinished(currentPage, pageCount), Timestamp.now()),
      isbn,
      ...(catalogLink === undefined ? {} : catalogLinkFields(catalogLink)),
      ...metadata,
      updatedAt: Timestamp.now(),
    });

    return batch.commit();
  }

  // Local (non-Toggl) timers reuse the activeTimer field the Toggl flow
  // writes server-side; no entryId marks the timer as local. updatedAt is
  // deliberately untouched so the book list doesn't reorder mid-session.
  // The trailing `title` on this and the other positional write methods is
  // not used by the method body — writeLabels reads it for error messages.
  static async startLocalTimer(userId: string, bookId: string, title: string): Promise<void> {
    const batch = writeBatch(db);
    const timer = { start: new Date().toISOString(), operationId: crypto.randomUUID() };
    batch.update(doc(db, 'users', userId, 'books', bookId), { activeTimer: timer });
    batch.set(
      doc(db, 'users', userId, 'timerLifecycle', 'current'),
      activeTimerClaim(bookId, timer),
    );
    await batch.commit();
  }

  static async stopLocalTimer(
    userId: string,
    bookId: string,
    title: string,
    timer: ActiveTimer,
  ): Promise<void> {
    const batch = writeBatch(db);
    const claim = activeTimerClaim(bookId, timer);
    batch.update(doc(db, 'users', userId, 'books', bookId), { activeTimer: null });
    batch.set(
      doc(db, 'users', userId, 'timerLifecycle', 'current'),
      idleTimerClaim(claim),
    );
    await batch.commit();
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
    timer: ActiveTimer,
  ): Promise<void> {
    const batch = writeBatch(db);
    const bookRef = doc(db, 'users', userId, 'books', bookId);
    const claimRef = doc(db, 'users', userId, 'timerLifecycle', 'current');
    const currentClaim = activeTimerClaim(bookId, timer);
    if (entry !== null) {
      // The stable id lets rules prove this is the one queue row coupled to
      // this timer clear and prevents a repeated stop minting another row.
      const queueId = togglQueueId(bookId, entry.start);
      if (entry.type === 'stop') {
        if ('state' in timer || timer.entryId === undefined) {
          throw new Error('A remote stop queue requires an active Toggl timer.');
        }
        const stopping = stoppingTimer(timer, queueId);
        batch.update(bookRef, { activeTimer: stopping });
        batch.set(claimRef, activeTimerClaim(bookId, stopping));
      } else {
        batch.update(bookRef, { activeTimer: null });
        batch.set(claimRef, idleTimerClaim(currentClaim));
      }
      batch.set(doc(db, 'users', userId, 'togglQueue', queueId), {
        ...entry,
        bookId,
        timerClaimVersion: 1,
        status: 'pending',
        createdAt: Timestamp.now(),
      });
    } else {
      batch.update(bookRef, { activeTimer: null });
      batch.set(claimRef, idleTimerClaim(currentClaim));
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
    if (!navigator.onLine) return;
    await runRetryableSessionTask(togglSweptUsers, userId, async () => {
      let items;
      try {
        items = await getDocsFromServer(query(
          collection(db, 'users', userId, 'togglQueue'),
          where('status', 'in', ['pending', 'processing', 'error', 'outcome-unknown'])
        ));
      } catch (error) {
        // navigator.onLine lied; the reconnect flush will handle pending
        // items and the next real online session will sweep the rest.
        if (error instanceof FirebaseError && error.code === 'unavailable') return false;
        throw error;
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
      await Promise.all(retryable.map(async ({ ref }) => {
        let attemptedItem: ReturnType<typeof decodeLiveQueueSweepItem> = null;
        try {
          await runTransaction(db, async (tx) => {
            attemptedItem = null;
            const snap = await tx.get(ref);
            if (!snap.exists()) return;
            const item = decodeLiveQueueSweepItem(snap.id, snap.data(), snap.ref.path);
            if (item === null) return;
            if (!isTogglSweepTransactionCandidate(item)) return;
            // A deferred row was already excluded by the candidate check
            // above, which is the one place that decides it.
            const { status, claimedAt, createdAt } = item;
            const retry =
              status === 'error' ||
              (status === 'pending' && createdAt.toMillis() < Date.now() - 10 * 60 * 1000) ||
              (status === 'processing' && claimedAt !== null && claimedAt.toMillis() < Date.now() - 6 * 60 * 60 * 1000);
            if (!retry) return;
            attemptedItem = item;
            tx.update(ref, {
              status: 'pending',
              retryRequestedAt: serverTimestamp(),
            });
          });
        } catch (error) {
          // The marker uses request.time while the sweep uses the device
          // clock. A fast device can ask slightly before the server's
          // ten-minute window opens. That expected denial must not abort the
          // rest of the sweep or show a permanent write-failure toast.
          if (error instanceof FirebaseError && attemptedItem !== null &&
              isExpectedTogglRetryMarkerDenial(attemptedItem, error.code)) return;
          throw error;
        }
      }));
      return true;
    });
  }

  // Only deletes the book document; the deletebookupdates trigger cascades
  // to the updates subcollection server-side. Deleting the subcollection
  // here would be wrong offline: an offline getDocs silently returns only
  // whatever happens to be cached, orphaning the rest forever.
  static async deleteBook(
    userId: string,
    bookId: string,
    title: string,
    timer: ActiveTimer | null,
  ): Promise<void> {
    const bookRef = doc(db, 'users', userId, 'books', bookId);
    if (timer === null) {
      await deleteDoc(bookRef);
      return;
    }
    if ('state' in timer || timer.entryId !== undefined) {
      throw new Error('Only a local timer can be discarded with its book.');
    }
    const batch = writeBatch(db);
    batch.delete(bookRef);
    batch.set(
      doc(db, 'users', userId, 'timerLifecycle', 'current'),
      idleTimerClaim(activeTimerClaim(bookId, timer)),
    );
    await batch.commit();
  }

  static updateReadingSession({ userId, bookId, session, bookProgress, timeRead, fromPage, toPage }: UpdateReadingSessionInput): Promise<void> {
    // The modal can only submit a decoded session and book rendered by live
    // listeners. Planning from that state lets the batch enter Firestore's
    // local queue synchronously with no online transaction or cache read.
    // Rules correlate these deltas with the server's current session; a
    // stale cross-device edit rejects atomically on reconnect.
    return queueReadingSessionUpdate({
      firestore: readingSessionWriteStore,
      userId,
      bookId,
      sessionId: session.id,
      previous: session,
      book: bookProgress,
      next: { timeRead, fromPage, toPage },
    });
  }

  static deleteReadingSession({
    userId,
    bookId,
    session,
    bookProgress,
    previousProgressUpdate,
  }: DeleteReadingSessionInput): Promise<void> {
    return queueReadingSessionDelete({
      firestore: readingSessionWriteStore,
      userId,
      bookId,
      sessionId: session.id,
      previous: session,
      book: bookProgress,
      previousProgressUpdate,
    });
  }

  static getBookUpdates(userId: string, bookId: string): Readable<BookUpdate[]> {
    return cachedStore(bookUpdatesStores, `${userId}:${bookId}`, [], (set) => {
      const q = query(
        collection(db, 'users', userId, 'books', bookId, 'updates')
      );

      return onSnapshot(q, (snapshot) => {
        const updates = snapshot.docs.map((updateDoc) =>
          decodeStored(
            () => decodeBookUpdate(
              updateDoc.id,
              updateDoc.data(),
              updateDoc.ref.path,
            ),
          )
        );
        // Sort by createdAt descending on the client side
        updates.sort((a, b) => {
          const aTime = a.createdAt?.toMillis?.() || 0;
          const bTime = b.createdAt?.toMillis?.() || 0;
          return bTime - aTime || b.id.localeCompare(a.id);
        });
        set(updates);
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
Database.enableProfileDiscovery = reportWriteFailures(
  'enableProfileDiscovery', ({ userId }) => userId,
  ({ username }) => `make your public profile "${username}" searchable`, Database.enableProfileDiscovery,
);
Database.disableProfileDiscovery = reportWriteFailures(
  'disableProfileDiscovery', ({ userId }) => userId,
  ({ username }) => `remove your public profile "${username}" from search`, Database.disableProfileDiscovery,
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
