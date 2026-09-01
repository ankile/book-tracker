import {
  collection,
  collectionGroup,
  onSnapshot,
  query,
  type Query,
} from 'firebase/firestore';
import { derived, type Readable } from 'svelte/store';
import {
  scanCatalog,
  type CatalogScan,
  type CatalogScanBookDocument,
  type CatalogScanDocument,
  type CatalogScanIndexDocument,
} from '../../../shared/catalogScan.ts';
import { cachedReadable } from '../stores/cached-readable.ts';
import { externalIndexId } from '../utils/adminCatalog.ts';
import { db, listenError } from './db.ts';

// The operator's live view of the catalog: one listener per catalog
// collection plus every account's books and every account document, and
// the shared scan (shared/catalogScan.ts) derived from them. The rules grant
// these reads to the operator's UID alone (isOperator in firestore.rules).
// With the persistent cache, the first open on a device pays one read per
// document and every later open is served locally; after that only changed
// documents cost anything, and the console updates the moment one changes.
// Each source keeps its last snapshot while nobody listens (cachedReadable),
// so navigating back to the console renders at once.

function documents(source: Query, label: string): Readable<CatalogScanDocument[] | undefined> {
  return cachedReadable<CatalogScanDocument[] | undefined>(undefined, (set) =>
    onSnapshot(source, (snapshot) => {
      set(snapshot.docs.map((document) => ({ id: document.id, data: document.data() })));
    }, listenError(label)),
  );
}

const authors = documents(query(collection(db, 'catalogAuthors')), 'load the catalog authors for curation');
const works = documents(query(collection(db, 'works')), 'load the works for curation');
const editions = documents(query(collection(db, 'editions')), 'load the editions for curation');
const isbnIndex = documents(query(collection(db, 'isbnIndex')), 'load the ISBN index for curation');

// The index id is a SHA-256 the browser can only compute asynchronously, so
// the snapshot is published once every row's expected id is known; a newer
// snapshot arriving meanwhile wins.
const externalIdIndex: Readable<CatalogScanIndexDocument[] | undefined> =
  cachedReadable<CatalogScanIndexDocument[] | undefined>(undefined, (set) => {
    let latest = 0;
    return onSnapshot(query(collection(db, 'externalIdIndex')), (snapshot) => {
      latest += 1;
      const sequence = latest;
      void Promise.all(snapshot.docs.map(async (document) => {
        const data = document.data();
        const expectedId = typeof data.provider === 'string' && typeof data.externalId === 'string' ?
          await externalIndexId(data.provider, data.externalId) : '';
        return { id: document.id, data, expectedId };
      })).then((rows) => {
        if (sequence === latest) set(rows);
      });
    }, listenError('load the external ID index for curation'));
  });

// Books live only under users/{uid}/books; any other path is a schema
// violation worth a crash, not a row.
const books: Readable<CatalogScanBookDocument[] | undefined> =
  cachedReadable<CatalogScanBookDocument[] | undefined>(undefined, (set) =>
    onSnapshot(query(collectionGroup(db, 'books')), (snapshot) => {
      set(snapshot.docs.map((document) => {
        const path = document.ref.path.split('/');
        if (path.length !== 4 || path[0] !== 'users' || path[2] !== 'books') {
          throw new Error(`Unexpected book collection-group path ${document.ref.path}.`);
        }
        return { uid: path[1], bookId: document.id, data: document.data() };
      }));
    }, listenError('load every reader\'s books for curation')),
  );

// Accounts that exist without a tombstone (SEC-006 soft delete); a book
// owned by any other uid is orphaned data.
const liveUserIds: Readable<ReadonlySet<string> | undefined> =
  cachedReadable<ReadonlySet<string> | undefined>(undefined, (set) =>
    onSnapshot(query(collection(db, 'users')), (snapshot) => {
      set(new Set(snapshot.docs
        .filter((document) => document.get('deletedAt') === undefined)
        .map((document) => document.id)));
    }, listenError('load the account list for curation')),
  );

// undefined until every source has delivered its first snapshot.
export const adminCatalogScan: Readable<CatalogScan | undefined> = derived(
  [authors, works, editions, isbnIndex, externalIdIndex, books, liveUserIds],
  ([$authors, $works, $editions, $isbnIndex, $externalIdIndex, $books, $liveUserIds]) => (
    $authors === undefined || $works === undefined || $editions === undefined ||
    $isbnIndex === undefined || $externalIdIndex === undefined || $books === undefined ||
    $liveUserIds === undefined ? undefined : scanCatalog({
      authors: $authors,
      works: $works,
      editions: $editions,
      isbnIndex: $isbnIndex,
      externalIdIndex: $externalIdIndex,
      books: $books,
      liveUserIds: $liveUserIds,
    })
  ),
);
