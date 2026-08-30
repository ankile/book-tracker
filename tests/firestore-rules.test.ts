import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import type { RulesTestContext, RulesTestEnvironment } from '@firebase/rules-unit-testing';
import {
  arrayUnion,
  collection,
  collectionGroup,
  deleteField,
  deleteDoc,
  disableNetwork,
  doc,
  enableNetwork,
  getDoc,
  getDocFromCache,
  getDocs,
  increment,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { FirebaseError } from 'firebase/app';
import { togglQueueId } from '../src/lib/utils/toggl.ts';
import {
  authorShapeViolations,
  bookShapeViolations,
  profileOwnerRecordViolations,
  profileShapeViolations,
} from '../rules-shape.ts';
import {
  queueReadingSessionDelete,
  queueReadingSessionUpdate,
  type ReadingSessionWriteStore,
} from '../src/lib/firebase/readingSessionWrites.ts';

let environment: RulesTestEnvironment;

const profile = (uid: string, overrides: Record<string, unknown> = {}) => ({
  uid,
  public: true,
  givenName: 'Ada',
  familyName: 'Lovelace',
  links: [{ type: 'github', value: 'ada' }],
  stats: {
    totalBooks: 12,
    finishedBooks: 10,
    readingBooks: 2,
    totalTimeReadHours: 80,
    totalPagesRead: 3200,
    booksPerYear: 8.5,
    avgTimePerBook: 480,
    authors: 9,
  },
  records: {
    momentum: { recentPagesPerDay: 14, lifetimePagesPerDay: 10, ratio: 1.4 },
    superlatives: {
      biggestDay: { day: '2026-08-20', pages: 120 },
      longestSession: { minutes: 95 },
      medianSessionMinutes: 24,
      fastestFinish: { days: 3, pageCount: 320 },
    },
  },
  years: [{ year: 2026, count: 10, hours: 80, pages: 3200 }],
  days: [{ day: '2026-08-20', pagesRead: 120, timeRead: 95, sessions: 1 }],
  updatedAt: serverTimestamp(),
  ...overrides,
});

// Publishing needs a verified account whose users document exists
// (SEC-033, SEC-062); the client creates a profile together with its
// ownership record (SEC-032). These helpers are that shape.
const verified = (uid: string) =>
  environment.authenticatedContext(uid, { email_verified: true }).firestore();
const readingSessionWriteStore = (
  firestore: ReturnType<RulesTestContext['firestore']>,
): ReadingSessionWriteStore => ({
  document: (path, ...pathSegments) => doc(firestore, path, ...pathSegments),
  batch: () => writeBatch(firestore),
});
const seedAccount = (uid: string) =>
  environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', uid), { uid, email: `${uid}@example.test` });
  });
const createProfileBatch = (
  db: ReturnType<RulesTestContext['firestore']>,
  uid: string,
  username: string,
  overrides: Record<string, unknown> = {},
  record: Record<string, unknown> = { username },
) => {
  const batch = writeBatch(db);
  batch.set(doc(db, 'profiles', username), profile(uid, overrides));
  batch.set(doc(db, 'profileOwners', uid), record);
  return batch.commit();
};
const marker = (uid: string) => ({ uid, createdAt: serverTimestamp() });

const readingBook = (overrides: Record<string, unknown> = {}) => ({
  title: 'Reading book',
  activeTimer: null,
  currentPage: 20,
  currentPageUpdateId: 'session',
  pageCount: 100,
  finished: false,
  pagesRead: 20,
  timeRead: 60,
  updatedAt: Timestamp.now(),
  ...overrides,
});

const creatableBook = (overrides: Record<string, unknown> = {}) => readingBook({
  currentPage: 0,
  currentPageUpdateId: null,
  pagesRead: 0,
  timeRead: 0,
  ...overrides,
});

const legacyReadingBook = (overrides: Record<string, unknown> = {}) => {
  const { currentPageUpdateId: _source, ...book } = readingBook(overrides);
  return book;
};

const readingEntry = (
  db: ReturnType<RulesTestContext['firestore']>,
  uid: string,
  bookId: string,
  overrides: Record<string, unknown> = {},
) => ({
  owner: doc(db, 'users', uid),
  book: doc(db, 'users', uid, 'books', bookId),
  type: 'reading',
  timeRead: 30,
  fromPage: 10,
  toPage: 20,
  pagesRead: 10,
  updatedAt: Timestamp.now(),
  createdAt: Timestamp.now(),
  ...overrides,
});

const pageCorrectionEntry = (
  db: ReturnType<RulesTestContext['firestore']>,
  uid: string,
  bookId: string,
  overrides: Record<string, unknown> = {},
) => {
  const { timeRead: _timeRead, ...entry } = readingEntry(db, uid, bookId);
  return { ...entry, type: 'update', ...overrides };
};

before(async () => {
  environment = await initializeTestEnvironment({
    projectId: 'book-tracker-rules-test',
    firestore: { rules: await readFile('firestore.rules', 'utf8') },
  });
});

after(async () => environment.cleanup());

// Every test starts from an empty database, so isolation is structural
// rather than a convention of unique uids per test.
beforeEach(async () => environment.clearFirestore());

test('the owner can create and update a valid profile', async () => {
  await seedAccount('owner');
  const db = verified('owner');
  const ref = doc(db, 'profiles', 'ada-lovelace');
  await assertSucceeds(createProfileBatch(db, 'owner', 'ada-lovelace'));
  await assertSucceeds(setDoc(ref, profile('owner', { familyName: 'Byron' })));
  assert.deepEqual((await getDoc(doc(db, 'profileOwners', 'owner'))).data(), { username: 'ada-lovelace' });
});

test('publishing needs a verified account whose users document still exists', async () => {
  // Unverified token, account exists.
  await seedAccount('unverified');
  const unverified = environment.authenticatedContext('unverified').firestore();
  await assertFails(createProfileBatch(unverified, 'unverified', 'unverified-reader'));
  const claimsFalse = environment.authenticatedContext('unverified', { email_verified: false }).firestore();
  await assertFails(createProfileBatch(claimsFalse, 'unverified', 'unverified-reader'));
  // Verified token, but the account has been deleted (users/{uid} gone): the
  // ID token stays valid for up to an hour and must not plant a page.
  const ghost = verified('ghost');
  await assertFails(createProfileBatch(ghost, 'ghost', 'ghost-reader'));
  // Both: allowed.
  await seedAccount('real');
  await assertSucceeds(createProfileBatch(verified('real'), 'real', 'real-reader'));

  // Updates and markers are gated the same way, including on a profile
  // that already exists (seeded from before the gate).
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'profiles', 'legacy-reader'), profile('unverified'));
    await setDoc(doc(context.firestore(), 'profileOwners', 'unverified'), { username: 'legacy-reader' });
  });
  await assertFails(setDoc(doc(unverified, 'profiles', 'legacy-reader'), profile('unverified', { familyName: 'Byron' })));
  await assertFails(setDoc(doc(unverified, 'profileDiscovery', 'legacy-reader'), marker('unverified')));
  await assertFails(setDoc(doc(ghost, 'profileDiscovery', 'real-reader'), marker('ghost')));
  await assertSucceeds(setDoc(doc(verified('real'), 'profileDiscovery', 'real-reader'), marker('real')));
  // The gate does not lock an unverified owner out of deleting what it has.
  const legacyDelete = writeBatch(unverified);
  legacyDelete.delete(doc(unverified, 'profiles', 'legacy-reader'));
  legacyDelete.delete(doc(unverified, 'profileOwners', 'unverified'));
  await assertSucceeds(legacyDelete.commit());

  // A deleted account is tombstoned, not removed (SEC-006): the users
  // document stays with deletedAt, and the identity — verified, with an
  // ID token that outlives the account by up to an hour — can neither
  // publish, update, mark, nor delete its tombstoned profile.
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const admin = context.firestore();
    await setDoc(doc(admin, 'users', 'tomb'), { uid: 'tomb', email: 'tomb@example.test', deletedAt: Timestamp.now() });
    await setDoc(doc(admin, 'profiles', 'tomb-reader'), { ...profile('tomb'), deletedAt: Timestamp.now() });
    await setDoc(doc(admin, 'profileOwners', 'tomb'), { username: 'tomb-reader' });
    await setDoc(doc(admin, 'users', 'tomb-fresh'), { uid: 'tomb-fresh', email: 'f@example.test', deletedAt: Timestamp.now() });
  });
  const tomb = verified('tomb');
  await assertFails(setDoc(doc(tomb, 'profiles', 'tomb-reader'), profile('tomb', { familyName: 'Byron' })));
  await assertFails(updateDoc(doc(tomb, 'profiles', 'tomb-reader'), { familyName: 'Byron', updatedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(tomb, 'profileDiscovery', 'tomb-reader'), marker('tomb')));
  const tombDelete = writeBatch(tomb);
  tombDelete.delete(doc(tomb, 'profiles', 'tomb-reader'));
  tombDelete.delete(doc(tomb, 'profileOwners', 'tomb'));
  await assertFails(tombDelete.commit());
  await assertFails(deleteDoc(doc(tomb, 'profiles', 'tomb-reader')));
  // Nor start over under another name with the same identity.
  await assertFails(createProfileBatch(verified('tomb-fresh'), 'tomb-fresh', 'tomb-fresh-reader'));

  // The window deleteUserDocument opens (users/{uid} tombstoned first, the
  // profiles tombstoned after): a profile that is NOT yet tombstoned must
  // still be undeletable by the residual identity, because its account is
  // tombstoned. The delete rule gates on the account, not just the
  // profile's own deletedAt.
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const admin = context.firestore();
    await setDoc(doc(admin, 'users', 'tombwin'), { uid: 'tombwin', email: 'w@example.test', deletedAt: Timestamp.now() });
    await setDoc(doc(admin, 'profiles', 'tombwin-reader'), profile('tombwin'));
    await setDoc(doc(admin, 'profileOwners', 'tombwin'), { username: 'tombwin-reader' });
  });
  const tombwin = verified('tombwin');
  const windowDelete = writeBatch(tombwin);
  windowDelete.delete(doc(tombwin, 'profiles', 'tombwin-reader'));
  windowDelete.delete(doc(tombwin, 'profileOwners', 'tombwin'));
  await assertFails(windowDelete.commit());
  await assertFails(deleteDoc(doc(tombwin, 'profiles', 'tombwin-reader')));

  // The delete rule's own clause, isolated: a tombstoned profile on a
  // LIVE account (drift no path produces; the audit reports it as
  // profile.tombstone-orphan) is still not the owner's to delete. With
  // only the cases above, dropping that clause left the suite green.
  // And a positive control with the same fixture shape and no tombstone
  // anywhere, so the denials here come from the tombstones and not from
  // the fixture.
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const admin = context.firestore();
    await setDoc(doc(admin, 'users', 'tombprof'), { uid: 'tombprof', email: 'p@example.test' });
    await setDoc(doc(admin, 'profiles', 'tombprof-reader'), { ...profile('tombprof'), deletedAt: Timestamp.now() });
    await setDoc(doc(admin, 'profileOwners', 'tombprof'), { username: 'tombprof-reader' });
    await setDoc(doc(admin, 'users', 'tombctl'), { uid: 'tombctl', email: 'c@example.test' });
    await setDoc(doc(admin, 'profiles', 'tombctl-reader'), profile('tombctl'));
    await setDoc(doc(admin, 'profileOwners', 'tombctl'), { username: 'tombctl-reader' });
  });
  const tombprof = verified('tombprof');
  const orphanDelete = writeBatch(tombprof);
  orphanDelete.delete(doc(tombprof, 'profiles', 'tombprof-reader'));
  orphanDelete.delete(doc(tombprof, 'profileOwners', 'tombprof'));
  await assertFails(orphanDelete.commit());
  await assertFails(deleteDoc(doc(tombprof, 'profiles', 'tombprof-reader')));
  const tombctl = verified('tombctl');
  const controlDelete = writeBatch(tombctl);
  controlDelete.delete(doc(tombctl, 'profiles', 'tombctl-reader'));
  controlDelete.delete(doc(tombctl, 'profileOwners', 'tombctl'));
  await assertSucceeds(controlDelete.commit());
});

test('one profile per account: a second needs the first gone in the same batch', async () => {
  await seedAccount('capped');
  const db = verified('capped');
  await assertSucceeds(createProfileBatch(db, 'capped', 'first-name'));
  // A second profile, even with the ownership record moved, while the first
  // still exists.
  await assertFails(createProfileBatch(db, 'capped', 'second-name'));
  // A second profile without touching the ownership record.
  await assertFails(setDoc(doc(db, 'profiles', 'second-name'), profile('capped')));
  // Rename: delete the first, create the second, move the record — allowed.
  const rename = writeBatch(db);
  rename.set(doc(db, 'profiles', 'second-name'), profile('capped'));
  rename.delete(doc(db, 'profiles', 'first-name'));
  rename.set(doc(db, 'profileOwners', 'capped'), { username: 'second-name' });
  await assertSucceeds(rename.commit());
  // (A get on a missing profile is denied by design — check with rules off.)
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    assert.equal((await getDoc(doc(context.firestore(), 'profiles', 'first-name'))).exists(), false);
  });
  assert.deepEqual((await getDoc(doc(db, 'profileOwners', 'capped'))).data(), { username: 'second-name' });
  // A rename that forgets to delete the old profile.
  const keepBoth = writeBatch(db);
  keepBoth.set(doc(db, 'profiles', 'third-name'), profile('capped'));
  keepBoth.set(doc(db, 'profileOwners', 'capped'), { username: 'third-name' });
  await assertFails(keepBoth.commit());
  // A rename whose record names the wrong profile.
  const wrongRecord = writeBatch(db);
  wrongRecord.set(doc(db, 'profiles', 'third-name'), profile('capped'));
  wrongRecord.delete(doc(db, 'profiles', 'second-name'));
  wrongRecord.set(doc(db, 'profileOwners', 'capped'), { username: 'fourth-name' });
  await assertFails(wrongRecord.commit());
});

test('the profile ownership record only moves inside a profile batch', async () => {
  await seedAccount('record-owner');
  const db = verified('record-owner');
  const record = doc(db, 'profileOwners', 'record-owner');
  // Cannot name a profile that does not exist, or someone else's.
  await assertFails(setDoc(record, { username: 'nothing-here' }));
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'profiles', 'theirs'), profile('someone-else'));
  });
  await assertFails(setDoc(record, { username: 'theirs' }));
  await assertSucceeds(createProfileBatch(db, 'record-owner', 'mine'));
  // Cannot be re-pointed while the named profile still exists, deleted while
  // it exists, or given any other shape.
  await assertFails(setDoc(record, { username: 'theirs' }));
  await assertFails(setDoc(record, { username: 'nothing-here' }));
  await assertFails(deleteDoc(record));
  await assertFails(setDoc(record, { username: 'mine', extra: true }));
  await assertFails(setDoc(record, { username: 'Bad Name' }));
  // A rewrite that changes nothing is harmless and allowed.
  await assertSucceeds(setDoc(record, { username: 'mine' }));
  // Nobody else reads or writes it.
  const stranger = verified('record-stranger');
  await assertFails(getDoc(doc(stranger, 'profileOwners', 'record-owner')));
  await assertFails(setDoc(doc(stranger, 'profileOwners', 'record-owner'), { username: 'mine' }));
  await assertFails(deleteDoc(doc(stranger, 'profileOwners', 'record-owner')));
  await assertSucceeds(getDoc(record));
  // Released together with the profile.
  const release = writeBatch(db);
  release.delete(doc(db, 'profiles', 'mine'));
  release.delete(record);
  await assertSucceeds(release.commit());
});

test('names the site uses for itself cannot be claimed as usernames', async () => {
  await seedAccount('squatter');
  const db = verified('squatter');
  for (const name of ['admin', 'api', 'profiles', 'sitemap', 'login', 'www', 'null', 'undefined', 'static']) {
    await assertFails(createProfileBatch(db, 'squatter', name));
  }
  await assertSucceeds(createProfileBatch(db, 'squatter', 'admin-fan'));
});

test('profile updatedAt is server-pinned', async () => {
  await seedAccount('clock-owner');
  const db = verified('clock-owner');
  await assertFails(createProfileBatch(db, 'clock-owner', 'clock', { updatedAt: Timestamp.now() }));
  await assertFails(createProfileBatch(db, 'clock-owner', 'clock', { updatedAt: Timestamp.fromMillis(Date.UTC(9999, 0, 1)) }));
  await assertFails(createProfileBatch(db, 'clock-owner', 'clock', { updatedAt: Timestamp.fromMillis(0) }));
  await assertSucceeds(createProfileBatch(db, 'clock-owner', 'clock'));
  await assertFails(setDoc(doc(db, 'profiles', 'clock'), profile('clock-owner', { updatedAt: Timestamp.fromMillis(Date.UTC(9999, 0, 1)) })));
  await assertFails(updateDoc(doc(db, 'profiles', 'clock'), { familyName: 'Byron', updatedAt: Timestamp.now() }));
  await assertSucceeds(setDoc(doc(db, 'profiles', 'clock'), profile('clock-owner', { familyName: 'Byron' })));
});

test('deleting a profile releases its record and takes its own marker with it', async () => {
  await seedAccount('releaser');
  const db = verified('releaser');
  await assertSucceeds(createProfileBatch(db, 'releaser', 'released'));
  await assertSucceeds(setDoc(doc(db, 'profileDiscovery', 'released'), marker('releaser')));
  // Alone: the record still names it and the marker would be orphaned.
  await assertFails(deleteDoc(doc(db, 'profiles', 'released')));
  // Profile + marker, record kept.
  const keepRecord = writeBatch(db);
  keepRecord.delete(doc(db, 'profiles', 'released'));
  keepRecord.delete(doc(db, 'profileDiscovery', 'released'));
  await assertFails(keepRecord.commit());
  // Profile + record, marker kept.
  const keepMarker = writeBatch(db);
  keepMarker.delete(doc(db, 'profiles', 'released'));
  keepMarker.delete(doc(db, 'profileOwners', 'releaser'));
  await assertFails(keepMarker.commit());
  // All three.
  const all = writeBatch(db);
  all.delete(doc(db, 'profiles', 'released'));
  all.delete(doc(db, 'profileDiscovery', 'released'));
  all.delete(doc(db, 'profileOwners', 'releaser'));
  await assertSucceeds(all.commit());
  // The freed name is first-writer-wins again, with a clean marker slot.
  await seedAccount('next-owner');
  await assertSucceeds(createProfileBatch(verified('next-owner'), 'next-owner', 'released'));

  // A marker under my name that belongs to another account (left by an
  // orphan from before this rule) is not mine to carry: the delete goes
  // through without touching it.
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'profiles', 'squatted'), profile('releaser'));
    await setDoc(doc(context.firestore(), 'profileOwners', 'releaser'), { username: 'squatted' });
    await setDoc(doc(context.firestore(), 'profileDiscovery', 'squatted'), { uid: 'somebody-else', createdAt: Timestamp.now() });
  });
  const foreign = writeBatch(db);
  foreign.delete(doc(db, 'profiles', 'squatted'));
  foreign.delete(doc(db, 'profileOwners', 'releaser'));
  await assertSucceeds(foreign.commit());

  // A profile from before the ownership record existed deletes with its
  // marker alone — and, what the client actually sends, with the record
  // delete included even though no record exists.
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'profiles', 'legacy'), profile('releaser'));
    await setDoc(doc(context.firestore(), 'profileDiscovery', 'legacy'), { uid: 'releaser', createdAt: Timestamp.now() });
  });
  const legacy = writeBatch(db);
  legacy.delete(doc(db, 'profiles', 'legacy'));
  legacy.delete(doc(db, 'profileDiscovery', 'legacy'));
  legacy.delete(doc(db, 'profileOwners', 'releaser'));
  await assertSucceeds(legacy.commit());
});

test('a profile from before the ownership record can be updated, renamed and deleted by the client batches', async () => {
  // The owner's production profile predates profileOwners. Every batch
  // db.ts sends must work against it: update (which now creates the
  // record), rename, and delete with the unconditional record delete.
  const uid = 'legacy-owner';
  await seedAccount(uid);
  const db = verified(uid);
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'profiles', 'legacy-name'), profile(uid));
    await setDoc(doc(context.firestore(), 'profileDiscovery', 'legacy-name'), { uid, createdAt: Timestamp.now() });
  });
  // Delete with no record in place (the client always includes the delete).
  const del = writeBatch(db);
  del.delete(doc(db, 'profiles', 'legacy-name'));
  del.delete(doc(db, 'profileDiscovery', 'legacy-name'));
  del.delete(doc(db, 'profileOwners', uid));
  await assertSucceeds(del.commit());
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'profiles', 'legacy-name'), profile(uid));
  });
  // Update (the Me page's stats sync): creates the record.
  const upd = writeBatch(db);
  upd.set(doc(db, 'profiles', 'legacy-name'), profile(uid, { familyName: 'Byron' }));
  upd.set(doc(db, 'profileOwners', uid), { username: 'legacy-name' });
  await assertSucceeds(upd.commit());
  assert.deepEqual((await getDoc(doc(db, 'profileOwners', uid))).data(), { username: 'legacy-name' });
  // Rename now that the record exists.
  const ren = writeBatch(db);
  ren.set(doc(db, 'profiles', 'renamed-name'), profile(uid));
  ren.delete(doc(db, 'profiles', 'legacy-name'));
  ren.set(doc(db, 'profileOwners', uid), { username: 'renamed-name' });
  ren.delete(doc(db, 'profileDiscovery', 'legacy-name'));
  await assertSucceeds(ren.commit());
  // And a rename straight from the legacy state (no record) also works.
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await deleteDoc(doc(context.firestore(), 'profileOwners', uid));
    await deleteDoc(doc(context.firestore(), 'profiles', 'renamed-name'));
    await setDoc(doc(context.firestore(), 'profiles', 'legacy-name'), profile(uid));
  });
  const ren2 = writeBatch(db);
  ren2.set(doc(db, 'profiles', 'renamed-name'), profile(uid));
  ren2.delete(doc(db, 'profiles', 'legacy-name'));
  ren2.set(doc(db, 'profileOwners', uid), { username: 'renamed-name' });
  ren2.delete(doc(db, 'profileDiscovery', 'legacy-name'));
  await assertSucceeds(ren2.commit());
});

test('profile links support targeted, deduplicated arrayUnion writes up to the cap', async () => {
  await seedAccount('profile-link-owner');
  const db = verified('profile-link-owner');
  const ref = doc(db, 'profiles', 'targeted-links');
  const link = { type: 'homepage', value: 'https://example.com' };
  await assertSucceeds(createProfileBatch(db, 'profile-link-owner', 'targeted-links'));
  await assertSucceeds(updateDoc(ref, { links: arrayUnion(link), updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(ref, { links: arrayUnion(link), updatedAt: serverTimestamp() }));
  const saved = await getDoc(ref);
  assert.deepEqual(saved.data()?.links, [
    { type: 'github', value: 'ada' },
    link,
  ]);

  await seedAccount('profile-link-full-owner');
  const fullDb = verified('profile-link-full-owner');
  const fullRef = doc(fullDb, 'profiles', 'targeted-links-full');
  const tenLinks = Array.from(
    { length: 10 },
    (_, index) => ({ type: 'other', value: `example.com/${index}` }),
  );
  await assertSucceeds(createProfileBatch(fullDb, 'profile-link-full-owner', 'targeted-links-full', { links: tenLinks }));
  await assertFails(updateDoc(fullRef, {
    links: arrayUnion({ type: 'other', value: 'example.com/overflow' }),
    updatedAt: serverTimestamp(),
  }));
});

test('profile documents are readable only by their owner, public or not', async () => {
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'profiles', 'public-reader'), profile('owner'));
    await setDoc(doc(context.firestore(), 'profiles', 'private-reader'), profile('owner', { public: false }));
  });
  // Public profiles are served by the publicweb function, never read from
  // the document by anonymous or third-party clients (SEC-019).
  const anonymous = environment.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(anonymous, 'profiles', 'public-reader')));
  await assertFails(getDoc(doc(anonymous, 'profiles', 'private-reader')));
  await assertFails(getDoc(doc(anonymous, 'profiles', 'no-such-reader')));
  const stranger = environment.authenticatedContext('stranger').firestore();
  await assertFails(getDoc(doc(stranger, 'profiles', 'public-reader')));
  await assertFails(getDoc(doc(stranger, 'profiles', 'private-reader')));
  const owner = environment.authenticatedContext('owner').firestore();
  await assertSucceeds(getDoc(doc(owner, 'profiles', 'public-reader')));
  await assertSucceeds(getDoc(doc(owner, 'profiles', 'private-reader')));
});

test('owners can opt public profiles into search without making markers listable', async () => {
  await seedAccount('discovery-owner');
  const owner = verified('discovery-owner');
  const discoveryRef = doc(owner, 'profileDiscovery', 'searchable-reader');
  await assertSucceeds(createProfileBatch(owner, 'discovery-owner', 'searchable-reader'));
  const missingDiscovery = await assertSucceeds(getDoc(discoveryRef));
  assert.equal(missingDiscovery.exists(), false);
  await assertSucceeds(setDoc(discoveryRef, {
    uid: 'discovery-owner',
    createdAt: serverTimestamp(),
  }));
  await assertSucceeds(getDoc(discoveryRef));

  const anonymous = environment.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(anonymous, 'profileDiscovery', 'searchable-reader')));
  await assertFails(getDocs(collection(anonymous, 'profileDiscovery')));

  const stranger = environment.authenticatedContext('discovery-stranger').firestore();
  await assertFails(getDoc(doc(stranger, 'profileDiscovery', 'searchable-reader')));
  await assertFails(deleteDoc(doc(stranger, 'profileDiscovery', 'searchable-reader')));
  await assertSucceeds(deleteDoc(discoveryRef));
  // Profile owners may safely include a marker delete in every rename or
  // profile delete batch, even when no marker exists.
  await assertSucceeds(deleteDoc(discoveryRef));
});

test('profile discovery requires an owned public profile and an exact marker', async () => {
  await seedAccount('private-discovery-owner');
  const owner = verified('private-discovery-owner');
  await assertSucceeds(createProfileBatch(owner, 'private-discovery-owner', 'private-discovery', { public: false }));
  await assertFails(setDoc(doc(owner, 'profileDiscovery', 'private-discovery'), {
    uid: 'private-discovery-owner',
    createdAt: serverTimestamp(),
  }));

  await assertSucceeds(setDoc(
    doc(owner, 'profiles', 'private-discovery'),
    profile('private-discovery-owner'),
  ));
  await assertFails(setDoc(doc(owner, 'profileDiscovery', 'private-discovery'), {
    uid: 'someone-else',
    createdAt: serverTimestamp(),
  }));
  await assertFails(setDoc(doc(owner, 'profileDiscovery', 'private-discovery'), {
    uid: 'private-discovery-owner',
    createdAt: serverTimestamp(),
    extra: true,
  }));
  await assertSucceeds(setDoc(doc(owner, 'profileDiscovery', 'private-discovery'), {
    uid: 'private-discovery-owner',
    createdAt: serverTimestamp(),
  }));
});

test('profile rename can move its discovery marker atomically', async () => {
  await seedAccount('rename-discovery-owner');
  const db = verified('rename-discovery-owner');
  const oldProfile = doc(db, 'profiles', 'old-search-name');
  const oldDiscovery = doc(db, 'profileDiscovery', 'old-search-name');
  await assertSucceeds(createProfileBatch(db, 'rename-discovery-owner', 'old-search-name'));
  await assertSucceeds(setDoc(oldDiscovery, {
    uid: 'rename-discovery-owner',
    createdAt: serverTimestamp(),
  }));

  // The client's rename batch: new profile, old profile gone, record moved,
  // marker moved.
  const batch = writeBatch(db);
  batch.set(doc(db, 'profiles', 'new-search-name'), profile('rename-discovery-owner'));
  batch.delete(oldProfile);
  batch.set(doc(db, 'profileOwners', 'rename-discovery-owner'), { username: 'new-search-name' });
  batch.set(doc(db, 'profileDiscovery', 'new-search-name'), {
    uid: 'rename-discovery-owner',
    createdAt: serverTimestamp(),
  });
  batch.delete(oldDiscovery);
  await assertSucceeds(batch.commit());
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    assert.equal((await getDoc(doc(context.firestore(), 'profileDiscovery', 'old-search-name'))).exists(), false);
    assert.equal((await getDoc(doc(context.firestore(), 'profiles', 'old-search-name'))).exists(), false);
  });
  assert.equal((await getDoc(doc(db, 'profileDiscovery', 'new-search-name'))).exists(), true);
});

test('only the owner can write or list their profiles', async () => {
  const stranger = environment.authenticatedContext('stranger').firestore();
  await assertFails(setDoc(doc(stranger, 'profiles', 'stolen-profile'), profile('owner')));
  await assertFails(getDocs(collection(stranger, 'profiles')));

  const owner = environment.authenticatedContext('owner').firestore();
  const ownProfiles = query(collection(owner, 'profiles'), where('uid', '==', 'owner'));
  await assertSucceeds(getDocs(ownProfiles));
});

test('profile records cannot contain titles or arbitrary fields', async () => {
  await seedAccount('owner');
  const db = verified('owner');
  const withTitle = profile('owner');
  (withTitle.records.superlatives.longestSession as Record<string, unknown>).title = 'Private book';
  await assertFails(createProfileBatch(db, 'owner', 'leaky-record', withTitle));

  const extraStat = profile('owner');
  (extraStat.stats as Record<string, unknown>).favoriteBook = 1;
  await assertFails(createProfileBatch(db, 'owner', 'extra-stat', extraStat));
  // Control for the harness: the plain shape goes through.
  await assertSucceeds(createProfileBatch(db, 'owner', 'clean-record'));
});

test('profile field limits reject oversized and malformed data', async () => {
  await seedAccount('owner');
  const db = verified('owner');
  await assertFails(createProfileBatch(db, 'owner', 'too-many-links', {
    links: Array.from({ length: 11 }, (_, index) => ({ type: 'other', value: `example.com/${index}` })),
  }));
  await assertFails(createProfileBatch(db, 'owner', 'Bad Slug'));
  await assertFails(createProfileBatch(db, 'owner', 'ab'));
  await assertFails(createProfileBatch(db, 'owner', 'a'.repeat(31)));
});

// The full shape addBook writes, for allowlist tests.
const fullBook = (db: ReturnType<RulesTestContext['firestore']>, uid: string, overrides: Record<string, unknown> = {}) => creatableBook({
  authorIds: ['author-a', 'author-b'],
  owner: doc(db, 'users', uid),
  title: 'A full book',
  isbn: '9780000000002',
  coverUrl: 'https://covers.example/x-M.jpg',
  publisher: 'Example House',
  publishedDate: '2026',
  subjects: ['Fiction', 'Norway'],
  fiction: true,
  createdAt: Timestamp.now(),
  ...overrides,
});

// Field overrides the book shape rule denies, by name; the audit's mirror
// (rules-shape.ts) must deny every one of them too.
const bookShapeRejections = (
  db: ReturnType<RulesTestContext['firestore']>,
  uid: string,
): Record<string, Record<string, unknown>> => {
  const junk = 'x'.repeat(120_000);
  return {
    unknownField: { notes: junk },
    // The pre-migration fields are not admitted at all: an uncapped list
    // of maps was a 1 MiB channel (review, books face).
    legacyAuthor: { author: 'Ada Lovelace' },
    legacyAuthors: { authors: [{ name: 'x'.repeat(20_000) }] },
    legacyAuthorsMany: { authors: Array.from({ length: 50 }, () => ({ name: 'x'.repeat(20_000) })) },
    updatedAtString: { updatedAt: 'x'.repeat(500_000) },
    updatedAtMap: { updatedAt: { blob: junk } },
    pagesReadString: { pagesRead: junk },
    timeReadList: { timeRead: [junk] },
    unknownFieldSmall: { rating: 5 },
    coverUrl: { coverUrl: 'https://' + 'c'.repeat(2048) },
    publisher: { publisher: 'p'.repeat(501) },
    publishedDate: { publishedDate: 'd'.repeat(65) },
    isbn: { isbn: '9'.repeat(33) },
    title: { title: 't'.repeat(501) },
    tooManySubjects: { subjects: Array.from({ length: 26 }, (_, i) => `s${i}`) },
    fatSubjects: { subjects: ['a'.repeat(2501)] },
    fatSubjectsSpread: { subjects: Array.from({ length: 25 }, () => 'a'.repeat(101)) },
    nonStringSubject: { subjects: [{ name: 'x' }] },
    tooManyAuthorIds: { authorIds: Array.from({ length: 51 }, (_, i) => `a${i}`) },
    fatAuthorIds: { authorIds: ['a'.repeat(5001)] },
    // (A number inside authorIds is stringified by join(), not rejected —
    // the bytes stay bounded and the client decoder refuses it on read.)
    fiction: { fiction: 'yes' },
    foreignOwner: { owner: doc(db, 'users', 'someone-else') },
    ownerString: { owner: `users/${uid}` },
    createdAt: { createdAt: 'today' },
    negativeTime: { timeRead: -1 },
    fatSourceId: { currentPageUpdateId: null, pagesRead: 0 },
  };
};

test('book documents are allowlisted and byte-capped', async () => {
  const uid = 'book-shape';
  const db = environment.authenticatedContext(uid).firestore();
  const books = collection(db, 'users', uid, 'books');
  await assertSucceeds(setDoc(doc(books, 'full'), fullBook(db, uid)));
  const junk = 'x'.repeat(120_000);
  const rejected = bookShapeRejections(db, uid);
  const admitted: string[] = [];
  for (const [name, overrides] of Object.entries(rejected)) {
    if (name === 'fatSourceId') continue;
    try {
      await setDoc(doc(books, name), fullBook(db, uid, overrides));
      admitted.push(name);
    } catch (error) {
      if (!(error instanceof FirebaseError && error.code === 'permission-denied')) throw error;
    }
  }
  assert.deepEqual(admitted, []);
  // Every field is optional except what page state and the title require:
  // the minimal shape the older client wrote still works.
  await assertSucceeds(setDoc(doc(books, 'minimal'), creatableBook()));

  // Progress and timer updates never run the shape check (they only touch
  // fields the transition rules pin, and the timer batch is budget-bound),
  // so a document with an unknown field from before this rule stays
  // usable for reading — but an edit that touches anything else must shed
  // the field.
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', uid, 'books', 'pre-rule'), {
      ...readingBook({ activeTimer: null }),
      legacyNote: 'kept by an old client',
    });
    await setDoc(doc(context.firestore(), 'users', uid, 'timerLifecycle', 'current'), idleLifecycle());
  });
  const preRule = doc(books, 'pre-rule');
  const start = { start: '2026-08-24T12:00:00.000Z', operationId: 'pre-rule-op' };
  const timerBatch = writeBatch(db);
  timerBatch.update(preRule, { activeTimer: start });
  timerBatch.set(doc(db, 'users', uid, 'timerLifecycle', 'current'), localLifecycle('pre-rule', start.start, start.operationId));
  await assertSucceeds(timerBatch.commit());
  await assertFails(updateDoc(preRule, { title: 'Renamed', updatedAt: Timestamp.now() }));
  await assertSucceeds(updateDoc(preRule, { title: 'Renamed', legacyNote: deleteField(), updatedAt: Timestamp.now() }));

  // The exempt fields are typed even on the exempt path: a progress-only
  // update cannot smuggle bytes through pagesRead, timeRead or updatedAt
  // (each was a 500 KB channel before the review), nor by set-merge.
  const progressJunk: Record<string, unknown>[] = [
    { pagesRead: junk, updatedAt: Timestamp.now() },
    { timeRead: { blob: junk }, updatedAt: Timestamp.now() },
    // (A negative number is typed but not sign-checked on this path — it
    // is not a storage vector, and the check must stay cheap: this runs in
    // every timer batch, the tightest of which has ~15 conjuncts spare.)
    { updatedAt: junk },
    { updatedAt: { blob: junk } },
    { pagesRead: 'x'.repeat(520_000), timeRead: 'x'.repeat(520_000), updatedAt: Timestamp.now() },
  ];
  for (const patch of progressJunk) {
    await assertFails(updateDoc(preRule, patch));
    await assertFails(setDoc(preRule, patch, { merge: true }));
  }
  await assertSucceeds(updateDoc(preRule, { pagesRead: 30, timeRead: 90.5, updatedAt: Timestamp.now() }));
});

const author = (overrides: Record<string, unknown> = {}) => ({
  name: 'Ada Lovelace',
  nameLower: 'ada lovelace',
  kind: 'person',
  givenName: 'Ada',
  familyName: 'Lovelace',
  updatedAt: Timestamp.now(),
  ...overrides,
});
const admittedAuthors = (): Record<string, unknown>[] => [
  author(),
  { name: 'Anon' },
  { name: 'Penguin', nameLower: 'penguin', kind: 'entity' },
];
const authorShapeRejections = (): Record<string, unknown>[] => [
    author({ bio: 'x'.repeat(120_000) }),
  author({ rating: 5 }),
  author({ name: 'n'.repeat(201) }),
  author({ name: '' }),
  author({ name: 42 }),
  author({ nameLower: 'n'.repeat(201) }),
  author({ kind: 'robot' }),
  author({ givenName: 'g'.repeat(101) }),
  author({ familyName: 'f'.repeat(101) }),
  author({ updatedAt: 'now' }),
  { nothing: true },
  {},
];

test('author documents are allowlisted and capped', async () => {
  const uid = 'author-shape';
  const db = environment.authenticatedContext(uid).firestore();
  const authors = collection(db, 'users', uid, 'authors');
  await assertSucceeds(setDoc(doc(authors, 'ada'), author()));
  await assertSucceeds(setDoc(doc(authors, 'minimal'), { name: 'Anon' }));
  await assertSucceeds(setDoc(doc(authors, 'entity'), { name: 'Penguin', nameLower: 'penguin', kind: 'entity' }));
  const rejected = authorShapeRejections();
  for (const [index, value] of rejected.entries()) {
    await assertFails(setDoc(doc(authors, `bad-${index}`), value));
  }
  // Updates are shape-checked too: junk cannot be added later, including
  // inside the retirement map on any path.
  await assertFails(updateDoc(doc(authors, 'ada'), { bio: 'x'.repeat(1000) }));
  await assertFails(updateDoc(doc(authors, 'ada'), { retirement: { reason: 'deleted', blob: 'x'.repeat(500_000) } }));
  await assertFails(updateDoc(doc(authors, 'ada'), { retirement: { reason: 'merged', targetId: 'x'.repeat(101) } }));
  await assertFails(updateDoc(doc(authors, 'ada'), { retirement: { reason: 'retired' } }));
  await assertFails(updateDoc(doc(authors, 'ada'), { retirement: 'x'.repeat(500_000) }));
  await assertSucceeds(updateDoc(doc(authors, 'ada'), { givenName: 'Augusta Ada', name: 'Augusta Ada Lovelace', nameLower: 'augusta ada lovelace', updatedAt: Timestamp.now() }));
});

// The read-only audit (db-audit.ts) reports stored documents the rules
// would reject on their next client edit, through the mirror in
// rules-shape.ts. The mirror is only worth anything if it agrees with the
// rules, so every fixture above is judged by both and the verdicts must
// match in both directions; a cap moved in one place and not the other
// fails here.
const denied = async (write: Promise<unknown>): Promise<boolean> => {
  try {
    await write;
    return false;
  } catch (error) {
    if (error instanceof FirebaseError && error.code === 'permission-denied') return true;
    throw error;
  }
};

test('the audit shape mirror agrees with the rules', async () => {
  const uid = 'shape-mirror';
  const db = environment.authenticatedContext(uid).firestore();
  const books = collection(db, 'users', uid, 'books');
  const disagreements: string[] = [];

  const bookCases: Record<string, Record<string, unknown>> = {
    full: fullBook(db, uid),
    minimal: creatableBook(),
    // join('') stringifies numbers: admitted by both, bytes stay bounded.
    numericAuthorIds: fullBook(db, uid, { authorIds: [1, 2] }),
    emptyTitle: fullBook(db, uid, { title: '' }),
    nullSourceId: fullBook(db, uid, { currentPageUpdateId: null }),
  };
  for (const [name, overrides] of Object.entries(bookShapeRejections(db, uid))) {
    if (name === 'fatSourceId') continue;
    bookCases[`rejected:${name}`] = fullBook(db, uid, overrides);
  }
  for (const [name, book] of Object.entries(bookCases)) {
    const mirror = bookShapeViolations(book, `users/${uid}`);
    const rules = await denied(setDoc(doc(books, name), book));
    if (rules !== (mirror.length > 0)) disagreements.push(`book ${name}: rules ${rules ? 'deny' : 'admit'}, mirror ${JSON.stringify(mirror)}`);
  }

  const authors = collection(db, 'users', uid, 'authors');
  const authorCases = [...admittedAuthors(), ...authorShapeRejections()];
  for (const [index, value] of authorCases.entries()) {
    const mirror = authorShapeViolations(value);
    const rules = await denied(setDoc(doc(authors, `case-${index}`), value));
    if (rules !== (mirror.length > 0)) disagreements.push(`author ${index}: rules ${rules ? 'deny' : 'admit'}, mirror ${JSON.stringify(mirror)}`);
  }

  const profileCases: Record<string, Record<string, unknown>> = {
    valid: {},
    longGivenName: { givenName: 'g'.repeat(51) },
    manyLinks: { links: Array.from({ length: 11 }, () => ({ type: 'github', value: 'x' })) },
    extraField: { bio: 'x' },
    missingField: { days: undefined },
    extraStat: { stats: { ...profile(uid).stats as Record<string, unknown>, extra: 1 } },
    stringStat: { stats: { ...profile(uid).stats as Record<string, unknown>, totalBooks: '12' } },
    manyYears: { years: Array.from({ length: 201 }, (_, i) => ({ year: 1800 + i, count: 1, hours: 1, pages: 1 })) },
    manyDays: { days: Array.from({ length: 4001 }, (_, i) => ({ day: `d${i}`, pagesRead: 1, timeRead: 1, sessions: 1 })) },
    foreignUid: { uid: 'someone-else' },
  };
  for (const [name, overrides] of Object.entries(profileCases)) {
    const owner = `mirror-${name.toLowerCase()}`;
    await seedAccount(owner);
    const data = Object.fromEntries(
      Object.entries(profile(owner, overrides)).filter(([, value]) => value !== undefined),
    );
    // The stored document carries a real timestamp; the write sends the
    // sentinel the rules pin to request.time.
    const mirror = profileShapeViolations({ ...data, updatedAt: Timestamp.now() }, owner);
    const ownerDb = verified(owner);
    const batch = writeBatch(ownerDb);
    batch.set(doc(ownerDb, 'profiles', owner), data);
    batch.set(doc(ownerDb, 'profileOwners', owner), { username: owner });
    const rules = await denied(batch.commit());
    if (rules !== (mirror.length > 0)) disagreements.push(`profile ${name}: rules ${rules ? 'deny' : 'admit'}, mirror ${JSON.stringify(mirror)}`);
  }

  const recordCases: Record<string, Record<string, unknown>> = {
    valid: { username: 'record-valid' },
    extraField: { username: 'record-extrafield', note: 'x' },
    badUsername: { username: 'record-BAD' },
    numeric: { username: 42 },
  };
  for (const [name, record] of Object.entries(recordCases)) {
    const owner = `record-${name.toLowerCase()}`;
    await seedAccount(owner);
    const mirror = profileOwnerRecordViolations(record);
    const rules = await denied(createProfileBatch(verified(owner), owner, owner, {}, record));
    if (rules !== (mirror.length > 0)) disagreements.push(`record ${name}: rules ${rules ? 'deny' : 'admit'}, mirror ${JSON.stringify(mirror)}`);
  }

  assert.deepEqual(disagreements, []);
});

// Firestore evaluates at most 1000 expressions per request, and the timer
// batches (a book update plus the lifecycle claim, plus a queue row for
// the offline stops) run close to it. A ruleset that quietly crosses the
// line denies real timer operations with an opaque error. This measures
// the headroom: it loads copies of the rules with K trivial conjuncts
// injected into the books update rule — the one rule every timer batch
// evaluates exactly once — and finds the largest K under which each
// honest batch still passes: the local offline stop, the remote offline
// stop, and the outcome-unknown clear (the review's books face found the
// last one tightest, at 25 while the offline stops sat at 37, when the
// probe still measured only validAtomicTimerStop). The floor below is the
// budget a rules change may not spend without first shrinking the timer
// path.
const BUDGET_HEADROOM_FLOOR = 4;
const BUDGET_HEADROOM_PROBE_MAX = 40;

type TimerBatches = { localStop: boolean; remoteStop: boolean; unknownClear: boolean };

async function timerBatchesPassWith(rules: string, projectId: string): Promise<TimerBatches> {
  const budgetEnvironment = await initializeTestEnvironment({ projectId, firestore: { rules } });
  try {
    await budgetEnvironment.clearFirestore();
    const uid = 'budget-owner';
    await budgetEnvironment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
      const seeded = context.firestore();
      await setDoc(doc(seeded, 'users', uid), {
        uid, email: `${uid}@example.test`,
        toggl: { workspaceId: 1, projectId: 2, connectedAt: Timestamp.now() },
      });
      await setDoc(doc(seeded, 'users', uid, 'books', 'local'), creatableBook());
      await setDoc(doc(seeded, 'users', uid, 'books', 'remote'), {
        ...creatableBook(), activeTimer: { entryId: 42, start: '2026-08-24T12:00:00.000Z' },
      });
      await setDoc(doc(seeded, 'users', uid, 'timerLifecycle', 'current'), idleLifecycle());
    });
    const db = budgetEnvironment.authenticatedContext(uid).firestore();
    const lifecycleRef = doc(db, 'users', uid, 'timerLifecycle', 'current');
    const localRef = doc(db, 'users', uid, 'books', 'local');
    const remoteRef = doc(db, 'users', uid, 'books', 'remote');
    const passes = async (commit: Promise<unknown>): Promise<boolean> => {
      try {
        await commit;
        return true;
      } catch (error) {
        if (error instanceof FirebaseError && error.code === 'permission-denied') return false;
        throw error;
      }
    };

    const start = { start: '2026-08-24T13:00:00.000Z', operationId: 'budget-op' };
    const claim = localLifecycle('local', start.start, start.operationId);
    const startBatch = writeBatch(db);
    startBatch.update(localRef, { activeTimer: start });
    startBatch.set(lifecycleRef, claim);
    await startBatch.commit();
    const stopBatch = writeBatch(db);
    stopBatch.update(localRef, { activeTimer: null });
    stopBatch.set(lifecycleRef, idleLifecycle(claim));
    stopBatch.set(doc(db, 'users', uid, 'togglQueue', togglQueueId('local', start.start)), queueItem({
      bookId: 'local', bookTitle: 'Reading book', start: start.start, timerClaimVersion: 1,
    }));
    const localStop = await passes(stopBatch.commit());

    const remoteStart = '2026-08-24T12:00:00.000Z';
    await budgetEnvironment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
      await setDoc(doc(context.firestore(), 'users', uid, 'timerLifecycle', 'current'), remoteLifecycle('remote', remoteStart, 42));
    });
    const queueId = togglQueueId('remote', remoteStart);
    const stopping = { state: 'stopping', entryId: 42, start: remoteStart, queueId };
    const remoteBatch = writeBatch(db);
    remoteBatch.update(remoteRef, { activeTimer: stopping });
    remoteBatch.set(lifecycleRef, stoppingLifecycle('remote', remoteStart, 42, queueId));
    remoteBatch.set(doc(db, 'users', uid, 'togglQueue', queueId), queueItem({
      type: 'stop', bookId: 'remote', bookTitle: 'Reading book', entryId: 42,
      start: remoteStart, timerClaimVersion: 1,
    }));
    const remoteStop = await passes(remoteBatch.commit());

    // The outcome-unknown clear: server-owned timer state released by the
    // owner in one batch with the lifecycle claim.
    const unknownTimer = {
      state: 'outcome-unknown', operationId: 'server-operation', start: '2026-08-24T14:00:00.000Z',
      claimedAt: Timestamp.now(), error: 'Check Toggl first.',
    };
    const unknownClaim = { version: 1, bookId: 'unknown', ...unknownTimer };
    await budgetEnvironment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
      await setDoc(doc(context.firestore(), 'users', uid, 'books', 'unknown'), { ...creatableBook(), activeTimer: unknownTimer });
      await setDoc(doc(context.firestore(), 'users', uid, 'timerLifecycle', 'current'), unknownClaim);
    });
    const clear = writeBatch(db);
    clear.update(doc(db, 'users', uid, 'books', 'unknown'), { activeTimer: null });
    clear.set(lifecycleRef, idleLifecycle(unknownClaim));
    const unknownClear = await passes(clear.commit());
    return { localStop, remoteStop, unknownClear };
  } finally {
    await budgetEnvironment.cleanup();
  }
}

test('the timer batches keep headroom under the rules expression budget', async (t) => {
  const source = await readFile('firestore.rules', 'utf8');
  const anchor = "                    && validBookTitle()\n                    && validBookTimerTransition(userId, bookId)\n";
  assert.equal(source.split(anchor).length, 2, 'books update rule anchor moved');
  const baseline = await timerBatchesPassWith(source, 'book-tracker-rules-budget-0');
  assert.deepEqual(baseline, { localStop: true, remoteStop: true, unknownClear: true });
  const headroom: Record<keyof TimerBatches, number> = { localStop: 0, remoteStop: 0, unknownClear: 0 };
  for (let k = 1; k <= BUDGET_HEADROOM_PROBE_MAX; k += 1) {
    const padded = source.replace(anchor, `                    && validBookTitle()${' && true'.repeat(k)}\n                    && validBookTimerTransition(userId, bookId)\n`);
    const result = await timerBatchesPassWith(padded, `book-tracker-rules-budget-${k}`);
    for (const batch of ['localStop', 'remoteStop', 'unknownClear'] as const) {
      if (result[batch] && headroom[batch] === k - 1) headroom[batch] = k;
    }
    if (!result.localStop && !result.remoteStop && !result.unknownClear) break;
  }
  t.diagnostic(`book-update conjuncts tolerated — local stop ${headroom.localStop}, remote stop ${headroom.remoteStop}, unknown clear ${headroom.unknownClear} (floor ${BUDGET_HEADROOM_FLOOR})`);
  for (const [batch, value] of Object.entries(headroom)) {
    assert.ok(value >= BUDGET_HEADROOM_FLOOR, `only ${value} conjuncts of headroom left on the ${batch} batch`);
  }
});

test('book creation requires complete, consistent, JS-safe page state', async () => {
  const uid = 'book-create-page-state';
  const db = environment.authenticatedContext(uid).firestore();
  const books = collection(db, 'users', uid, 'books');
  await assertSucceeds(setDoc(doc(books, 'valid'), creatableBook()));

  const invalidBooks: Record<string, Record<string, unknown>> = {
    missing: { title: 'Missing state', activeTimer: null },
    fractional: creatableBook({ pageCount: 100.5 }),
    nonPositive: creatableBook({ pageCount: 0, currentPage: 0, finished: true }),
    unsafe: creatableBook({ pageCount: Number.MAX_SAFE_INTEGER + 1 }),
    beyondCount: creatableBook({ currentPage: 101 }),
    wrongFinished: creatableBook({ currentPage: 100, finished: false }),
  };
  for (const [id, book] of Object.entries(invalidBooks)) {
    await assertFails(setDoc(doc(books, id), book));
  }
});

test('reading and page-correction creates move the correlated book atomically', async () => {
  const uid = 'reading-create';
  const bookId = 'book';
  const db = environment.authenticatedContext(uid).firestore();
  const bookRef = doc(db, 'users', uid, 'books', bookId);
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(
      doc(context.firestore(), 'users', uid, 'books', bookId),
      readingBook({ currentPage: 10, currentPageUpdateId: null, pagesRead: 10, timeRead: 30 }),
    );
  });

  const readingRef = doc(db, 'users', uid, 'books', bookId, 'updates', 'reading');
  const reading = writeBatch(db);
  reading.set(readingRef, readingEntry(db, uid, bookId));
  reading.update(bookRef, {
    currentPage: 20,
    currentPageUpdateId: readingRef.id,
    finished: false,
    pagesRead: increment(10),
    timeRead: increment(30),
    updatedAt: Timestamp.now(),
  });
  await assertSucceeds(reading.commit());

  const correctionRef = doc(db, 'users', uid, 'books', bookId, 'updates', 'correction');
  const correction = writeBatch(db);
  correction.set(correctionRef, pageCorrectionEntry(db, uid, bookId, {
    fromPage: 20,
    toPage: 15,
    pagesRead: -5,
  }));
  correction.update(bookRef, {
    currentPage: 15,
    currentPageUpdateId: correctionRef.id,
    finished: false,
    updatedAt: Timestamp.now(),
  });
  await assertSucceeds(correction.commit());

  const saved = (await getDoc(bookRef)).data();
  assert.equal(saved?.currentPage, 15);
  assert.equal(saved?.currentPageUpdateId, 'correction');
  assert.equal(saved?.pagesRead, 20);
  assert.equal(saved?.timeRead, 60);

  const staleRef = doc(db, 'users', uid, 'books', bookId, 'updates', 'stale-reading');
  const stale = writeBatch(db);
  stale.set(staleRef, readingEntry(db, uid, bookId, { fromPage: 10, toPage: 25, pagesRead: 15 }));
  stale.update(bookRef, {
    currentPage: 25,
    currentPageUpdateId: staleRef.id,
    finished: false,
    pagesRead: increment(15),
    timeRead: increment(30),
    updatedAt: Timestamp.now(),
  });
  await assertFails(stale.commit());
});

test('an offline page-count shrink writes a correlated correction and clamps atomically', async () => {
  const uid = 'page-count-clamp';
  const bookId = 'book';
  const db = environment.authenticatedContext(uid).firestore();
  const bookRef = doc(db, 'users', uid, 'books', bookId);
  const priorRef = doc(db, 'users', uid, 'books', bookId, 'updates', 'prior-reading');
  const correctionRef = doc(db, 'users', uid, 'books', bookId, 'updates', 'page-count-clamp');
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const seed = context.firestore();
    await setDoc(doc(seed, 'users', uid, 'books', bookId), readingBook({
      authorIds: ['author'],
      currentPage: 350,
      currentPageUpdateId: 'prior-reading',
      pageCount: 400,
      finished: false,
      isbn: '',
      coverUrl: '',
      publisher: '',
      publishedDate: '',
      subjects: [],
      fiction: null,
    }));
    await setDoc(
      doc(seed, 'users', uid, 'books', bookId, 'updates', 'prior-reading'),
      pageCorrectionEntry(seed, uid, bookId, {
        fromPage: 300,
        toPage: 350,
        pagesRead: 50,
      }),
    );
  });
  await getDoc(bookRef);
  await disableNetwork(db);

  const batch = writeBatch(db);
  batch.set(correctionRef, pageCorrectionEntry(db, uid, bookId, {
    fromPage: 350,
    toPage: 320,
    pagesRead: -30,
  }));
  batch.update(bookRef, {
    authorIds: ['author'],
    title: 'Corrected edition',
    pageCount: 320,
    currentPage: 320,
    currentPageUpdateId: correctionRef.id,
    finished: true,
    isbn: '',
    coverUrl: '',
    publisher: '',
    publishedDate: '',
    subjects: [],
    fiction: null,
    updatedAt: Timestamp.now(),
  });
  const completion = batch.commit();
  const [localBook, localCorrection] = await Promise.all([
    getDocFromCache(bookRef),
    getDocFromCache(correctionRef),
  ]);
  assert.equal(localBook.metadata.hasPendingWrites, true);
  assert.equal(localBook.data()?.pageCount, 320);
  assert.equal(localBook.data()?.currentPage, 320);
  assert.equal(localBook.data()?.currentPageUpdateId, 'page-count-clamp');
  assert.equal(localBook.data()?.finished, true);
  assert.equal(localCorrection.data()?.pagesRead, -30);

  await enableNetwork(db);
  await completion;
  const saved = (await getDoc(bookRef)).data();
  assert.equal(saved?.pageCount, 320);
  assert.equal(saved?.currentPage, 320);
  assert.equal(saved?.currentPageUpdateId, 'page-count-clamp');
  assert.equal((await getDoc(priorRef)).exists(), true);

  await assertSucceeds(updateDoc(bookRef, {
    pageCount: 500,
    finished: false,
    updatedAt: Timestamp.now(),
  }));
  assert.equal((await getDoc(bookRef)).data()?.currentPageUpdateId, 'page-count-clamp');
  await assertSucceeds(updateDoc(bookRef, {
    pageCount: 320,
    finished: true,
    updatedAt: Timestamp.now(),
  }));
  assert.equal((await getDoc(bookRef)).data()?.currentPageUpdateId, 'page-count-clamp');

  await assertFails(updateDoc(bookRef, {
    pageCount: 300,
    finished: false,
    updatedAt: Timestamp.now(),
  }));
  await assertFails(updateDoc(bookRef, {
    pageCount: 500,
    finished: true,
    updatedAt: Timestamp.now(),
  }));
  await assertFails(updateDoc(bookRef, {
    pageCount: 0,
    currentPage: 0,
    currentPageUpdateId: null,
    finished: true,
    updatedAt: Timestamp.now(),
  }));

  await assertSucceeds(updateDoc(bookRef, {
    pageCount: 500,
    finished: false,
    updatedAt: Timestamp.now(),
  }));
  const extraRef = doc(db, 'users', uid, 'books', bookId, 'updates', 'extra-field-clamp');
  const extra = writeBatch(db);
  extra.set(extraRef, pageCorrectionEntry(db, uid, bookId, {
    fromPage: 320,
    toPage: 300,
    pagesRead: -20,
  }));
  extra.update(bookRef, {
    pageCount: 300,
    currentPage: 300,
    currentPageUpdateId: extraRef.id,
    finished: true,
    unexpectedField: 'not editable metadata',
    updatedAt: Timestamp.now(),
  });
  await assertFails(extra.commit());
});

test('a page-count clamp establishes progress provenance on a legacy book', async () => {
  const uid = 'page-count-clamp-legacy';
  const bookId = 'book';
  const db = environment.authenticatedContext(uid).firestore();
  const bookRef = doc(db, 'users', uid, 'books', bookId);
  const correctionRef = doc(
    db,
    'users',
    uid,
    'books',
    bookId,
    'updates',
    'legacy-clamp',
  );
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(
      doc(context.firestore(), 'users', uid, 'books', bookId),
      legacyReadingBook({ currentPage: 350, pageCount: 400, finished: false }),
    );
  });

  const batch = writeBatch(db);
  batch.set(correctionRef, pageCorrectionEntry(db, uid, bookId, {
    fromPage: 350,
    toPage: 320,
    pagesRead: -30,
  }));
  batch.update(bookRef, {
    pageCount: 320,
    currentPage: 320,
    currentPageUpdateId: correctionRef.id,
    finished: true,
    updatedAt: Timestamp.now(),
  });
  await assertSucceeds(batch.commit());
  const saved = (await getDoc(bookRef)).data();
  assert.equal(saved?.currentPage, 320);
  assert.equal(saved?.currentPageUpdateId, 'legacy-clamp');
});

test('a title-only edit repairs legacy progress beyond an unchanged page count', async () => {
  const uid = 'page-count-clamp-inflated-legacy';
  const bookId = 'book';
  const db = environment.authenticatedContext(uid).firestore();
  const bookRef = doc(db, 'users', uid, 'books', bookId);
  const correctionRef = doc(
    db,
    'users',
    uid,
    'books',
    bookId,
    'updates',
    'title-edit-repair',
  );
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(
      doc(context.firestore(), 'users', uid, 'books', bookId),
      readingBook({
        title: 'Old title',
        currentPage: 350,
        currentPageUpdateId: 'prior-reading',
        pageCount: 320,
        finished: false,
      }),
    );
  });

  const batch = writeBatch(db);
  batch.set(correctionRef, pageCorrectionEntry(db, uid, bookId, {
    fromPage: 350,
    toPage: 320,
    pagesRead: -30,
  }));
  batch.update(bookRef, {
    title: 'New title',
    currentPage: 320,
    currentPageUpdateId: correctionRef.id,
    finished: true,
    updatedAt: Timestamp.now(),
  });
  await assertSucceeds(batch.commit());

  const saved = (await getDoc(bookRef)).data();
  assert.equal(saved?.title, 'New title');
  assert.equal(saved?.pageCount, 320);
  assert.equal(saved?.currentPage, 320);
  assert.equal(saved?.currentPageUpdateId, correctionRef.id);
});

test('a stale offline page-count clamp rejects and rolls back after a newer reading', async () => {
  const uid = 'page-count-clamp-stale';
  const bookId = 'book';
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const seed = context.firestore();
    await setDoc(doc(seed, 'users', uid, 'books', bookId), readingBook({
      currentPage: 350,
      currentPageUpdateId: 'prior-reading',
      pageCount: 400,
      finished: false,
      pagesRead: 350,
      timeRead: 60,
    }));
    await setDoc(
      doc(seed, 'users', uid, 'books', bookId, 'updates', 'prior-reading'),
      pageCorrectionEntry(seed, uid, bookId, {
        fromPage: 300,
        toPage: 350,
        pagesRead: 50,
      }),
    );
  });

  const staleDb = environment.authenticatedContext(uid).firestore();
  const staleBookRef = doc(staleDb, 'users', uid, 'books', bookId);
  const staleCorrectionRef = doc(
    staleDb,
    'users',
    uid,
    'books',
    bookId,
    'updates',
    'stale-clamp',
  );
  await getDoc(staleBookRef);
  await disableNetwork(staleDb);

  const stale = writeBatch(staleDb);
  stale.set(staleCorrectionRef, pageCorrectionEntry(staleDb, uid, bookId, {
    fromPage: 350,
    toPage: 320,
    pagesRead: -30,
  }));
  stale.update(staleBookRef, {
    title: 'Stale metadata title',
    pageCount: 320,
    currentPage: 320,
    currentPageUpdateId: staleCorrectionRef.id,
    finished: true,
    updatedAt: Timestamp.now(),
  });
  const staleCompletion = stale.commit();
  assert.equal((await getDocFromCache(staleBookRef)).data()?.currentPage, 320);
  assert.equal((await getDocFromCache(staleCorrectionRef)).exists(), true);

  const winnerDb = environment.authenticatedContext(uid).firestore();
  const winnerBookRef = doc(winnerDb, 'users', uid, 'books', bookId);
  const winnerRef = doc(winnerDb, 'users', uid, 'books', bookId, 'updates', 'winner-reading');
  const winner = writeBatch(winnerDb);
  winner.set(winnerRef, readingEntry(winnerDb, uid, bookId, {
    fromPage: 350,
    toPage: 360,
    pagesRead: 10,
  }));
  winner.update(winnerBookRef, {
    currentPage: 360,
    currentPageUpdateId: winnerRef.id,
    finished: false,
    pagesRead: increment(10),
    timeRead: increment(30),
    updatedAt: Timestamp.now(),
  });
  await assertSucceeds(winner.commit());

  await enableNetwork(staleDb);
  await assert.rejects(staleCompletion);
  const [rolledBackBook, rolledBackCorrection] = await Promise.all([
    getDoc(staleBookRef),
    getDoc(staleCorrectionRef),
  ]);
  assert.equal(rolledBackBook.data()?.title, 'Reading book');
  assert.equal(rolledBackBook.data()?.pageCount, 400);
  assert.equal(rolledBackBook.data()?.currentPage, 360);
  assert.equal(rolledBackBook.data()?.currentPageUpdateId, 'winner-reading');
  assert.equal(rolledBackBook.data()?.pagesRead, 360);
  assert.equal(rolledBackCorrection.exists(), false);
});

test('a stale ordinary metadata edit preserves concurrent reading progress', async () => {
  const uid = 'page-count-metadata-race';
  const bookId = 'book';
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(
      doc(context.firestore(), 'users', uid, 'books', bookId),
      readingBook({
        currentPage: 350,
        currentPageUpdateId: 'prior-reading',
        pageCount: 400,
        pagesRead: 350,
      }),
    );
  });

  const staleDb = environment.authenticatedContext(uid).firestore();
  const staleBookRef = doc(staleDb, 'users', uid, 'books', bookId);
  await getDoc(staleBookRef);
  await disableNetwork(staleDb);
  const staleCompletion = updateDoc(staleBookRef, {
    title: 'Offline metadata title',
    pageCount: 390,
    finished: false,
    updatedAt: Timestamp.now(),
  });
  assert.equal((await getDocFromCache(staleBookRef)).data()?.pageCount, 390);

  const winnerDb = environment.authenticatedContext(uid).firestore();
  const winnerBookRef = doc(winnerDb, 'users', uid, 'books', bookId);
  const winnerRef = doc(winnerDb, 'users', uid, 'books', bookId, 'updates', 'winner-reading');
  const winner = writeBatch(winnerDb);
  winner.set(winnerRef, readingEntry(winnerDb, uid, bookId, {
    fromPage: 350,
    toPage: 360,
    pagesRead: 10,
  }));
  winner.update(winnerBookRef, {
    currentPage: 360,
    currentPageUpdateId: winnerRef.id,
    finished: false,
    pagesRead: increment(10),
    timeRead: increment(30),
    updatedAt: Timestamp.now(),
  });
  await assertSucceeds(winner.commit());

  await enableNetwork(staleDb);
  await staleCompletion;
  const saved = (await getDoc(staleBookRef)).data();
  assert.equal(saved?.title, 'Offline metadata title');
  assert.equal(saved?.pageCount, 390);
  assert.equal(saved?.currentPage, 360);
  assert.equal(saved?.currentPageUpdateId, 'winner-reading');
  assert.equal(saved?.pagesRead, 360);
});

test('session mutations pin the row and correlated aggregate invariants', async () => {
  const uid = 'reading-invariants';
  const bookId = 'book';
  const db = environment.authenticatedContext(uid).firestore();
  const bookRef = doc(db, 'users', uid, 'books', bookId);
  const sessionRef = doc(db, 'users', uid, 'books', bookId, 'updates', 'session');
  const correctionRef = doc(db, 'users', uid, 'books', bookId, 'updates', 'correction');
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const seed = context.firestore();
    await setDoc(doc(seed, 'users', uid, 'books', bookId), readingBook());
    await setDoc(
      doc(seed, 'users', uid, 'books', bookId, 'updates', 'session'),
      readingEntry(seed, uid, bookId),
    );
    await setDoc(
      doc(seed, 'users', uid, 'books', bookId, 'updates', 'correction'),
      pageCorrectionEntry(seed, uid, bookId, {
        fromPage: 5,
        toPage: 10,
        pagesRead: 5,
      }),
    );
  });

  const invalidUpdate = async (
    sessionPatch: Record<string, unknown>,
    bookPatch: Record<string, unknown> = {},
  ) => {
    const batch = writeBatch(db);
    batch.update(sessionRef, {
      timeRead: 45,
      toPage: 25,
      pagesRead: 15,
      updatedAt: Timestamp.now(),
      ...sessionPatch,
    });
    batch.update(bookRef, {
      currentPage: 25,
      finished: false,
      pagesRead: increment(5),
      timeRead: increment(15),
      updatedAt: Timestamp.now(),
      ...bookPatch,
    });
    await assertFails(batch.commit());
  };

  await invalidUpdate({ owner: doc(db, 'users', 'someone-else') });
  await invalidUpdate({ book: doc(db, 'users', uid, 'books', 'other') });
  await invalidUpdate({ type: 'update' });
  await invalidUpdate({ createdAt: Timestamp.now() });
  await invalidUpdate({ fromPage: 11, pagesRead: 14 });
  await invalidUpdate({ note: 'extra field' });
  await invalidUpdate({ timeRead: 0 }, { timeRead: increment(-30) });
  await invalidUpdate({ toPage: 10, pagesRead: 0 }, { currentPage: 10, pagesRead: increment(-10) });
  await invalidUpdate({}, { title: 'Unrelated rewrite' });
  await invalidUpdate({}, { updatedAt: 'not a timestamp' });
  await invalidUpdate({}, { finished: true });
  await assertFails(updateDoc(bookRef, {
    currentPage: 10,
    currentPageUpdateId: 'correction',
    finished: false,
    updatedAt: Timestamp.now(),
  }));

  const correctionDelete = writeBatch(db);
  correctionDelete.delete(correctionRef);
  correctionDelete.update(bookRef, { currentPage: 10, finished: false, updatedAt: Timestamp.now() });
  await assertFails(correctionDelete.commit());

  const correctionUpdate = writeBatch(db);
  correctionUpdate.update(correctionRef, { toPage: 25, pagesRead: 15, updatedAt: Timestamp.now() });
  correctionUpdate.update(bookRef, { currentPage: 25, finished: false, updatedAt: Timestamp.now() });
  await assertFails(correctionUpdate.commit());

  const wrongDelete = writeBatch(db);
  wrongDelete.delete(sessionRef);
  wrongDelete.update(bookRef, {
    currentPage: 10,
    finished: false,
    pagesRead: increment(-9),
    timeRead: increment(-30),
    updatedAt: Timestamp.now(),
  });
  await assertFails(wrongDelete.commit());
});

test('stale and missing session batches fail without double-applying aggregates', async () => {
  const uid = 'reading-stale';
  const bookId = 'book';
  const db = environment.authenticatedContext(uid).firestore();
  const writerDb = readingSessionWriteStore(db);
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const seed = context.firestore();
    await setDoc(doc(seed, 'users', uid, 'books', bookId), readingBook());
    await setDoc(
      doc(seed, 'users', uid, 'books', bookId, 'updates', 'session'),
      readingEntry(seed, uid, bookId),
    );
    await setDoc(
      doc(seed, 'users', uid, 'books', 'missing-book', 'updates', 'orphan'),
      readingEntry(seed, uid, 'missing-book'),
    );
  });
  const previous = { fromPage: 10, toPage: 20, pagesRead: 10, timeRead: 30 };
  await assertSucceeds(queueReadingSessionUpdate({
    firestore: writerDb,
    userId: uid,
    bookId,
    sessionId: 'session',
    previous,
    book: { currentPage: 20, currentPageUpdateId: 'session', pageCount: 100 },
    next: { fromPage: 10, toPage: 25, timeRead: 45 },
  }));
  await assertFails(queueReadingSessionUpdate({
    firestore: writerDb,
    userId: uid,
    bookId,
    sessionId: 'session',
    previous,
    book: { currentPage: 20, currentPageUpdateId: 'session', pageCount: 100 },
    next: { fromPage: 10, toPage: 30, timeRead: 60 },
  }));
  await assertFails(queueReadingSessionUpdate({
    firestore: writerDb,
    userId: uid,
    bookId,
    sessionId: 'missing-session',
    previous,
    book: { currentPage: 25, currentPageUpdateId: 'session', pageCount: 100 },
    next: { fromPage: 10, toPage: 30, timeRead: 60 },
  }));
  await assertFails(queueReadingSessionUpdate({
    firestore: writerDb,
    userId: uid,
    bookId: 'missing-book',
    sessionId: 'orphan',
    previous,
    book: { currentPage: 20, currentPageUpdateId: 'orphan', pageCount: 100 },
    next: { fromPage: 10, toPage: 25, timeRead: 45 },
  }));

  const savedBook = (await getDoc(doc(db, 'users', uid, 'books', bookId))).data();
  assert.equal(savedBook?.pagesRead, 25);
  assert.equal(savedBook?.timeRead, 75);
  assert.equal(savedBook?.currentPage, 25);
});

test('session deletion cannot drive aggregate totals negative', async () => {
  const uid = 'reading-nonnegative';
  const bookId = 'book';
  const db = environment.authenticatedContext(uid).firestore();
  const writerDb = readingSessionWriteStore(db);
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const seed = context.firestore();
    await setDoc(
      doc(seed, 'users', uid, 'books', bookId),
      readingBook({ pagesRead: 5, timeRead: 20 }),
    );
    await setDoc(
      doc(seed, 'users', uid, 'books', bookId, 'updates', 'session'),
      readingEntry(seed, uid, bookId),
    );
  });
  await assertFails(queueReadingSessionDelete({
    firestore: writerDb,
    userId: uid,
    bookId,
    sessionId: 'session',
    previous: { fromPage: 10, toPage: 20, pagesRead: 10, timeRead: 30 },
    book: { currentPage: 20, currentPageUpdateId: 'session', pageCount: 100 },
    previousProgressUpdate: null,
  }));
});

test('session update and delete enter the local cache while Firestore is offline', async () => {
  const uid = 'reading-offline';
  const bookId = 'book';
  const db = environment.authenticatedContext(uid).firestore();
  const writerDb = readingSessionWriteStore(db);
  const bookRef = doc(db, 'users', uid, 'books', bookId);
  const sessionRef = doc(db, 'users', uid, 'books', bookId, 'updates', 'session');
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const seed = context.firestore();
    await setDoc(doc(seed, 'users', uid, 'books', bookId), readingBook());
    await setDoc(
      doc(seed, 'users', uid, 'books', bookId, 'updates', 'session'),
      readingEntry(seed, uid, bookId),
    );
    await setDoc(
      doc(seed, 'users', uid, 'books', bookId, 'updates', 'prior'),
      readingEntry(seed, uid, bookId, {
        fromPage: 0, toPage: 10, pagesRead: 10,
        createdAt: Timestamp.fromMillis(Date.now() - 1_000),
      }),
    );
  });
  await Promise.all([getDoc(bookRef), getDoc(sessionRef)]);

  await disableNetwork(db);
  const updateCompletion = queueReadingSessionUpdate({
    firestore: writerDb,
    userId: uid,
    bookId,
    sessionId: 'session',
    previous: { fromPage: 10, toPage: 20, pagesRead: 10, timeRead: 30 },
    book: { currentPage: 20, currentPageUpdateId: 'session', pageCount: 100 },
    next: { fromPage: 10, toPage: 25, timeRead: 45 },
  });
  const [localSession, localBook] = await Promise.all([
    getDocFromCache(sessionRef),
    getDocFromCache(bookRef),
  ]);
  assert.equal(localSession.metadata.hasPendingWrites, true);
  assert.equal(localSession.data()?.toPage, 25);
  assert.equal(localBook.metadata.hasPendingWrites, true);
  assert.equal(localBook.data()?.pagesRead, 25);
  assert.equal(localBook.data()?.timeRead, 75);
  assert.equal(localBook.data()?.currentPage, 25);
  assert.equal(localBook.data()?.currentPageUpdateId, 'session');
  await enableNetwork(db);
  await updateCompletion;

  await disableNetwork(db);
  const deleteCompletion = queueReadingSessionDelete({
    firestore: writerDb,
    userId: uid,
    bookId,
    sessionId: 'session',
    previous: { fromPage: 10, toPage: 25, pagesRead: 15, timeRead: 45 },
    book: { currentPage: 25, currentPageUpdateId: 'session', pageCount: 100 },
    previousProgressUpdate: {id: 'prior', toPage: 10},
  });
  const [deletedSession, deletedBook] = await Promise.all([
    getDocFromCache(sessionRef),
    getDocFromCache(bookRef),
  ]);
  assert.equal(deletedSession.exists(), false);
  assert.equal(deletedBook.metadata.hasPendingWrites, true);
  assert.equal(deletedBook.data()?.pagesRead, 10);
  assert.equal(deletedBook.data()?.timeRead, 30);
  assert.equal(deletedBook.data()?.currentPage, 10);
  assert.equal(deletedBook.data()?.currentPageUpdateId, 'prior');
  await enableNetwork(db);
  await deleteCompletion;
});

test('deleting progress owners hands off to surviving reading and correction rows', async () => {
  const uid = 'reading-delete-handoff';
  const db = environment.authenticatedContext(uid).firestore();
  const writerDb = readingSessionWriteStore(db);
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const seed = context.firestore();
    for (const [bookId, priorType] of [['reading-prior', 'reading'], ['correction-prior', 'update']] as const) {
      await setDoc(
        doc(seed, 'users', uid, 'books', bookId),
        readingBook({currentPageUpdateId: 'latest'}),
      );
      const prior = priorType === 'reading'
        ? readingEntry(seed, uid, bookId, {fromPage: 0, toPage: 10, pagesRead: 10})
        : pageCorrectionEntry(seed, uid, bookId, {fromPage: 5, toPage: 10, pagesRead: 5});
      await setDoc(doc(seed, 'users', uid, 'books', bookId, 'updates', 'prior'), prior);
      await setDoc(
        doc(seed, 'users', uid, 'books', bookId, 'updates', 'latest'),
        readingEntry(seed, uid, bookId),
      );
    }
  });

  for (const bookId of ['reading-prior', 'correction-prior']) {
    await assertSucceeds(queueReadingSessionDelete({
      firestore: writerDb,
      userId: uid,
      bookId,
      sessionId: 'latest',
      previous: {fromPage: 10, toPage: 20, pagesRead: 10, timeRead: 30},
      book: {currentPage: 20, currentPageUpdateId: 'latest', pageCount: 100},
      previousProgressUpdate: {id: 'prior', toPage: 10},
    }));
    const saved = (await getDoc(doc(db, 'users', uid, 'books', bookId))).data();
    assert.equal(saved?.currentPage, 10);
    assert.equal(saved?.currentPageUpdateId, 'prior');
    assert.equal(saved?.pagesRead, 10);
    assert.equal(saved?.timeRead, 30);
  }

  await assertSucceeds(queueReadingSessionDelete({
    firestore: writerDb,
    userId: uid,
    bookId: 'reading-prior',
    sessionId: 'prior',
    previous: {fromPage: 0, toPage: 10, pagesRead: 10, timeRead: 30},
    book: {currentPage: 10, currentPageUpdateId: 'prior', pageCount: 100},
    previousProgressUpdate: null,
  }));
  const emptied = (await getDoc(doc(db, 'users', uid, 'books', 'reading-prior'))).data();
  assert.equal(emptied?.currentPage, 0);
  assert.equal(emptied?.currentPageUpdateId, null);
  assert.equal(emptied?.pagesRead, 0);
  assert.equal(emptied?.timeRead, 0);
});

test('session deletion rejects missing, wrong-page, and cross-book progress predecessors', async () => {
  const uid = 'reading-delete-invalid-predecessor';
  const db = environment.authenticatedContext(uid).firestore();
  const writerDb = readingSessionWriteStore(db);
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const seed = context.firestore();
    for (const bookId of ['missing', 'wrong-page', 'cross-book', 'other']) {
      await setDoc(
        doc(seed, 'users', uid, 'books', bookId),
        readingBook({currentPageUpdateId: bookId === 'other' ? 'predecessor' : 'latest'}),
      );
      if (bookId !== 'other') {
        await setDoc(
          doc(seed, 'users', uid, 'books', bookId, 'updates', 'latest'),
          readingEntry(seed, uid, bookId),
        );
      }
    }
    await setDoc(
      doc(seed, 'users', uid, 'books', 'wrong-page', 'updates', 'predecessor'),
      readingEntry(seed, uid, 'wrong-page', {fromPage: 0, toPage: 9, pagesRead: 9}),
    );
    await setDoc(
      doc(seed, 'users', uid, 'books', 'other', 'updates', 'predecessor'),
      readingEntry(seed, uid, 'other', {fromPage: 0, toPage: 10, pagesRead: 10}),
    );
  });

  for (const bookId of ['missing', 'wrong-page', 'cross-book']) {
    await assertFails(queueReadingSessionDelete({
      firestore: writerDb,
      userId: uid,
      bookId,
      sessionId: 'latest',
      previous: {fromPage: 10, toPage: 20, pagesRead: 10, timeRead: 30},
      book: {currentPage: 20, currentPageUpdateId: 'latest', pageCount: 100},
      // The local candidate claims the right endpoint; rules verify the
      // actual same-book row exists and agrees.
      previousProgressUpdate: {id: 'predecessor', toPage: 10},
    }));
    assert.equal(
      (await getDoc(doc(db, 'users', uid, 'books', bookId))).data()?.currentPageUpdateId,
      'latest',
    );
  }
});

test('zero-page timed reading and legacy aggregate defaults correlate safely', async () => {
  const uid = 'reading-zero-legacy';
  const db = environment.authenticatedContext(uid).firestore();
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const seed = context.firestore();
    await setDoc(
      doc(seed, 'users', uid, 'books', 'zero'),
      readingBook({
        currentPage: 10,
        currentPageUpdateId: null,
        pagesRead: 10,
        timeRead: 30,
      }),
    );
    const { pagesRead: _pagesRead, timeRead: _timeRead, ...legacy } = legacyReadingBook({
      currentPage: 10,
    });
    await setDoc(doc(seed, 'users', uid, 'books', 'legacy'), legacy);
    await setDoc(doc(seed, 'users', uid, 'books', 'old-client'), legacy);
    await setDoc(
      doc(seed, 'users', uid, 'books', 'new-old-client'),
      readingBook({ currentPage: 10, currentPageUpdateId: null }),
    );
  });

  const zeroBookRef = doc(db, 'users', uid, 'books', 'zero');
  const zeroRef = doc(db, 'users', uid, 'books', 'zero', 'updates', 'zero-reading');
  const zero = writeBatch(db);
  zero.set(zeroRef, readingEntry(db, uid, 'zero', {
    timeRead: 5,
    fromPage: 10,
    toPage: 10,
    pagesRead: 0,
  }));
  zero.update(zeroBookRef, {
    currentPage: 10,
    currentPageUpdateId: zeroRef.id,
    finished: false,
    pagesRead: increment(0),
    timeRead: increment(5),
    updatedAt: Timestamp.now(),
  });
  await assertSucceeds(zero.commit());
  const zeroSaved = (await getDoc(zeroBookRef)).data();
  assert.equal(zeroSaved?.pagesRead, 10);
  assert.equal(zeroSaved?.timeRead, 35);
  assert.equal(zeroSaved?.currentPageUpdateId, 'zero-reading');

  const legacyBookRef = doc(db, 'users', uid, 'books', 'legacy');
  const legacyRef = doc(db, 'users', uid, 'books', 'legacy', 'updates', 'new-reading');
  const legacy = writeBatch(db);
  legacy.set(legacyRef, readingEntry(db, uid, 'legacy', {
    timeRead: 5,
    fromPage: 10,
    toPage: 12,
    pagesRead: 2,
  }));
  legacy.update(legacyBookRef, {
    currentPage: 12,
    currentPageUpdateId: legacyRef.id,
    finished: false,
    pagesRead: increment(2),
    timeRead: increment(5),
    updatedAt: Timestamp.now(),
  });
  await assertSucceeds(legacy.commit());
  const legacySaved = (await getDoc(legacyBookRef)).data();
  assert.equal(legacySaved?.pagesRead, 2);
  assert.equal(legacySaved?.timeRead, 5);
  assert.equal(legacySaved?.currentPageUpdateId, 'new-reading');

  // A cached pre-migration client omits the source field. Permit that only
  // while the server book itself genuinely lacks the field.
  const oldBookRef = doc(db, 'users', uid, 'books', 'old-client');
  const oldRef = doc(db, 'users', uid, 'books', 'old-client', 'updates', 'old-reading');
  const oldClient = writeBatch(db);
  oldClient.set(oldRef, readingEntry(db, uid, 'old-client', {
    timeRead: 5,
    fromPage: 10,
    toPage: 11,
    pagesRead: 1,
  }));
  oldClient.update(oldBookRef, {
    currentPage: 11,
    finished: false,
    pagesRead: increment(1),
    timeRead: increment(5),
    updatedAt: Timestamp.now(),
  });
  await assertSucceeds(oldClient.commit());
  assert.equal((await getDoc(oldBookRef)).data()?.currentPageUpdateId, undefined);

  const incompatibleBookRef = doc(db, 'users', uid, 'books', 'new-old-client');
  const incompatibleRef = doc(
    db,
    'users',
    uid,
    'books',
    'new-old-client',
    'updates',
    'old-reading',
  );
  const incompatible = writeBatch(db);
  incompatible.set(incompatibleRef, readingEntry(db, uid, 'new-old-client', {
    timeRead: 5,
    fromPage: 10,
    toPage: 11,
    pagesRead: 1,
  }));
  incompatible.update(incompatibleBookRef, {
    currentPage: 11,
    finished: false,
    pagesRead: increment(1),
    timeRead: increment(5),
    updatedAt: Timestamp.now(),
  });
  await assertFails(incompatible.commit());
});

test('same-endpoint later correction prevents an older session from owning progress', async () => {
  const uid = 'reading-source-identity';
  const bookId = 'book';
  const db = environment.authenticatedContext(uid).firestore();
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const seed = context.firestore();
    await setDoc(
      doc(seed, 'users', uid, 'books', bookId),
      readingBook({ currentPageUpdateId: 'correction' }),
    );
    await setDoc(
      doc(seed, 'users', uid, 'books', bookId, 'updates', 'session'),
      readingEntry(seed, uid, bookId),
    );
    await setDoc(
      doc(seed, 'users', uid, 'books', bookId, 'updates', 'correction'),
      pageCorrectionEntry(seed, uid, bookId, {
        fromPage: 15,
        toPage: 20,
        pagesRead: 5,
      }),
    );
  });

  await assertSucceeds(queueReadingSessionUpdate({
    firestore: readingSessionWriteStore(db),
    userId: uid,
    bookId,
    sessionId: 'session',
    previous: { fromPage: 10, toPage: 20, pagesRead: 10, timeRead: 30 },
    book: { currentPage: 20, currentPageUpdateId: 'correction', pageCount: 100 },
    next: { fromPage: 10, toPage: 18, timeRead: 25 },
  }));
  let saved = (await getDoc(doc(db, 'users', uid, 'books', bookId))).data();
  assert.equal(saved?.currentPage, 20);
  assert.equal(saved?.currentPageUpdateId, 'correction');

  await assertSucceeds(queueReadingSessionDelete({
    firestore: readingSessionWriteStore(db),
    userId: uid,
    bookId,
    sessionId: 'session',
    previous: { fromPage: 10, toPage: 18, pagesRead: 8, timeRead: 25 },
    book: { currentPage: 20, currentPageUpdateId: 'correction', pageCount: 100 },
    previousProgressUpdate: null,
  }));
  saved = (await getDoc(doc(db, 'users', uid, 'books', bookId))).data();
  assert.equal(saved?.currentPage, 20);
  assert.equal(saved?.currentPageUpdateId, 'correction');
});

test('session edit/delete races reject in either order and a delete cannot repeat', async () => {
  const uid = 'reading-ordering';
  const db = environment.authenticatedContext(uid).firestore();
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const seed = context.firestore();
    for (const bookId of ['edit-first', 'delete-first']) {
      await setDoc(doc(seed, 'users', uid, 'books', bookId), readingBook());
      await setDoc(
        doc(seed, 'users', uid, 'books', bookId, 'updates', 'session'),
        readingEntry(seed, uid, bookId),
      );
    }
  });
  const previous = { fromPage: 10, toPage: 20, pagesRead: 10, timeRead: 30 };
  const sourceBook = { currentPage: 20, currentPageUpdateId: 'session', pageCount: 100 };

  await assertSucceeds(queueReadingSessionUpdate({
    firestore: readingSessionWriteStore(db),
    userId: uid,
    bookId: 'edit-first',
    sessionId: 'session',
    previous,
    book: sourceBook,
    next: { fromPage: 10, toPage: 25, timeRead: 45 },
  }));
  await assertFails(queueReadingSessionDelete({
    firestore: readingSessionWriteStore(db),
    userId: uid,
    bookId: 'edit-first',
    sessionId: 'session',
    previous,
    book: sourceBook,
    previousProgressUpdate: null,
  }));

  await assertSucceeds(queueReadingSessionDelete({
    firestore: readingSessionWriteStore(db),
    userId: uid,
    bookId: 'delete-first',
    sessionId: 'session',
    previous,
    book: sourceBook,
    previousProgressUpdate: null,
  }));
  await assertFails(queueReadingSessionUpdate({
    firestore: readingSessionWriteStore(db),
    userId: uid,
    bookId: 'delete-first',
    sessionId: 'session',
    previous,
    book: sourceBook,
    next: { fromPage: 10, toPage: 25, timeRead: 45 },
  }));
  await assertFails(queueReadingSessionDelete({
    firestore: readingSessionWriteStore(db),
    userId: uid,
    bookId: 'delete-first',
    sessionId: 'session',
    previous,
    book: sourceBook,
    previousProgressUpdate: null,
  }));

  const deletedBook = (await getDoc(doc(db, 'users', uid, 'books', 'delete-first'))).data();
  assert.equal(deletedBook?.pagesRead, 10);
  assert.equal(deletedBook?.timeRead, 30);
  assert.equal(deletedBook?.currentPage, 10);
  assert.equal(deletedBook?.currentPageUpdateId, null);
});

test('an offline session batch flushes successfully without priming the local cache', async () => {
  const uid = 'reading-cache-miss';
  const bookId = 'book';
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const seed = context.firestore();
    await setDoc(doc(seed, 'users', uid, 'books', bookId), readingBook());
    await setDoc(
      doc(seed, 'users', uid, 'books', bookId, 'updates', 'session'),
      readingEntry(seed, uid, bookId),
    );
  });
  const offlineDb = environment.authenticatedContext(uid).firestore();
  await assert.rejects(
    getDocFromCache(doc(offlineDb, 'users', uid, 'books', bookId)),
    /cache/i,
  );
  await disableNetwork(offlineDb);
  const completion = queueReadingSessionUpdate({
    firestore: readingSessionWriteStore(offlineDb),
    userId: uid,
    bookId,
    sessionId: 'session',
    previous: { fromPage: 10, toPage: 20, pagesRead: 10, timeRead: 30 },
    book: { currentPage: 20, currentPageUpdateId: 'session', pageCount: 100 },
    next: { fromPage: 10, toPage: 25, timeRead: 45 },
  });
  await enableNetwork(offlineDb);
  await completion;

  const verifier = environment.authenticatedContext(uid).firestore();
  const saved = (await getDoc(doc(verifier, 'users', uid, 'books', bookId))).data();
  assert.equal(saved?.currentPage, 25);
  assert.equal(saved?.currentPageUpdateId, 'session');
  assert.equal(saved?.pagesRead, 25);
  assert.equal(saved?.timeRead, 75);
});

test('a stale offline session write rolls its optimistic cache back after reconnect', async () => {
  const uid = 'reading-offline-stale';
  const bookId = 'book';
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const seed = context.firestore();
    await setDoc(doc(seed, 'users', uid, 'books', bookId), readingBook());
    await setDoc(
      doc(seed, 'users', uid, 'books', bookId, 'updates', 'session'),
      readingEntry(seed, uid, bookId),
    );
  });
  const staleDb = environment.authenticatedContext(uid).firestore();
  const staleBookRef = doc(staleDb, 'users', uid, 'books', bookId);
  const staleSessionRef = doc(staleDb, 'users', uid, 'books', bookId, 'updates', 'session');
  await Promise.all([getDoc(staleBookRef), getDoc(staleSessionRef)]);
  await disableNetwork(staleDb);

  const winnerDb = environment.authenticatedContext(uid).firestore();
  await assertSucceeds(queueReadingSessionUpdate({
    firestore: readingSessionWriteStore(winnerDb),
    userId: uid,
    bookId,
    sessionId: 'session',
    previous: { fromPage: 10, toPage: 20, pagesRead: 10, timeRead: 30 },
    book: { currentPage: 20, currentPageUpdateId: 'session', pageCount: 100 },
    next: { fromPage: 10, toPage: 25, timeRead: 45 },
  }));

  const staleCompletion = queueReadingSessionUpdate({
    firestore: readingSessionWriteStore(staleDb),
    userId: uid,
    bookId,
    sessionId: 'session',
    previous: { fromPage: 10, toPage: 20, pagesRead: 10, timeRead: 30 },
    book: { currentPage: 20, currentPageUpdateId: 'session', pageCount: 100 },
    next: { fromPage: 10, toPage: 30, timeRead: 60 },
  });
  const optimistic = await getDocFromCache(staleBookRef);
  assert.equal(optimistic.metadata.hasPendingWrites, true);
  assert.equal(optimistic.data()?.currentPage, 30);
  assert.equal(optimistic.data()?.pagesRead, 30);

  await enableNetwork(staleDb);
  await assert.rejects(staleCompletion);
  const [rolledBackBook, rolledBackSession] = await Promise.all([
    getDoc(staleBookRef),
    getDoc(staleSessionRef),
  ]);
  assert.equal(rolledBackBook.metadata.hasPendingWrites, false);
  assert.equal(rolledBackBook.data()?.currentPage, 25);
  assert.equal(rolledBackBook.data()?.currentPageUpdateId, 'session');
  assert.equal(rolledBackBook.data()?.pagesRead, 25);
  assert.equal(rolledBackBook.data()?.timeRead, 75);
  assert.equal(rolledBackSession.data()?.toPage, 25);
  assert.equal(rolledBackSession.data()?.timeRead, 45);
});

const queueItem = (overrides = {}) => ({
  type: 'create',
  bookTitle: 'The Book',
  start: '2026-08-24T12:00:00.000Z',
  stop: '2026-08-24T12:20:00.000Z',
  status: 'pending',
  createdAt: serverTimestamp(),
  ...overrides,
});

const idleLifecycle = (cleared: unknown = null) => ({version: 1, state: 'idle', cleared});
const localLifecycle = (bookId: string, start: string, operationId: string) => ({
  version: 1, state: 'local', bookId, start, operationId,
});
const remoteLifecycle = (bookId: string, start: string, entryId: number) => ({
  version: 1, state: 'remote', bookId, start, entryId,
});
const stoppingLifecycle = (
  bookId: string, start: string, entryId: number, queueId: string,
) => ({version: 1, state: 'stopping', bookId, start, entryId, queueId});

const seedToggl = async (
  uid: string,
  quota?: { windowStartedAt: Timestamp; count: number },
) => environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
  const db = context.firestore();
  await setDoc(doc(db, 'users', uid), {
    uid,
    email: `${uid}@example.test`,
    toggl: { workspaceId: 1, projectId: 2, connectedAt: Timestamp.now() },
  });
  if (quota !== undefined) {
    await setDoc(doc(db, 'users', uid, 'functionQuotas', 'togglQueue'), quota);
  }
});

const issue = (uid: string | null, event: string) => ({
  level: 'error',
  event,
  message: 'Stored data failed runtime validation',
  code: 'TypeError',
  uid,
  detail: null,
  createdAt: serverTimestamp(),
  expiresAt: Timestamp.fromMillis(Date.now() + 90 * 24 * 60 * 60 * 1000),
});

test('logEvents has no client path at all: telemetry goes through the callable', async () => {
  // A row the Admin SDK wrote, so update/delete/get have something to hit.
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(
      doc(context.firestore(), 'logEvents', 'seeded'),
      issue('issue-owner', 'firestore.decode_failed'),
    );
  });

  for (const [label, db] of [
    ['owner', environment.authenticatedContext('issue-owner').firestore()],
    ['stranger', environment.authenticatedContext('issue-stranger').firestore()],
    ['anonymous', environment.unauthenticatedContext().firestore()],
  ] as const) {
    // The exact rows the old rules accepted from signed-in and signed-out clients.
    await assertFails(setDoc(doc(db, 'logEvents', `${label}-create`), issue('issue-owner', 'firestore.decode_failed')));
    await assertFails(setDoc(doc(db, 'logEvents', `${label}-anon`), issue(null, 'auth.sign_in_failed')));
    await assertFails(setDoc(doc(db, 'logEvents', `${label}-anon-up`), issue(null, 'auth.sign_up_failed')));
    await assertFails(getDoc(doc(db, 'logEvents', 'seeded')));
    await assertFails(updateDoc(doc(db, 'logEvents', 'seeded'), { message: 'scrubbed' }));
    await assertFails(deleteDoc(doc(db, 'logEvents', 'seeded')));
    await assertFails(getDocs(collection(db, 'logEvents')));
    await assertFails(getDocs(query(collectionGroup(db, 'logEvents'))));
    // A logEvents subcollection under a path the client can write is not a
    // client path either, and neither is an updates subcollection under a row.
    await assertFails(setDoc(doc(db, 'users', 'issue-owner', 'logEvents', 'nested'), issue('issue-owner', 'firestore.decode_failed')));
    await assertFails(setDoc(doc(db, 'users', 'issue-owner', 'books', 'b1', 'logEvents', 'nested'), issue('issue-owner', 'firestore.decode_failed')));
    await assertFails(setDoc(doc(db, 'logEvents', 'seeded', 'updates', 'planted'), { owner: 'users/issue-owner' }));
  }
});

test('issue-report quota documents are inaccessible to their owner and to strangers', async () => {
  const uid = 'issue-quota-owner';
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(
      doc(context.firestore(), 'users', uid, 'functionQuotas', 'issueReports'),
      { windowStartedAt: Timestamp.now(), count: 20 },
    );
  });
  for (const db of [
    environment.authenticatedContext(uid).firestore(),
    environment.authenticatedContext('issue-quota-stranger').firestore(),
    environment.unauthenticatedContext().firestore(),
  ]) {
    const ref = doc(db, 'users', uid, 'functionQuotas', 'issueReports');
    await assertFails(getDoc(ref));
    await assertFails(setDoc(ref, { windowStartedAt: Timestamp.now(), count: 0 }));
    await assertFails(updateDoc(ref, { count: 0 }));
    await assertFails(deleteDoc(ref));
    // Pre-seeding junk would restart the counter at one on every call.
    await assertFails(setDoc(doc(db, 'users', uid, 'functionQuotas', 'issueReports-next'), { junk: true }));
    await assertFails(getDocs(collection(db, 'users', uid, 'functionQuotas')));
    await assertFails(getDocs(query(collectionGroup(db, 'functionQuotas'))));
  }
});

test('no bounded or filtered query reaches logEvents either', async () => {
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(
      doc(context.firestore(), 'logEvents', 'seeded'),
      issue('issue-owner', 'firestore.decode_failed'),
    );
  });
  for (const db of [
    environment.authenticatedContext('issue-owner').firestore(),
    environment.authenticatedContext('issue-stranger').firestore(),
    environment.unauthenticatedContext().firestore(),
  ]) {
    // An unfiltered list is the easiest thing to deny; a rule written for a
    // bounded or self-scoped page is the one that would actually ship.
    for (const source of [collection(db, 'logEvents'), collectionGroup(db, 'logEvents')]) {
      await assertFails(getDocs(query(source, limit(1))));
      await assertFails(getDocs(query(source, limit(10))));
      await assertFails(getDocs(query(source, where('uid', '==', 'issue-owner'))));
      await assertFails(getDocs(query(source, where('uid', '==', 'issue-owner'), limit(10))));
      await assertFails(getDocs(query(source, where('event', '==', 'firestore.decode_failed'), limit(10))));
      await assertFails(getDocs(query(source, orderBy('createdAt', 'desc'), limit(10))));
    }
  }
});

test('no issue-report quota write succeeds whatever the payload looks like', async () => {
  const uid = 'issue-quota-payload';
  const now = Timestamp.now();
  // consumeQuota restarts the window on an old or junk windowStartedAt, so a
  // grant conditioned on "count never decreases" would still be a full
  // bypass: the same count with an epoch timestamp resets the counter.
  const bodies: Record<string, unknown>[] = [
    { windowStartedAt: now, count: 0 },
    { windowStartedAt: now, count: 20 },
    { windowStartedAt: now, count: 21 },
    { windowStartedAt: Timestamp.fromMillis(0), count: 20 },
    { windowStartedAt: Timestamp.fromMillis(Date.now() + 864e5), count: 20 },
    { windowStartedAt: 'not-a-timestamp', count: 20 },
    { count: 20 },
  ];
  for (const body of bodies) {
    await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
      await setDoc(
        doc(context.firestore(), 'users', uid, 'functionQuotas', 'issueReports'),
        { windowStartedAt: now, count: 20 },
      );
    });
    for (const db of [
      environment.authenticatedContext(uid).firestore(),
      environment.authenticatedContext('issue-quota-stranger').firestore(),
      environment.unauthenticatedContext().firestore(),
    ]) {
      const ref = doc(db, 'users', uid, 'functionQuotas', 'issueReports');
      await assertFails(setDoc(ref, body));
      await assertFails(updateDoc(ref, body));
      await assertFails(setDoc(ref, body, { merge: true }));
    }
  }
});

test('no logEvents row is readable whatever its id, age or shape', async () => {
  // A grant written for one id, one age or one flag would pass a fixture
  // of a single fresh row; the whole collection has to be unreadable.
  const rows: [string, Record<string, unknown>][] = [
    ['seeded', issue('issue-owner', 'firestore.decode_failed')],
    ['other-row', issue('issue-victim', 'firestore.decode_failed')],
    ['aged-row', { ...issue('issue-victim', 'auth.sign_in_failed'), createdAt: Timestamp.fromMillis(Date.now() - 86_400_000) }],
    ['uidless-row', issue(null, 'auth.sign_in_failed')],
    ['flagged-row', { ...issue('issue-victim', 'firestore.decode_failed'), public: true, level: 'info' }],
  ];
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    for (const [id, body] of rows) await setDoc(doc(context.firestore(), 'logEvents', id), body);
  });
  for (const db of [
    environment.authenticatedContext('issue-owner').firestore(),
    environment.authenticatedContext('issue-victim').firestore(),
    environment.authenticatedContext('issue-stranger').firestore(),
    environment.unauthenticatedContext().firestore(),
  ]) {
    for (const [id] of rows) await assertFails(getDoc(doc(db, 'logEvents', id)));
    await assertFails(getDoc(doc(db, 'logEvents', 'no-such-row')));
  }
});

test('no issue-report quota write succeeds with a server timestamp either, seeded or not', async () => {
  const uid = 'issue-quota-clock';
  // serverTimestamp() is what a real client sends at a rule that requires
  // request.time; Timestamp.now() can never satisfy one, so the
  // client-clock bodies in the previous test cannot see such a grant.
  const bodies: Record<string, unknown>[] = [
    { windowStartedAt: serverTimestamp(), count: 0 },
    { windowStartedAt: serverTimestamp(), count: 1 },
    { windowStartedAt: serverTimestamp(), count: 20 },
    { windowStartedAt: serverTimestamp() },
    { count: 0, windowStartedAt: serverTimestamp(), extra: null },
  ];
  for (const body of bodies) {
    for (const preSeed of [true, false]) {
      await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
        const ref = doc(context.firestore(), 'users', uid, 'functionQuotas', 'issueReports');
        if (preSeed) await setDoc(ref, { windowStartedAt: Timestamp.now(), count: 20 });
        else await deleteDoc(ref);
      });
      for (const db of [
        environment.authenticatedContext(uid).firestore(),
        environment.authenticatedContext('issue-quota-stranger').firestore(),
        environment.unauthenticatedContext().firestore(),
      ]) {
        const ref = doc(db, 'users', uid, 'functionQuotas', 'issueReports');
        await assertFails(setDoc(ref, body));
        await assertFails(setDoc(ref, body, { merge: true }));
        if (preSeed) await assertFails(updateDoc(ref, body));
      }
    }
  }
});

test('no bounded or filtered query reaches functionQuotas either', async () => {
  const uid = 'issue-quota-list';
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', uid, 'functionQuotas', 'issueReports'), {
      windowStartedAt: Timestamp.now(),
      count: 20,
    });
  });
  for (const db of [
    environment.authenticatedContext(uid).firestore(),
    environment.authenticatedContext('issue-quota-stranger').firestore(),
    environment.unauthenticatedContext().firestore(),
  ]) {
    for (const source of [collection(db, 'users', uid, 'functionQuotas'), collectionGroup(db, 'functionQuotas')]) {
      await assertFails(getDocs(query(source, limit(1))));
      await assertFails(getDocs(query(source, limit(5))));
      await assertFails(getDocs(query(source, where('count', '>=', 0), limit(5))));
      await assertFails(getDocs(query(source, orderBy('count', 'desc'), limit(5))));
    }
  }
});

test('logEvents is not reachable under any writable parent path', async () => {
  const uid = 'issue-nest-owner';
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const db = context.firestore();
    await setDoc(doc(db, 'users', uid), { uid, email: `${uid}@example.test` });
    await setDoc(doc(db, 'users', uid, 'books', 'b1'), { title: 'The Book', owner: doc(db, 'users', uid) });
    await setDoc(doc(db, 'users', uid, 'togglQueue', 'q1'), { status: 'pending' });
    await setDoc(doc(db, 'users', uid, 'authors', 'a1'), { name: 'Ada' });
    await setDoc(doc(db, 'users', uid, 'timerLifecycle', 'current'), { version: 1, state: 'idle', cleared: null });
    await setDoc(doc(db, 'profiles', 'nest-profile'), { uid, public: true });
  });
  // Every parent a client can write, plus the two the earlier test covers.
  const parents: string[][] = [
    ['users', uid],
    ['users', uid, 'books', 'b1'],
    ['users', uid, 'books', 'b1', 'updates', 'u1'],
    ['users', uid, 'togglQueue', 'q1'],
    ['users', uid, 'authors', 'a1'],
    ['users', uid, 'timerLifecycle', 'current'],
    ['profiles', 'nest-profile'],
  ];
  for (const db of [
    environment.authenticatedContext(uid).firestore(),
    environment.authenticatedContext('issue-nest-stranger').firestore(),
    environment.unauthenticatedContext().firestore(),
  ]) {
    for (const parent of parents) {
      const [head, ...rest] = [...parent, 'logEvents', 'planted'];
      await assertFails(setDoc(doc(db, head, ...rest), issue(uid, 'firestore.decode_failed')));
    }
    await assertFails(getDocs(query(collectionGroup(db, 'logEvents'), limit(1))));
  }
});

test('the users document cannot be created, rewritten or nudged one field by any client', async () => {
  const uid = 'users-doc-shape';
  const body = { uid, email: `${uid}@example.test`, toggl: { workspaceId: 1, projectId: 2, connectedAt: Timestamp.now() } };
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', uid), body);
  });
  for (const db of [
    environment.authenticatedContext(uid).firestore(),
    environment.authenticatedContext('users-doc-shape-stranger').firestore(),
    environment.unauthenticatedContext().firestore(),
  ]) {
    const ref = doc(db, 'users', uid);
    // An identical rewrite changes no key at all, so it satisfies every
    // affectedKeys().hasOnly([...]) grant that could be written here.
    await assertFails(setDoc(ref, body));
    await assertFails(setDoc(ref, body, { merge: true }));
    for (const key of ['uid', 'email', 'toggl', 'createdAt', 'displayName']) {
      await assertFails(updateDoc(ref, { [key]: 'forged' }));
    }
    await assertFails(updateDoc(ref, { forged: true }));
    await assertFails(deleteDoc(ref));
    await assertFails(getDocs(collection(db, 'users')));
    // Nothing may open an account document either, not even its own owner.
    await assertFails(setDoc(doc(db, 'users', 'users-doc-absent'), body));
    // Rules do not cascade: the parent's read grant reaches no subcollection write.
    await assertFails(setDoc(doc(db, 'users', uid, 'logEvents', 'nested'), issue(uid, 'firestore.decode_failed')));
    await assertFails(setDoc(doc(db, 'users', uid, 'functionQuotas', 'issueReports'), { windowStartedAt: Timestamp.now(), count: 0 }));
  }
  const absent = environment.authenticatedContext('users-doc-absent').firestore();
  await assertFails(setDoc(doc(absent, 'users', 'users-doc-absent'), body));
});

const auditRow = (uid: string) => ({
  type: 'view',
  uid,
  email: `${uid}@example.test`,
  at: serverTimestamp(),
  expiresAt: Timestamp.fromMillis(Date.now() + 365 * 24 * 60 * 60 * 1000),
});

test('adminAudit has no client path at all, whatever the actor, id or shape', async () => {
  const operator = '1Cf0CaNfgnVSvTrF5dYjzRd9Xri2';
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const db = context.firestore();
    await setDoc(doc(db, 'adminAudit', 'seeded'), auditRow(operator));
    await setDoc(doc(db, 'adminAudit', 'other-row'), auditRow('audit-victim'));
    await setDoc(doc(db, 'users', 'audit-owner'), { uid: 'audit-owner' });
    await setDoc(doc(db, 'users', 'audit-owner', 'books', 'b1'), { title: 'The Book' });
  });
  for (const db of [
    // The operator's own browser is a client too, and it is the one actor
    // a well-meaning "let the admin page read its audit trail" grant names.
    environment.authenticatedContext(operator, { email_verified: true }).firestore(),
    environment.authenticatedContext('audit-owner').firestore(),
    environment.authenticatedContext('audit-victim').firestore(),
    environment.unauthenticatedContext().firestore(),
  ]) {
    for (const id of ['seeded', 'other-row', 'no-such-row']) {
      await assertFails(getDoc(doc(db, 'adminAudit', id)));
    }
    await assertFails(setDoc(doc(db, 'adminAudit', 'forged'), auditRow('audit-owner')));
    await assertFails(updateDoc(doc(db, 'adminAudit', 'seeded'), { type: 'scrubbed' }));
    await assertFails(deleteDoc(doc(db, 'adminAudit', 'seeded')));
    await assertFails(getDocs(collection(db, 'adminAudit')));
    await assertFails(getDocs(query(collection(db, 'adminAudit'), limit(1))));
    await assertFails(getDocs(query(collection(db, 'adminAudit'), where('uid', '==', 'audit-owner'), limit(1))));
    await assertFails(getDocs(query(collection(db, 'adminAudit'), orderBy('at', 'desc'), limit(1))));
    await assertFails(getDocs(query(collectionGroup(db, 'adminAudit'), limit(1))));
    await assertFails(setDoc(doc(db, 'users', 'audit-owner', 'adminAudit', 'planted'), auditRow('audit-owner')));
    await assertFails(setDoc(doc(db, 'users', 'audit-owner', 'books', 'b1', 'adminAudit', 'planted'), auditRow('audit-owner')));
  }
});

test('no token claim opens logEvents or the quota document', async () => {
  const uid = 'claims-owner';
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const db = context.firestore();
    await setDoc(doc(db, 'logEvents', 'seeded'), issue(uid, 'firestore.decode_failed'));
    await setDoc(doc(db, 'logEvents', 'other-row'), issue('claims-victim', 'firestore.decode_failed'));
    await setDoc(doc(db, 'users', uid, 'functionQuotas', 'issueReports'), {
      windowStartedAt: Timestamp.now(),
      count: 20,
    });
  });
  // authenticatedContext(uid) mints a token with no email, no
  // email_verified and no provider, so every other probe in this file runs
  // as an actor that cannot satisfy a claim-conditioned grant.
  const claimSets: Record<string, unknown>[] = [
    { email_verified: true, email: `${uid}@example.test` },
    { email_verified: false, email: `${uid}@example.test` },
    { email: `${uid}@example.test`, firebase: { sign_in_provider: 'password' } },
    { admin: true },
    { email_verified: true, admin: true, email: `${uid}@example.test` },
  ];
  for (const claims of claimSets) {
    const db = environment.authenticatedContext(uid, claims).firestore();
    for (const id of ['seeded', 'other-row']) await assertFails(getDoc(doc(db, 'logEvents', id)));
    await assertFails(setDoc(doc(db, 'logEvents', 'claims-create'), issue(uid, 'firestore.decode_failed')));
    await assertFails(getDocs(query(collection(db, 'logEvents'), limit(1))));
    await assertFails(getDocs(query(collectionGroup(db, 'logEvents'), limit(1))));
    const quotaRef = doc(db, 'users', uid, 'functionQuotas', 'issueReports');
    await assertFails(getDoc(quotaRef));
    await assertFails(setDoc(quotaRef, { windowStartedAt: serverTimestamp(), count: 0 }));
    await assertFails(updateDoc(quotaRef, { count: 0 }));
    await assertFails(getDocs(query(collection(db, 'users', uid, 'functionQuotas'), limit(1))));
  }
});

// Seeds a running local timer and returns the one batch a client may use to
// enqueue: clear that exact timer and write the deterministic queue row in
// the same commit. `overrides` shape the queue row; the batch is built by an
// arbitrary caller so forged rows from a stranger can be tried too.
const localStopBatch = async (
  uid: string,
  sequence: number,
  overrides: Record<string, unknown> = {},
  writer: ReturnType<RulesTestContext['firestore']> = environment.authenticatedContext(uid).firestore(),
) => {
  const start = `2026-08-24T14:${String(sequence % 60).padStart(2, '0')}:${String(Math.floor(sequence / 60)).padStart(2, '0')}.000Z`;
  const operationId = `op-${sequence}`;
  const claim = localLifecycle('book', start, operationId);
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', uid, 'books', 'book'), {
      title: 'Book', activeTimer: {start, operationId},
    });
    await setDoc(doc(context.firestore(), 'users', uid, 'timerLifecycle', 'current'), claim);
  });
  const batch = writeBatch(writer);
  batch.update(doc(writer, 'users', uid, 'books', 'book'), {activeTimer: null});
  batch.set(doc(writer, 'users', uid, 'timerLifecycle', 'current'), idleLifecycle(claim));
  batch.set(doc(writer, 'users', uid, 'togglQueue', togglQueueId('book', start)), queueItem({
    bookId: 'book', bookTitle: 'Book', start, timerClaimVersion: 1, ...overrides,
  }));
  return {commit: () => batch.commit(), queueId: togglQueueId('book', start)};
};

test('owners can create only the atomic offline-stop row and read their own queue', async () => {
  const uid = 'queue-owner';
  await seedToggl(uid);
  const owner = environment.authenticatedContext(uid).firestore();
  const valid = await localStopBatch(uid, 1);
  await assertSucceeds(valid.commit());
  await assertSucceeds(getDoc(doc(owner, 'users', uid, 'togglQueue', valid.queueId)));
  // Uncoupled rows are gone (SEC-002): the bare create and stop payloads the
  // old client wrote are refused even from a configured owner.
  await assertFails(setDoc(doc(owner, 'users', uid, 'togglQueue', 'create'), queueItem()));
  await assertFails(setDoc(doc(owner, 'users', uid, 'togglQueue', 'stop'), queueItem({type: 'stop', entryId: 42})));

  const stranger = environment.authenticatedContext('queue-stranger').firestore();
  await assertFails(getDoc(doc(stranger, 'users', uid, 'togglQueue', valid.queueId)));
  await assertFails(setDoc(
    doc(stranger, 'users', uid, 'togglQueue', 'forged'),
    queueItem({bookId: 'book', timerClaimVersion: 1}),
  ));
  const forgedBatch = await localStopBatch(uid, 2, {}, stranger);
  await assertFails(forgedBatch.commit());
});

// SEC-004: the queue gate reads the status-only mirror the server writes
// ({workspaceId, projectId, connectedAt}); the credential itself lives in
// the secrets database, out of this engine's reach. A users document
// still carrying the pre-migration token shape must refuse the same
// batch the test above accepts — the gate must not treat a stale
// client-readable credential as a connection.
test('the queue gate needs the status-only Toggl mirror, not the legacy token shape', async () => {
  const uid = 'queue-legacy-shape';
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', uid), {
      uid,
      email: `${uid}@example.test`,
      toggl: { apiToken: 'server-validated', workspaceId: 1, projectId: 2 },
    });
  });
  const legacy = await localStopBatch(uid, 1);
  await assertFails(legacy.commit());
  // The same account flips to refused->accepted on exactly the mirror
  // shape: the positive control for the gate change.
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', uid), {
      uid,
      email: `${uid}@example.test`,
      toggl: { workspaceId: 1, projectId: 2, connectedAt: Timestamp.now() },
    });
  });
  const migrated = await localStopBatch(uid, 2);
  await assertSucceeds(migrated.commit());
});

test('atomic queue rows reject malformed payloads and lifecycle fields', async () => {
  const uid = 'queue-shape';
  await seedToggl(uid);
  const cases: Record<string, unknown>[] = [
    {type: 'other'},
    {bookId: 'books/123'},
    {bookId: '.'},
    {bookId: 'other'},
    {bookTitle: ''},
    {start: 'August 24, 2026'},
    {stop: '2026-08-24'},
    {type: 'create', entryId: 42},
    {type: 'stop'},
    {type: 'stop', entryId: '42'},
    {status: 'processing'},
    {attempts: 0},
    {claimedAt: serverTimestamp()},
    {retryRequestedAt: serverTimestamp()},
    {expiresAt: serverTimestamp()},
    {deferredUntil: serverTimestamp()},
    {deferredUntil: Timestamp.fromMillis(Date.now() - 1000)},
    {deferrals: 0},
    {unexpected: true},
    {createdAt: 'today'},
    {timerClaimVersion: 2},
    // createdAt may not run more than the skew allowance ahead of the server.
    {createdAt: Timestamp.fromMillis(Date.now() + 6 * 60 * 1000)},
    {createdAt: Timestamp.fromMillis(Date.now() + 365 * 24 * 60 * 60 * 1000)},
  ];
  for (const [index, overrides] of cases.entries()) {
    await assertFails((await localStopBatch(uid, index + 1, overrides)).commit());
  }
  // The legacy shape — the coupled row without its version marker — is
  // refused too: the marker is what selects the atomic path.
  const legacy = await localStopBatch(uid, 400);
  const db = environment.authenticatedContext(uid).firestore();
  const legacyStart = legacy.queueId.slice('book_'.length);
  const legacyBatch = writeBatch(db);
  legacyBatch.update(doc(db, 'users', uid, 'books', 'book'), {activeTimer: null});
  legacyBatch.set(
    doc(db, 'users', uid, 'timerLifecycle', 'current'),
    idleLifecycle(localLifecycle('book', legacyStart, 'op-400')),
  );
  legacyBatch.set(doc(db, 'users', uid, 'togglQueue', legacy.queueId), queueItem({
    bookId: 'book', bookTitle: 'Book', start: legacyStart,
  }));
  await assertFails(legacyBatch.commit());
  // Control: the same harness admits the well-formed row, including one
  // stamped by a device clock a few minutes fast and one hours old.
  await assertSucceeds((await localStopBatch(uid, 500)).commit());
  await assertSucceeds((await localStopBatch(uid, 501, {
    createdAt: Timestamp.fromMillis(Date.now() + 4 * 60 * 1000),
  })).commit());
  await assertSucceeds((await localStopBatch(uid, 502, {
    createdAt: Timestamp.fromMillis(Date.now() - 6 * 60 * 60 * 1000),
  })).commit());
});

test('owners can retry only stale or failed queue states below the cap', async () => {
  const now = Date.now();
  const oldClaim = Timestamp.fromMillis(now - 7 * 60 * 60 * 1000);
  const freshClaim = Timestamp.fromMillis(now - 60 * 1000);
  const oldCreate = Timestamp.fromMillis(now - 20 * 60 * 1000);
  const staleRetryRequest = Timestamp.fromMillis(now - 11 * 60 * 1000);
  const freshRetryRequest = Timestamp.fromMillis(now - 60 * 1000);
  const expiresAt = Timestamp.fromMillis(now + 90 * 24 * 60 * 60 * 1000);
  const docs = {
    error: queueItem({
      status: 'error',
      createdAt: oldCreate,
      attempts: 1,
      claimedAt: oldClaim,
      expiresAt,
      error: 'network failed',
    }),
    staleProcessing: queueItem({
      status: 'processing',
      createdAt: oldCreate,
      attempts: 1,
      claimedAt: oldClaim,
    }),
    freshProcessing: queueItem({
      status: 'processing',
      createdAt: oldCreate,
      attempts: 1,
      claimedAt: freshClaim,
    }),
    stalePending: queueItem({createdAt: oldCreate}),
    staleRetryMarker: queueItem({
      createdAt: oldCreate,
      retryRequestedAt: staleRetryRequest,
    }),
    freshRetryMarker: queueItem({
      createdAt: oldCreate,
      retryRequestedAt: freshRetryRequest,
    }),
    cappedError: queueItem({
      status: 'error',
      createdAt: oldCreate,
      attempts: 5,
      claimedAt: oldClaim,
      error: 'still failing',
    }),
    synced: queueItem({
      status: 'synced',
      createdAt: oldCreate,
      attempts: 1,
      claimedAt: oldClaim,
      entryId: 42,
    }),
    outcomeUnknown: queueItem({
      status: 'outcome-unknown',
      createdAt: oldCreate,
      attempts: 1,
      claimedAt: oldClaim,
      error: 'check Toggl before retrying',
    }),
  };
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', 'queue-retry'), {
      uid: 'queue-retry',
      email: 'queue-retry@example.test',
      toggl: { workspaceId: 1, projectId: 2, connectedAt: Timestamp.now() },
    });
    for (const [id, item] of Object.entries(docs)) {
      await setDoc(
        doc(context.firestore(), 'users', 'queue-retry', 'togglQueue', id),
        item,
      );
    }
  });

  const db = environment.authenticatedContext('queue-retry').firestore();
  const ref = (id: string) => doc(db, 'users', 'queue-retry', 'togglQueue', id);
  const retry = () => ({status: 'pending', retryRequestedAt: serverTimestamp()});
  await assertSucceeds(updateDoc(ref('error'), retry()));
  await assertSucceeds(updateDoc(ref('staleProcessing'), retry()));
  await assertSucceeds(updateDoc(ref('stalePending'), retry()));
  await assertSucceeds(updateDoc(ref('staleRetryMarker'), retry()));
  await assertFails(updateDoc(ref('freshRetryMarker'), retry()));
  await assertFails(updateDoc(ref('freshProcessing'), retry()));
  await assertFails(updateDoc(ref('cappedError'), retry()));
  await assertFails(updateDoc(ref('synced'), retry()));
  await assertFails(updateDoc(ref('outcomeUnknown'), retry()));
  await assertFails(updateDoc(ref('error'), {
    status: 'pending',
    retryRequestedAt: oldClaim,
  }));
});

test('an owner can request a valid queue retry while the server quota is full', async () => {
  const uid = 'queue-retry-full-quota';
  const oldClaim = Timestamp.fromMillis(Date.now() - 7 * 60 * 60 * 1000);
  await seedToggl(uid, {windowStartedAt: Timestamp.now(), count: 10});
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(
      doc(context.firestore(), 'users', uid, 'togglQueue', 'failed-stop'),
      queueItem({
        status: 'error',
        createdAt: oldClaim,
        attempts: 1,
        claimedAt: oldClaim,
        error: 'confirmed failure',
      }),
    );
  });

  const db = environment.authenticatedContext(uid).firestore();
  await assertSucceeds(updateDoc(
    doc(db, 'users', uid, 'togglQueue', 'failed-stop'),
    {status: 'pending', retryRequestedAt: serverTimestamp()},
  ));
  await assertFails(updateDoc(
    doc(db, 'users', uid, 'togglQueue', 'failed-stop'),
    {status: 'pending', retryRequestedAt: serverTimestamp()},
  ));
});

test('queue retries cannot change payload or server lifecycle fields', async () => {
  const oldClaim = Timestamp.fromMillis(Date.now() - 7 * 60 * 60 * 1000);
  const expiresAt = Timestamp.fromMillis(Date.now() + 90 * 24 * 60 * 60 * 1000);
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', 'queue-immutable'), {
      uid: 'queue-immutable',
      email: 'queue-immutable@example.test',
      toggl: { workspaceId: 1, projectId: 2, connectedAt: Timestamp.now() },
    });
    await setDoc(
      doc(context.firestore(), 'users', 'queue-immutable', 'togglQueue', 'error'),
      queueItem({
        bookId: 'book',
        status: 'error',
        createdAt: oldClaim,
        attempts: 1,
        claimedAt: oldClaim,
        expiresAt,
        error: 'x'.repeat(2_000),
      }),
    );
    await setDoc(
      doc(context.firestore(), 'users', 'queue-immutable', 'togglQueue', 'legacy-pending'),
      queueItem({
        status: 'pending',
        createdAt: oldClaim,
        attempts: 1,
        claimedAt: oldClaim,
        error: 'legacy failure',
      }),
    );
  });
  const db = environment.authenticatedContext('queue-immutable').firestore();
  const ref = doc(db, 'users', 'queue-immutable', 'togglQueue', 'error');
  await assertFails(updateDoc(ref, {
    status: 'pending',
    retryRequestedAt: serverTimestamp(),
    attempts: 0,
  }));
  await assertFails(updateDoc(ref, {
    status: 'pending',
    retryRequestedAt: serverTimestamp(),
    bookTitle: 'Other',
  }));
  await assertFails(updateDoc(ref, {
    status: 'pending',
    retryRequestedAt: serverTimestamp(),
    error: 'changed',
  }));
  await assertFails(updateDoc(ref, {
    status: 'pending',
    retryRequestedAt: serverTimestamp(),
    error: deleteField(),
  }));
  await assertFails(updateDoc(ref, {
    status: 'pending',
    retryRequestedAt: serverTimestamp(),
    bookId: deleteField(),
  }));
  await assertFails(updateDoc(ref, {
    status: 'synced',
    retryRequestedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(ref, {status: 'pending'}));
  await assertFails(updateDoc(ref, {
    status: 'pending',
    retryRequestedAt: serverTimestamp(),
    expiresAt: Timestamp.fromMillis(expiresAt.toMillis() + 1),
  }));
  await assertSucceeds(updateDoc(ref, {
    status: 'pending',
    retryRequestedAt: serverTimestamp(),
  }));
  const repaired = (await getDoc(ref)).data();
  assert.equal(repaired?.error, 'x'.repeat(2_000));
  assert.equal(repaired?.attempts, 1);
  assert.ok(repaired?.retryRequestedAt instanceof Timestamp);
  const legacyPendingRef = doc(
    db, 'users', 'queue-immutable', 'togglQueue', 'legacy-pending',
  );
  await assertSucceeds(updateDoc(legacyPendingRef, {
    status: 'pending',
    retryRequestedAt: serverTimestamp(),
  }));
  const legacyPending = (await getDoc(legacyPendingRef)).data();
  assert.equal(legacyPending?.attempts, 1);
  assert.equal(legacyPending?.error, 'legacy failure');
  assert.ok(legacyPending?.retryRequestedAt instanceof Timestamp);
});

test('no ordinary Toggl queue create exists any more, whatever the quotas say', async () => {
  // SEC-002: a queue row that is not the atomic offline-stop row coupled to
  // a real timer clear can no longer be minted, even by a configured owner
  // with open quotas. Legacy clients without bookId lose the path too.
  const uid = 'queue-quota';
  const db = environment.authenticatedContext(uid).firestore();
  const queue = collection(db, 'users', uid, 'togglQueue');
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', uid), {
      uid,
      email: `${uid}@example.test`,
    });
  });
  await assertFails(setDoc(doc(queue, 'unconfigured'), queueItem()));

  await seedToggl(uid);
  await assertFails(setDoc(doc(queue, 'plain'), queueItem()));
  await assertFails(setDoc(doc(queue, 'book_2026-08-24T12:00:00.000Z'), queueItem({
    bookId: 'book',
  })));
  await assertFails(setDoc(doc(queue, 'stop'), queueItem({type: 'stop', entryId: 42})));
  await assertFails(setDoc(doc(queue, 'claims-v1'), queueItem({
    bookId: 'book', timerClaimVersion: 1,
  })));

  await seedToggl(uid, {
    windowStartedAt: Timestamp.fromMillis(Date.now() - 2 * 60 * 60 * 1000),
    count: 0,
  });
  await assertFails(setDoc(doc(queue, 'expired-window'), queueItem()));
  await assertFails(setDoc(doc(queue, 'expired-window-v1'), queueItem({
    bookId: 'book', timerClaimVersion: 1,
  })));
});

test('the row bound closes the atomic offline stop once the server counter is full', async () => {
  // SEC-002: the trigger counts each row in functionQuotas/togglQueueRows;
  // once the window holds sixty, no further atomic stop row can be created
  // until the window ends. The timer stays running (the batch is refused as
  // a whole), so no interval is lost. A malformed counter fails closed: only
  // the Admin SDK can write it, so that is a server bug, not a lockout path.
  const uid = 'atomic-row-bound';
  const db = environment.authenticatedContext(uid).firestore();
  const bookRef = doc(db, 'users', uid, 'books', 'book');
  const lifecycleRef = doc(db, 'users', uid, 'timerLifecycle', 'current');
  const rowsRef = (context: RulesTestContext) =>
    doc(context.firestore(), 'users', uid, 'functionQuotas', 'togglQueueRows');
  await seedToggl(uid, {windowStartedAt: Timestamp.now(), count: 10});

  let sequence = 0;
  const attempt = async (rows: Record<string, unknown> | null) => {
    sequence += 1;
    const start = `2026-08-24T12:${String(sequence).padStart(2, '0')}:00.000Z`;
    const operationId = `op-${sequence}`;
    const claim = localLifecycle('book', start, operationId);
    await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
      await setDoc(doc(context.firestore(), 'users', uid, 'books', 'book'), {
        title: 'Book', activeTimer: {start, operationId},
      });
      await setDoc(doc(context.firestore(), 'users', uid, 'timerLifecycle', 'current'), claim);
      if (rows === null) await deleteDoc(rowsRef(context));
      else await setDoc(rowsRef(context), rows);
    });
    const batch = writeBatch(db);
    batch.update(bookRef, {activeTimer: null});
    batch.set(lifecycleRef, idleLifecycle(claim));
    batch.set(doc(db, 'users', uid, 'togglQueue', togglQueueId('book', start)), queueItem({
      bookId: 'book', bookTitle: 'Book', start, timerClaimVersion: 1,
    }));
    return batch.commit();
  };
  const now = Timestamp.now();
  const expired = Timestamp.fromMillis(Date.now() - 60 * 60 * 1000 - 1000);
  const open = Timestamp.fromMillis(Date.now() - 60 * 60 * 1000 + 60 * 1000);
  await assertSucceeds(attempt(null));
  await assertSucceeds(attempt({windowStartedAt: now, count: 0}));
  await assertSucceeds(attempt({windowStartedAt: open, count: 59}));
  await assertFails(attempt({windowStartedAt: open, count: 60}));
  await assertFails(attempt({windowStartedAt: now, count: 61}));
  await assertFails(attempt({windowStartedAt: now, count: 1000}));
  await assertSucceeds(attempt({windowStartedAt: expired, count: 1000}));
  await assertFails(attempt({windowStartedAt: now, count: 'many'}));
  await assertFails(attempt({windowStartedAt: 'now', count: 0}));
  await assertFails(attempt({windowStartedAt: now, count: -1}));
  await assertFails(attempt({windowStartedAt: now, count: 0, extra: true}));
  await assertFails(attempt({count: 0}));
  // The refused batch left the timer in place: nothing rolled back or was lost.
  assert.deepEqual((await getDoc(bookRef)).data()?.activeTimer.operationId, `op-${sequence}`);
  // The remote-call quota is not consulted for the atomic row (it is full
  // above and the successes went through), only the row counter is.
});

test('a server-deferred queue row refuses a retry marker until its window ends', async () => {
  // SEC-002: the trigger stamps an over-quota pending row with the end of
  // the quota window; the client sweep may re-arm it only after that, so a
  // deferred row costs one delivery per window instead of one per ten
  // minutes. The stamp itself is server-owned: a retry cannot touch it.
  const uid = 'queue-deferred';
  const oldCreate = Timestamp.fromMillis(Date.now() - 20 * 60 * 1000);
  const future = Timestamp.fromMillis(Date.now() + 30 * 60 * 1000);
  const past = Timestamp.fromMillis(Date.now() - 60 * 1000);
  const expiresAt = Timestamp.fromMillis(Date.now() + 90 * 24 * 60 * 60 * 1000);
  await seedToggl(uid, {windowStartedAt: Timestamp.now(), count: 10});
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const queue = collection(context.firestore(), 'users', uid, 'togglQueue');
    await setDoc(doc(queue, 'deferred'), queueItem({createdAt: oldCreate, deferredUntil: future, expiresAt}));
    await setDoc(doc(queue, 'ended'), queueItem({createdAt: oldCreate, deferredUntil: past, expiresAt}));
    await setDoc(doc(queue, 'ended-retried'), queueItem({
      createdAt: oldCreate, deferredUntil: past, expiresAt, deferrals: 3,
      attempts: 2, claimedAt: oldCreate, error: 'earlier failure',
    }));
    await setDoc(doc(queue, 'capped'), queueItem({
      createdAt: oldCreate, expiresAt, deferrals: 25,
      status: 'error', attempts: 5, claimedAt: oldCreate,
      error: 'Toggl queue limit reached in 24 consecutive hours.',
    }));
    await setDoc(doc(queue, 'stamp-corrupt'), queueItem({createdAt: oldCreate, deferredUntil: 'soon'}));
    // The trigger never stamps a non-pending row; the gate covers every
    // branch anyway rather than trust that.
    await setDoc(doc(queue, 'deferred-error'), queueItem({
      createdAt: oldCreate, deferredUntil: future, expiresAt,
      status: 'error', attempts: 1, claimedAt: oldCreate, error: 'earlier failure',
    }));
    await setDoc(doc(queue, 'deferred-processing'), queueItem({
      createdAt: oldCreate, deferredUntil: future,
      status: 'processing', attempts: 1,
      claimedAt: Timestamp.fromMillis(Date.now() - 7 * 60 * 60 * 1000),
    }));
  });

  const db = environment.authenticatedContext(uid).firestore();
  const ref = (id: string) => doc(db, 'users', uid, 'togglQueue', id);
  const retry = () => ({status: 'pending', retryRequestedAt: serverTimestamp()});
  await assertFails(updateDoc(ref('deferred'), retry()));
  await assertFails(updateDoc(ref('stamp-corrupt'), retry()));
  await assertFails(updateDoc(ref('deferred-error'), retry()));
  await assertFails(updateDoc(ref('deferred-processing'), retry()));
  await assertFails(updateDoc(ref('ended'), {...retry(), deferredUntil: deleteField()}));
  await assertFails(updateDoc(ref('ended'), {...retry(), deferredUntil: future}));
  await assertFails(updateDoc(ref('ended-retried'), {...retry(), deferrals: 0}));
  await assertFails(updateDoc(ref('ended-retried'), {...retry(), deferrals: deleteField()}));
  // The server's deferral cap is terminal: attempts 5 refuses every re-arm.
  await assertFails(updateDoc(ref('capped'), retry()));
  await assertSucceeds(updateDoc(ref('ended'), retry()));
  await assertSucceeds(updateDoc(ref('ended-retried'), retry()));
  assert.equal((await getDoc(ref('ended'))).data()?.deferredUntil.toMillis(), past.toMillis());
  assert.equal((await getDoc(ref('ended-retried'))).data()?.deferrals, 3);
});

test('local timer books and lifecycle claims must change in one exact batch', async () => {
  const uid = 'timer-owner';
  const db = environment.authenticatedContext(uid).firestore();
  const bookRef = doc(db, 'users', uid, 'books', 'book');
  const lifecycleRef = doc(db, 'users', uid, 'timerLifecycle', 'current');
  const start = '2026-08-24T12:00:00.000Z';
  const first = {start, operationId: 'first-operation'};
  const firstClaim = localLifecycle('book', start, first.operationId);
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', uid, 'books', 'book'), creatableBook());
    await setDoc(doc(context.firestore(), 'users', uid, 'timerLifecycle', 'current'), idleLifecycle());
  });

  await assertFails(updateDoc(bookRef, {activeTimer: first}));
  await assertFails(updateDoc(lifecycleRef, firstClaim));
  const startBatch = writeBatch(db);
  startBatch.update(bookRef, {activeTimer: first});
  startBatch.set(lifecycleRef, firstClaim);
  await assertSucceeds(startBatch.commit());

  const forged = writeBatch(db);
  forged.update(bookRef, {activeTimer: {entryId: 42, start}});
  forged.set(lifecycleRef, remoteLifecycle('book', start, 42));
  await assertFails(forged.commit());

  const stopBatch = writeBatch(db);
  stopBatch.update(bookRef, {activeTimer: null});
  stopBatch.set(lifecycleRef, idleLifecycle(firstClaim));
  await assertSucceeds(stopBatch.commit());

  const second = {start, operationId: 'second-operation'};
  const secondClaim = localLifecycle('book', start, second.operationId);
  const restart = writeBatch(db);
  restart.update(bookRef, {activeTimer: second});
  restart.set(lifecycleRef, secondClaim);
  await assertSucceeds(restart.commit());

  const staleClear = writeBatch(db);
  staleClear.update(bookRef, {activeTimer: null});
  staleClear.set(lifecycleRef, idleLifecycle(firstClaim));
  await assertFails(staleClear.commit());
  assert.equal((await getDoc(bookRef)).data()?.activeTimer.operationId, second.operationId);
});

test('server-owned timer states cannot be forged and unknown clear is exactly correlated', async () => {
  const uid = 'timer-server-state';
  const db = environment.authenticatedContext(uid).firestore();
  const bookRef = doc(db, 'users', uid, 'books', 'book');
  const lifecycleRef = doc(db, 'users', uid, 'timerLifecycle', 'current');
  const start = '2026-08-24T12:00:00.000Z';
  const claimedAt = Timestamp.now();
  const timer = {
    state: 'outcome-unknown', operationId: 'server-operation', start,
    claimedAt, error: 'Check Toggl first.',
  };
  const claim = {version: 1, bookId: 'book', ...timer};
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', uid, 'books', 'book'), {
      ...creatableBook(), activeTimer: timer,
    });
    await setDoc(doc(context.firestore(), 'users', uid, 'timerLifecycle', 'current'), claim);
  });
  await assertSucceeds(updateDoc(bookRef, {title: 'Metadata still works'}));
  await assertFails(updateDoc(bookRef, {activeTimer: null}));
  await assertFails(updateDoc(lifecycleRef, idleLifecycle(claim)));
  const clear = writeBatch(db);
  clear.update(bookRef, {activeTimer: null});
  clear.set(lifecycleRef, idleLifecycle(claim));
  await assertSucceeds(clear.commit());
});

test('book deletion discards only an exactly claimed local timer', async () => {
  const uid = 'timer-delete';
  const db = environment.authenticatedContext(uid).firestore();
  const bookRef = doc(db, 'users', uid, 'books', 'book');
  const lifecycleRef = doc(db, 'users', uid, 'timerLifecycle', 'current');
  const timer = {start: '2026-08-24T12:00:00.000Z', operationId: 'delete-local'};
  const claim = localLifecycle('book', timer.start, timer.operationId);
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', uid, 'books', 'book'), {
      ...creatableBook(), activeTimer: timer,
    });
    await setDoc(doc(context.firestore(), 'users', uid, 'timerLifecycle', 'current'), claim);
  });
  await assertFails(deleteDoc(bookRef));
  const deletion = writeBatch(db);
  deletion.delete(bookRef);
  deletion.set(lifecycleRef, idleLifecycle(claim));
  await assertSucceeds(deletion.commit());
  assert.equal((await getDoc(bookRef)).exists(), false);
});

test('function quota documents are inaccessible to their owner', async () => {
  const uid = 'quota-owner';
  const db = environment.authenticatedContext(uid).firestore();
  for (const quotaName of ['booksApi', 'togglQueue', 'togglQueueRows', 'issueReports']) {
    const ref = doc(db, 'users', uid, 'functionQuotas', quotaName);
    await assertFails(getDoc(ref));
    await assertFails(setDoc(ref, {windowStartedAt: Timestamp.now(), count: 1}));
  }
});

test('author retirement rules prevent deletes, rewrites, and merge cycles', async () => {
  const uid = 'author-retirement';
  const db = environment.authenticatedContext(uid).firestore();
  const first = doc(db, 'users', uid, 'authors', 'first');
  const second = doc(db, 'users', uid, 'authors', 'second');
  const deleted = doc(db, 'users', uid, 'authors', 'deleted');
  const author = (name: string) => ({
    name,
    nameLower: name.toLowerCase(),
    kind: 'person',
    familyName: name,
  });
  await assertSucceeds(setDoc(first, author('First')));
  await assertSucceeds(setDoc(second, author('Second')));
  await assertSucceeds(setDoc(deleted, author('Deleted')));
  await assertSucceeds(updateDoc(deleted, {
    retirement: {reason: 'deleted'},
  }));
  await assertSucceeds(updateDoc(deleted, {
    ...author('Deleted'),
    retirement: deleteField(),
  }));
  await assertSucceeds(updateDoc(first, {
    retirement: {reason: 'merged', targetId: 'second'},
  }));
  await assertFails(updateDoc(second, {
    retirement: {reason: 'merged', targetId: 'first'},
  }));
  await assertFails(updateDoc(first, {
    retirement: {reason: 'deleted'},
  }));
  await assertFails(deleteDoc(first));
});

test('remote offline stop atomically creates one exact queue row and stopping lock', async () => {
  const uid = 'atomic-remote-stop';
  const db = environment.authenticatedContext(uid).firestore();
  const bookRef = doc(db, 'users', uid, 'books', 'book');
  const lifecycleRef = doc(db, 'users', uid, 'timerLifecycle', 'current');
  const start = '2026-08-24T12:00:00.000Z';
  const queueId = togglQueueId('book', start);
  const queueRef = doc(db, 'users', uid, 'togglQueue', queueId);
  const remote = remoteLifecycle('book', start, 42);
  const stopping = stoppingLifecycle('book', start, 42, queueId);
  const stoppingTimer = {state: 'stopping', entryId: 42, start, queueId};
  await seedToggl(uid, {windowStartedAt: Timestamp.now(), count: 0});
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', uid, 'books', 'book'), {
      title: 'Book', activeTimer: {entryId: 42, start},
    });
    await setDoc(doc(context.firestore(), 'users', uid, 'timerLifecycle', 'current'), remote);
  });

  const queue = queueItem({
    type: 'stop', bookId: 'book', bookTitle: 'Cached title', entryId: 42,
    start, timerClaimVersion: 1,
  });
  await assertFails(setDoc(queueRef, queue));
  const half = writeBatch(db);
  half.update(bookRef, {activeTimer: stoppingTimer});
  half.set(queueRef, queue);
  await assertFails(half.commit());

  const legacyQueue = queueItem({
    type: 'stop', bookId: 'book', bookTitle: 'Cached title', entryId: 42,
    start,
  });
  for (const [id, item] of [
    ['forged', queue],
    [queueId, {...queue, entryId: 99}],
    [queueId, {...queue, start: '2026-08-24T12:00:01.000Z'}],
    [queueId, legacyQueue],
  ] as const) {
    const forged = writeBatch(db);
    forged.update(bookRef, {activeTimer: {...stoppingTimer, queueId: id}});
    forged.set(lifecycleRef, {...stopping, queueId: id});
    forged.set(doc(db, 'users', uid, 'togglQueue', id), item);
    await assertFails(forged.commit());
  }

  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(
      doc(context.firestore(), 'users', uid, 'functionQuotas', 'togglQueue'),
      {windowStartedAt: Timestamp.now(), count: 10},
    );
  });

  const valid = writeBatch(db);
  valid.update(bookRef, {activeTimer: stoppingTimer});
  valid.set(lifecycleRef, stopping);
  valid.set(queueRef, queue);
  await assertSucceeds(valid.commit());
  assert.deepEqual((await getDoc(bookRef)).data()?.activeTimer, stoppingTimer);
  assert.deepEqual((await getDoc(lifecycleRef)).data(), stopping);
  assert.equal((await getDoc(queueRef)).data()?.bookTitle, 'Cached title');
});

test('local offline stop atomically clears its exact claim even at full quota', async () => {
  const uid = 'atomic-local-stop';
  const db = environment.authenticatedContext(uid).firestore();
  const bookRef = doc(db, 'users', uid, 'books', 'book');
  const lifecycleRef = doc(db, 'users', uid, 'timerLifecycle', 'current');
  const start = '2026-08-24T13:00:00.000Z';
  const operationId = 'local-operation';
  const claim = localLifecycle('book', start, operationId);
  const queueId = togglQueueId('book', start);
  const queueRef = doc(db, 'users', uid, 'togglQueue', queueId);
  await seedToggl(uid, {windowStartedAt: Timestamp.now(), count: 10});
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', uid, 'books', 'book'), {
      title: 'Book', activeTimer: {start, operationId},
    });
    await setDoc(doc(context.firestore(), 'users', uid, 'timerLifecycle', 'current'), claim);
  });
  const queue = queueItem({
    bookId: 'book', bookTitle: 'Book', start, timerClaimVersion: 1,
  });
  const wrong = writeBatch(db);
  wrong.update(bookRef, {activeTimer: null});
  wrong.set(lifecycleRef, idleLifecycle({...claim, operationId: 'wrong'}));
  wrong.set(queueRef, queue);
  await assertFails(wrong.commit());

  const valid = writeBatch(db);
  valid.update(bookRef, {activeTimer: null});
  valid.set(lifecycleRef, idleLifecycle(claim));
  valid.set(queueRef, queue);
  await assertSucceeds(valid.commit());
  assert.equal((await getDoc(bookRef)).data()?.activeTimer, null);
  assert.deepEqual((await getDoc(lifecycleRef)).data()?.cleared, claim);
  assert.equal((await getDoc(queueRef)).data()?.timerClaimVersion, 1);
});

test('timer mutation validation fails closed without blocking unmigrated metadata edits', async () => {
  const uid = 'unmigrated-timer';
  const db = environment.authenticatedContext(uid).firestore();
  const bookRef = doc(db, 'users', uid, 'books', 'book');
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', uid, 'books', 'book'), {
      title: 'Before', activeTimer: null,
    });
  });
  await assertSucceeds(updateDoc(bookRef, {title: 'After'}));
  await assertFails(updateDoc(bookRef, {
    activeTimer: {start: '2026-08-24T12:00:00.000Z', operationId: 'new'},
  }));
  assert.equal((await getDoc(bookRef)).data()?.title, 'After');
});

test('local timer client writes reject malformed and oversized identity fields', async () => {
  const uid = 'malformed-local-timer';
  const db = environment.authenticatedContext(uid).firestore();
  const bookRef = doc(db, 'users', uid, 'books', 'book');
  const lifecycleRef = doc(db, 'users', uid, 'timerLifecycle', 'current');
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', uid, 'books', 'book'), creatableBook());
    await setDoc(doc(context.firestore(), 'users', uid, 'timerLifecycle', 'current'), idleLifecycle());
  });
  for (const timer of [
    {start: 'not-a-time', operationId: 'operation'},
    {start: '2026-08-24T12:00:00.000Z', operationId: 'x'.repeat(101)},
    {start: `${'2'.repeat(65)}Z`, operationId: 'operation'},
  ]) {
    const batch = writeBatch(db);
    batch.update(bookRef, {activeTimer: timer});
    batch.set(lifecycleRef, localLifecycle('book', timer.start, timer.operationId));
    await assertFails(batch.commit());
  }
});

test('local timer start and stop remain optimistic while Firestore is offline', async () => {
  const uid = 'offline-local-timer';
  const db = environment.authenticatedContext(uid).firestore();
  const bookRef = doc(db, 'users', uid, 'books', 'book');
  const lifecycleRef = doc(db, 'users', uid, 'timerLifecycle', 'current');
  const start = '2026-08-24T14:00:00.000Z';
  const operationId = 'offline-operation';
  const claim = localLifecycle('book', start, operationId);
  await seedToggl(uid);
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', uid, 'books', 'book'), creatableBook());
    await setDoc(doc(context.firestore(), 'users', uid, 'timerLifecycle', 'current'), idleLifecycle());
  });
  await Promise.all([getDoc(bookRef), getDoc(lifecycleRef)]);
  await disableNetwork(db);

  const startBatch = writeBatch(db);
  startBatch.update(bookRef, {activeTimer: {start, operationId}});
  startBatch.set(lifecycleRef, claim);
  const started = startBatch.commit();
  assert.equal((await getDocFromCache(bookRef)).metadata.hasPendingWrites, true);
  assert.equal((await getDocFromCache(lifecycleRef)).data()?.state, 'local');
  await enableNetwork(db);
  await started;

  await disableNetwork(db);
  const queueId = togglQueueId('book', start);
  const stopBatch = writeBatch(db);
  stopBatch.update(bookRef, {activeTimer: null});
  stopBatch.set(lifecycleRef, idleLifecycle(claim));
  stopBatch.set(doc(db, 'users', uid, 'togglQueue', queueId), queueItem({
    bookId: 'book', bookTitle: 'Book', start, timerClaimVersion: 1,
  }));
  const stopped = stopBatch.commit();
  assert.equal((await getDocFromCache(bookRef)).data()?.activeTimer, null);
  assert.equal((await getDocFromCache(lifecycleRef)).data()?.state, 'idle');
  await enableNetwork(db);
  await stopped;
  assert.equal((await getDoc(bookRef)).data()?.activeTimer, null);
});

test('a stale offline timer clear rolls back after the same book restarts', async () => {
  const uid = 'stale-offline-timer-clear';
  const staleDb = environment.authenticatedContext(uid).firestore();
  const bookRef = doc(staleDb, 'users', uid, 'books', 'book');
  const lifecycleRef = doc(staleDb, 'users', uid, 'timerLifecycle', 'current');
  const start = '2026-08-24T15:00:00.000Z';
  const first = localLifecycle('book', start, 'first-operation');
  const second = localLifecycle('book', start, 'second-operation');
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', uid, 'books', 'book'), {
      ...creatableBook(), activeTimer: {start, operationId: first.operationId},
    });
    await setDoc(doc(context.firestore(), 'users', uid, 'timerLifecycle', 'current'), first);
  });
  await Promise.all([getDoc(bookRef), getDoc(lifecycleRef)]);
  await disableNetwork(staleDb);
  const stale = writeBatch(staleDb);
  stale.update(bookRef, {activeTimer: null});
  stale.set(lifecycleRef, idleLifecycle(first));
  const completion = stale.commit();
  assert.equal((await getDocFromCache(bookRef)).data()?.activeTimer, null);

  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await updateDoc(doc(context.firestore(), 'users', uid, 'books', 'book'), {
      activeTimer: {start, operationId: second.operationId},
    });
    await setDoc(doc(context.firestore(), 'users', uid, 'timerLifecycle', 'current'), second);
  });
  await enableNetwork(staleDb);
  await assert.rejects(completion);
  assert.equal((await getDoc(bookRef)).data()?.activeTimer.operationId, second.operationId);
  assert.equal((await getDoc(lifecycleRef)).data()?.operationId, second.operationId);
});

test('two offline local starts serialize on the user-wide lifecycle after reconnect', async () => {
  const uid = 'concurrent-offline-local-starts';
  const firstDb = environment.authenticatedContext(uid).firestore();
  const secondDb = environment.authenticatedContext(uid).firestore();
  const firstBook = doc(firstDb, 'users', uid, 'books', 'first');
  const secondBook = doc(secondDb, 'users', uid, 'books', 'second');
  const firstLifecycle = doc(firstDb, 'users', uid, 'timerLifecycle', 'current');
  const secondLifecycle = doc(secondDb, 'users', uid, 'timerLifecycle', 'current');
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const seed = context.firestore();
    await Promise.all([
      setDoc(doc(seed, 'users', uid, 'books', 'first'), creatableBook()),
      setDoc(doc(seed, 'users', uid, 'books', 'second'), creatableBook()),
      setDoc(doc(seed, 'users', uid, 'timerLifecycle', 'current'), idleLifecycle()),
    ]);
  });
  await Promise.all([
    getDoc(firstBook), getDoc(firstLifecycle),
    getDoc(secondBook), getDoc(secondLifecycle),
  ]);
  await Promise.all([disableNetwork(firstDb), disableNetwork(secondDb)]);
  const firstClaim = localLifecycle(
    'first', '2026-08-24T18:00:00.000Z', 'first-operation',
  );
  const secondClaim = localLifecycle(
    'second', '2026-08-24T18:00:00.000Z', 'second-operation',
  );
  const firstBatch = writeBatch(firstDb);
  firstBatch.update(firstBook, {
    activeTimer: {start: firstClaim.start, operationId: firstClaim.operationId},
  });
  firstBatch.set(firstLifecycle, firstClaim);
  const secondBatch = writeBatch(secondDb);
  secondBatch.update(secondBook, {
    activeTimer: {start: secondClaim.start, operationId: secondClaim.operationId},
  });
  secondBatch.set(secondLifecycle, secondClaim);
  const firstCompletion = firstBatch.commit();
  const secondCompletion = secondBatch.commit();
  assert.equal((await getDocFromCache(firstBook)).data()?.activeTimer.operationId, 'first-operation');
  assert.equal((await getDocFromCache(secondBook)).data()?.activeTimer.operationId, 'second-operation');

  await Promise.all([enableNetwork(firstDb), enableNetwork(secondDb)]);
  const results = await Promise.allSettled([firstCompletion, secondCompletion]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const seed = context.firestore();
    const [first, second, lifecycle] = await Promise.all([
      getDoc(doc(seed, 'users', uid, 'books', 'first')),
      getDoc(doc(seed, 'users', uid, 'books', 'second')),
      getDoc(doc(seed, 'users', uid, 'timerLifecycle', 'current')),
    ]);
    assert.equal(
      [first, second].filter((book) => book.data()?.activeTimer !== null).length,
      1,
    );
    assert.ok(['first', 'second'].includes(lifecycle.data()?.bookId));
  });
});
