import './setup.ts';

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { initializeApp } from 'firebase-admin/app'
import { getFirestore, Timestamp, type DocumentReference } from 'firebase-admin/firestore'
import {
  assertMigrationProjectionSourcesConsented,
  assertMigrationSourceVersions,
  deterministicCatalogId,
  deterministicTitleIndexId,
  OPERATOR_UID,
} from '../cross-user-work-migration.ts'

const app = initializeApp({ projectId: 'book-tracker-d8f24' }, 'catalog-migration-test')
const db = getFirestore(app)
const secretsDb = getFirestore(app, 'secrets')
const suffix = Date.now().toString(36)
const sharingUid = `0catalog-sharing-${suffix}`
const nonSharingUid = `catalog-nonsharing-${suffix}`
const username = `catalog-${suffix}`.slice(0, 30)
const secondUsername = `race-${suffix}`.slice(0, 30)
const migrationPath = fileURLToPath(new URL('../migrate-cross-user-works.ts', import.meta.url))
const auditPath = fileURLToPath(new URL('../db-audit.ts', import.meta.url))
const backfillPath = fileURLToPath(new URL('../migrate-book-editions.ts', import.meta.url))
const creatorsPath = fileURLToPath(new URL('../migrate-catalog-creators.ts', import.meta.url))
const languagesPath = fileURLToPath(new URL('../migrate-work-languages.ts', import.meta.url))
const groupKey = 'title:left hand of darkness\0authors:ursula k le guin'
const workId = deterministicCatalogId('work', groupKey)
const isbn = '9780441478125'
const editionId = deterministicCatalogId('edition', `${workId}\0${isbn}`)
const secondIsbn = '9780316769488'
const secondEditionId = deterministicCatalogId('edition', `${workId}\0${secondIsbn}`)
const lateIsbn = '9780140328721'
const lateEditionId = deterministicCatalogId('edition', `${workId}\0${lateIsbn}`)
const projectionId = createHash('sha256').update(`${workId}\0${sharingUid}`).digest('hex')
const staleProjectionId = createHash('sha256').update(`${workId}\0${nonSharingUid}`).digest('hex')
const conflictIsbn = '9781473217386'
const conflictWorkId = `work-existing-${suffix}`
const conflictEditionId = `edition-existing-${suffix}`
const conflictTitleKey = 'different book'
const cycleWorkA = `work-cycle-a-${suffix}`
const cycleWorkB = `work-cycle-b-${suffix}`
const corruptExternalIndexId = `bad-external-index-${suffix}`
const leGuinAuthorId = deterministicCatalogId('author', 'ursula k le guin')
const butlerAuthorId = deterministicCatalogId('author', 'octavia e butler')
const someoneElseAuthorId = deterministicCatalogId('author', 'someone else')
const catalogTesterAuthorId = deterministicCatalogId('author', 'catalog tester')
const tombstonedUid = `catalog-tombstoned-${suffix}`
const kindPersonUid = `catalog-kind-person-${suffix}`
const kindEntityUid = `catalog-kind-entity-${suffix}`
const conflictingKindAuthorId = deterministicCatalogId('author', 'same catalog name')
const operatorPriorityBookId = `catalog-priority-${suffix}`

after(async () => {
  await Promise.all([
    db.recursiveDelete(db.doc(`users/${sharingUid}`)),
    db.recursiveDelete(db.doc(`users/${nonSharingUid}`)),
    db.recursiveDelete(db.doc(`users/${tombstonedUid}`)),
    db.recursiveDelete(db.doc(`users/${kindPersonUid}`)),
    db.recursiveDelete(db.doc(`users/${kindEntityUid}`)),
    db.doc(`users/${OPERATOR_UID}/books/${operatorPriorityBookId}`).delete(),
    db.doc(`users/${OPERATOR_UID}/authors/ursula-priority`).delete(),
    db.doc(`profiles/${username}`).delete(),
    db.doc(`profiles/${secondUsername}`).delete(),
    db.doc(`works/${workId}`).delete(),
    db.doc(`editions/${editionId}`).delete(),
    db.doc(`editions/${secondEditionId}`).delete(),
    db.doc(`editions/${lateEditionId}`).delete(),
    db.doc(`isbnIndex/${isbn}`).delete(),
    db.doc(`isbnIndex/${secondIsbn}`).delete(),
    db.doc(`isbnIndex/${lateIsbn}`).delete(),
    db.doc(`workTitleIndex/${deterministicTitleIndexId(workId, 'left hand of darkness')}`).delete(),
    db.doc(`sharedWorkOwners/${projectionId}`).delete(),
    db.doc(`sharedWorkOwners/${staleProjectionId}`).delete(),
    db.doc(`works/${conflictWorkId}`).delete(),
    db.doc(`editions/${conflictEditionId}`).delete(),
    db.doc(`isbnIndex/${conflictIsbn}`).delete(),
    db.doc(`workTitleIndex/${deterministicTitleIndexId(conflictWorkId, conflictTitleKey)}`).delete(),
    db.doc(`works/${cycleWorkA}`).delete(),
    db.doc(`works/${cycleWorkB}`).delete(),
    db.doc(`externalIdIndex/${corruptExternalIndexId}`).delete(),
    db.doc(`catalogAuthors/${leGuinAuthorId}`).delete(),
    db.doc(`catalogAuthors/${butlerAuthorId}`).delete(),
    db.doc(`catalogAuthors/${someoneElseAuthorId}`).delete(),
    db.doc(`catalogAuthors/${catalogTesterAuthorId}`).delete(),
    db.doc(`catalogAuthors/${conflictingKindAuthorId}`).delete(),
    secretsDb.doc(`togglTokens/${nonSharingUid}`).delete(),
  ])
})

function runScript(scriptPath: string, ...args: string[]): string {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 15_000,
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

function validWork(title: string, titleKey: string, authorIds: string[]) {
  const now = Timestamp.now()
  return {
    canonicalTitle: title,
    alternateTitles: [],
    titleKeys: [titleKey],
    authorIds,
    coverUrl: '',
    subjects: [],
    fiction: null,
    status: 'active',
    mergedFrom: [],
    createdAt: now,
    updatedAt: now,
  }
}

async function migrationSource(
  uid: string,
  book: DocumentReference,
  authors: DocumentReference[] = [],
) {
  const [bookSnapshot, authorSnapshots] = await Promise.all([
    book.get(),
    Promise.all(authors.map((author) => author.get())),
  ])
  assert.ok(bookSnapshot.updateTime)
  for (const author of authorSnapshots) assert.ok(author.updateTime)
  return {
    uid,
    bookPath: book.path,
    bookVersion: bookSnapshot.updateTime.toMillis(),
    authorVersions: authorSnapshots.map((author) => ({
      path: author.ref.path,
      version: author.updateTime!.toMillis(),
    })),
  }
}

test('author-kind conflicts preserve legacy rows instead of collapsing them', async () => {
  const personUser = db.doc(`users/${kindPersonUid}`)
  const entityUser = db.doc(`users/${kindEntityUid}`)
  const personAuthor = personUser.collection('authors').doc('same-name')
  const entityAuthor = entityUser.collection('authors').doc('same-name')
  const personBook = personUser.collection('books').doc('person-book')
  const entityBook = entityUser.collection('books').doc('entity-book')
  await Promise.all([
    personUser.set({uid: kindPersonUid}),
    entityUser.set({uid: kindEntityUid}),
    personAuthor.set({name: 'Same Catalog Name', kind: 'person'}),
    entityAuthor.set({name: 'Same Catalog Name', kind: 'entity'}),
    personBook.set({title: 'Person Classification', isbn: '', authorIds: ['same-name'], createdAt: Timestamp.now()}),
    entityBook.set({title: 'Entity Classification', isbn: '', authorIds: ['same-name'], createdAt: Timestamp.now()}),
  ])

  const applied = runScript(migrationPath, '--apply')
  assert.match(applied, /REVIEW author-kind-conflict/)
  assert.equal((await db.doc(`catalogAuthors/${conflictingKindAuthorId}`).get()).exists, false)
  assert.deepEqual((await personBook.get()).get('authorIds'), ['same-name'])
  assert.deepEqual((await entityBook.get()).get('authorIds'), ['same-name'])
  assert.equal((await personAuthor.get()).exists, true)
  assert.equal((await entityAuthor.get()).exists, true)
  await Promise.all([db.recursiveDelete(personUser), db.recursiveDelete(entityUser)])
})

test('catalog migration dry-runs, creates once, preserves updatedAt, and reports ISBN conflicts', async () => {
  const sharingUser = db.doc(`users/${sharingUid}`)
  const nonSharingUser = db.doc(`users/${nonSharingUid}`)
  const sharedBook = sharingUser.collection('books').doc('shared-copy')
  const unsharedBook = nonSharingUser.collection('books').doc('unshared-copy')
  const unsharedMetadataBook = nonSharingUser.collection('books').doc('second-edition-copy')
  const unmatchedBook = nonSharingUser.collection('books').doc('unique-copy')
  const conflictBook = sharingUser.collection('books').doc('isbn-conflict')
  const nonSharingConflictBook = nonSharingUser.collection('books').doc('isbn-conflict-copy')
  const originalUpdatedAt = Timestamp.fromMillis(123_456)
  const now = Timestamp.now()
  const operatorUser = db.doc(`users/${OPERATOR_UID}`)
  const operatorBook = operatorUser.collection('books').doc(operatorPriorityBookId)
  // A tombstoned account (SEC-006 soft delete) is frozen: its copy of the
  // same book must neither seed the catalog nor be rewritten, and the
  // deletion runbook stays the only path that touches it.
  const tombstonedUser = db.doc(`users/${tombstonedUid}`)
  const tombstonedBook = tombstonedUser.collection('books').doc('tombstoned-copy')

  await Promise.all([
    sharingUser.set({ uid: sharingUid }),
    nonSharingUser.set({ uid: nonSharingUid }),
    tombstonedUser.set({ uid: tombstonedUid, deletedAt: Timestamp.now() }),
    tombstonedBook.set({
      title: 'The Left Hand of Darkness', isbn, authorIds: [leGuinAuthorId],
      pageCount: 304, createdAt: originalUpdatedAt, updatedAt: originalUpdatedAt,
    }),
    operatorUser.set({uid: OPERATOR_UID}, {merge: true}),
    db.doc(`profiles/${username}`).set({ uid: sharingUid, public: true }),
    db.doc(`catalogAuthors/${someoneElseAuthorId}`).set({
      canonicalName: 'Someone Else', alternateNames: [], nameKeys: ['someone else'],
      sortName: 'Else', kind: 'person', status: 'active', mergedFrom: [],
      createdBy: 'someone-else', createdAt: now, updatedAt: now,
    }),
    sharingUser.collection('settings').doc('bookSharing').set({
      enabled: true,
      timeZone: 'America/Los_Angeles',
      createdAt: now,
      updatedAt: now,
    }),
    // Sharing is on by default, so the account that must produce no reader
    // row is the one that opted out.
    nonSharingUser.collection('settings').doc('bookSharing').set({
      enabled: false,
      timeZone: 'UTC',
      createdAt: now,
      updatedAt: now,
    }),
    sharingUser.collection('authors').doc('ursula').set({ name: 'Ursula K. Le Guin', kind: 'person' }),
    sharingUser.collection('authors').doc('octavia').set({ name: 'Octavia E. Butler', kind: 'person' }),
    nonSharingUser.collection('authors').doc('ursula').set({ name: 'Ursula K. Le Guin', kind: 'person' }),
    nonSharingUser.collection('authors').doc('octavia').set({ name: 'Octavia E. Butler', kind: 'person' }),
    operatorUser.collection('authors').doc('ursula-priority').set({
      name: 'Ursula K. Le Guin', kind: 'person',
    }),
    operatorBook.set({
      title: 'The Left Hand of Darkness', isbn, authorIds: ['ursula-priority'],
      pageCount: 333, publisher: 'Operator Press', publishedDate: '1969',
      coverUrl: 'https://operator.example.test/cover.jpg',
      subjects: ['Science fiction'], fiction: true, createdAt: originalUpdatedAt, updatedAt: originalUpdatedAt,
    }),
    sharedBook.set({
      title: 'The Left Hand of Darkness',
      isbn,
      authorIds: ['ursula'],
      pageCount: 304,
      coverUrl: 'http://cover.example.test/cover.jpg',
      createdAt: originalUpdatedAt, updatedAt: originalUpdatedAt,
    }),
    unsharedBook.set({ title: 'Left Hand of Darkness, The', isbn, authorIds: ['ursula'], pageCount: 320, createdAt: originalUpdatedAt, updatedAt: originalUpdatedAt }),
    unsharedMetadataBook.set({
      title: 'The Left Hand of Darkness', isbn: secondIsbn, authorIds: ['ursula'],
      pageCount: 999, publisher: 'Second Press', publishedDate: 'secret-date',
      coverUrl: 'https://second.example.test/cover.jpg', createdAt: originalUpdatedAt, updatedAt: originalUpdatedAt,
    }),
    unmatchedBook.set({ title: 'Parable of the Sower', isbn: '', authorIds: ['octavia'], pageCount: 264, createdAt: originalUpdatedAt, updatedAt: originalUpdatedAt }),
    conflictBook.set({ title: 'Kindred', isbn: conflictIsbn, authorIds: ['octavia'], pageCount: 304, createdAt: originalUpdatedAt, updatedAt: originalUpdatedAt }),
    nonSharingConflictBook.set({ title: 'Kindred', isbn: conflictIsbn, authorIds: ['octavia'], pageCount: 288, createdAt: originalUpdatedAt, updatedAt: originalUpdatedAt }),
    db.doc(`works/${conflictWorkId}`).set({...validWork('A Different Book', conflictTitleKey, [someoneElseAuthorId]), createdBy: 'someone-else'}),
    db.doc(`editions/${conflictEditionId}`).set({
      workId: conflictWorkId,
      isbn13: conflictIsbn,
      title: 'A Different Book',
      publisher: '',
      publishedDate: '',
      language: '',
      translatorNames: [],
      format: 'unknown',
      suggestedPageCount: null,
      coverUrl: '',
      externalIds: {},
      createdBy: 'someone-else', createdAt: now,
      updatedAt: now,
    }),
    db.doc(`isbnIndex/${conflictIsbn}`).set({ workId: conflictWorkId, editionId: conflictEditionId }),
    db.doc(`workTitleIndex/${deterministicTitleIndexId(conflictWorkId, conflictTitleKey)}`).set({
      workId: conflictWorkId,
      title: 'A Different Book',
      titleKey: conflictTitleKey,
      status: 'active',
    }),
  ])

  const dryRun = runScript(migrationPath, '--expect-overlap-groups=1')
  assert.match(dryRun, /^ACCEPT 1 cross-user overlap groups$/m)
  assert.match(dryRun, new RegExp(`^SKIP tombstoned-account users/${tombstonedUid}$`, 'm'))
  assert.match(dryRun, new RegExp(`DRY  create works/${workId}`))
  assert.match(dryRun, /REVIEW existing-isbn-text-conflict/)
  assert.equal((await db.doc(`works/${workId}`).get()).exists, false)
  assert.equal((await db.doc(`sharedWorkOwners/${projectionId}`).get()).exists, false)
  assert.equal((await sharedBook.get()).data()?.workId, undefined)

  const applied = runScript(migrationPath, '--apply')
  assert.match(applied, new RegExp(`SET  create works/${workId}`))
  assert.match(applied, new RegExp(`^SKIP tombstoned-account users/${tombstonedUid}$`, 'm'))
  // The frozen copy is untouched: it gains none of the four catalog link
  // fields the same book earns for every live account, and no reader
  // projection. Remove the skip and the key set below grows.
  const tombstonedCopy = (await tombstonedBook.get()).data()
  assert.deepEqual(Object.keys(tombstonedCopy ?? {}).sort(),
    ['authorIds', 'createdAt', 'isbn', 'pageCount', 'title', 'updatedAt'])
  assert.equal(
    (await db.collection('sharedWorkOwners').where('uid', '==', tombstonedUid).get()).empty,
    true,
  )
  assert.match(applied, /REVIEW existing-isbn-text-conflict/)
  const createdWork = (await db.doc(`works/${workId}`).get()).data()
  assert.equal(createdWork?.coverUrl, 'https://operator.example.test/cover.jpg')
  assert.deepEqual(createdWork?.subjects, ['Science fiction'])
  assert.equal(createdWork?.fiction, true)
  assert.equal((await db.doc(`catalogAuthors/${leGuinAuthorId}`).get()).get('canonicalName'), 'Ursula K. Le Guin')
  const createdEdition = (await db.doc(`editions/${editionId}`).get()).data()
  assert.equal(createdEdition?.coverUrl, 'https://operator.example.test/cover.jpg')
  assert.equal(createdEdition?.suggestedPageCount, 333)
  assert.equal(createdEdition?.publisher, 'Operator Press')
  assert.equal(createdEdition?.publishedDate, '1969')
  assert.deepEqual((await db.doc(`isbnIndex/${isbn}`).get()).data(), { workId, editionId })
  // Every copy seeds: the second account's ISBN is another edition of the
  // same work (catalog data is public whoever contributed it).
  assert.deepEqual((await db.doc(`isbnIndex/${secondIsbn}`).get()).data(), { workId, editionId: secondEditionId })
  const secondEdition = (await db.doc(`editions/${secondEditionId}`).get()).data()
  assert.equal(secondEdition?.publisher, 'Second Press')
  assert.equal(secondEdition?.suggestedPageCount, 999)
  const projection = await db.doc(`sharedWorkOwners/${projectionId}`).get()
  assert.deepEqual(Object.keys(projection.data() ?? {}).sort(), ['uid', 'updatedAt', 'workId'])
  assert.equal(projection.get('workId'), workId)
  assert.equal(projection.get('uid'), sharingUid)
  assert.equal(projection.get('updatedAt') instanceof Timestamp, true)
  assert.equal((await db.collection('sharedWorkOwners').where('uid', '==', nonSharingUid).get()).empty, true)
  assert.deepEqual((await db.doc(`isbnIndex/${conflictIsbn}`).get()).data(), {
    workId: conflictWorkId,
    editionId: conflictEditionId,
  })

  const shared = (await sharedBook.get()).data()
  const unsharedCopy = (await unsharedBook.get()).data()
  const unsharedMetadataCopy = (await unsharedMetadataBook.get()).data()
  const unmatched = (await unmatchedBook.get()).data()
  const conflict = (await conflictBook.get()).data()
  const nonSharingConflict = (await nonSharingConflictBook.get()).data()
  for (const snapshot of [shared, unsharedCopy, unsharedMetadataCopy]) {
    assert.deepEqual(snapshot?.authorIds, [leGuinAuthorId])
  }
  for (const snapshot of [unmatched, conflict, nonSharingConflict]) assert.deepEqual(snapshot?.authorIds, [butlerAuthorId])
  // Legacy per-user author documents are retained (soft-delete policy);
  // the migration only proves no book references them any more.
  for (const user of [sharingUser, nonSharingUser]) {
    const legacy = await user.collection('authors').get()
    assert.equal(legacy.empty, false)
    const legacyIds = new Set(legacy.docs.map((snapshot) => snapshot.id))
    for (const bookSnapshot of (await user.collection('books').get()).docs) {
      const ids = bookSnapshot.get('authorIds') as string[]
      assert.equal(ids.some((id) => legacyIds.has(id)), false, bookSnapshot.ref.path)
    }
  }
  assert.equal(shared?.workId, workId)
  assert.equal(shared?.editionId, editionId)
  assert.equal(shared?.matchMethod, 'isbn')
  assert.equal(unsharedCopy?.workId, workId)
  assert.equal(unsharedCopy?.editionId, editionId)
  assert.equal(unsharedMetadataCopy?.workId, workId)
  assert.equal(unsharedMetadataCopy?.editionId, secondEditionId)
  assert.equal(unsharedMetadataCopy?.matchMethod, 'isbn')
  // A book nobody else has still seeds its own work (no ISBN, so no
  // edition); it is only the ISBN conflicts below that stay unlinked.
  assert.equal(typeof unmatched?.workId, 'string')
  assert.equal(unmatched?.editionId, null)
  assert.equal(unmatched?.matchMethod, 'migration')
  assert.equal((await db.doc(`works/${unmatched?.workId}`).get()).get('canonicalTitle'), 'Parable of the Sower')
  assert.deepEqual(
    { workId: conflict?.workId, editionId: conflict?.editionId, matchMethod: conflict?.matchMethod, linkedAt: conflict?.linkedAt },
    { workId: null, editionId: null, matchMethod: null, linkedAt: null },
  )
  assert.deepEqual(
    { workId: nonSharingConflict?.workId, editionId: nonSharingConflict?.editionId, matchMethod: nonSharingConflict?.matchMethod, linkedAt: nonSharingConflict?.linkedAt },
    { workId: null, editionId: null, matchMethod: null, linkedAt: null },
  )
  for (const snapshot of [shared, unsharedCopy, unsharedMetadataCopy, unmatched, conflict, nonSharingConflict]) {
    assert.equal(snapshot?.updatedAt.toMillis(), originalUpdatedAt.toMillis())
  }

  const rerun = runScript(migrationPath, '--apply')
  assert.match(rerun, /^0 catalog documents created$/m)
  assert.match(rerun, /^0 personal books updated$/m)

  const lateAddedBook = nonSharingUser.collection('books').doc('late-added-copy')
  await lateAddedBook.set({
    title: 'The Left Hand of Darkness', isbn: lateIsbn, authorIds: [leGuinAuthorId],
    pageCount: 777, publisher: 'Third Press', createdAt: originalUpdatedAt, updatedAt: originalUpdatedAt,
  })
  // A copy added after the first apply seeds its own edition on the re-run.
  const lateApply = runScript(migrationPath, '--apply')
  assert.match(lateApply, /^2 catalog documents created$/m)
  assert.deepEqual((await db.doc(`isbnIndex/${lateIsbn}`).get()).data(), { workId, editionId: lateEditionId })
  assert.equal((await db.doc(`editions/${lateEditionId}`).get()).get('suggestedPageCount'), 777)
  assert.equal((await lateAddedBook.get()).get('workId'), workId)
  assert.equal((await lateAddedBook.get()).get('editionId'), lateEditionId)
  const lateRerun = runScript(migrationPath, '--apply')
  assert.match(lateRerun, /^0 catalog documents created$/m)
  assert.match(lateRerun, /^0 personal books updated$/m)

  const raceSource = sharingUser.collection('books').doc('preferred-race-source')
  const revokedAlternateSource = nonSharingUser.collection('books').doc('revoked-alternate-source')
  await Promise.all([
    raceSource.set({title: 'Preferred Seed', authorIds: [leGuinAuthorId], pageCount: 100}),
    revokedAlternateSource.set({title: 'Translated Seed', authorIds: [leGuinAuthorId], pageCount: 110}),
    db.doc(`profiles/${secondUsername}`).set({uid: nonSharingUid, public: true}),
    nonSharingUser.collection('settings').doc('bookSharing').set({
      enabled: true,
      timeZone: 'America/Los_Angeles',
      createdAt: now,
      updatedAt: now,
    }),
  ])
  const eligibleRaceSource = await migrationSource(sharingUid, raceSource)
  const revokedRaceSource = await migrationSource(nonSharingUid, revokedAlternateSource)
  await nonSharingUser.collection('settings').doc('bookSharing').set({
    enabled: false, timeZone: 'UTC', createdAt: now, updatedAt: now,
  })

  await raceSource.update({title: 'Concurrent identity edit'})
  await assert.rejects(
    db.runTransaction(async (transaction) => {
      await assertMigrationSourceVersions(transaction, db, [eligibleRaceSource])
    }),
    /changed during migration/,
  )
  const ursulaRef = sharingUser.collection('authors').doc('ursula')
  await ursulaRef.set({name: 'Ursula K. Le Guin', kind: 'person'})
  const authorRaceSource = await migrationSource(sharingUid, raceSource, [ursulaRef])
  await ursulaRef.update({name: 'Concurrent Author Edit'})
  await assert.rejects(
    db.runTransaction(async (transaction) => {
      await assertMigrationSourceVersions(transaction, db, [authorRaceSource])
    }),
    /changed during migration/,
  )
  await ursulaRef.update({name: 'Ursula K. Le Guin'})

  await sharingUser.collection('settings').doc('bookSharing').set({
    enabled: false, timeZone: 'America/Los_Angeles', createdAt: now, updatedAt: now,
  })
  await raceSource.update({workId})
  await assert.rejects(
    db.runTransaction(async (transaction) => {
      await assertMigrationProjectionSourcesConsented(
        transaction,
        db,
        [eligibleRaceSource],
        workId,
      )
      transaction.create(db.doc(`sharedWorkOwners/race-${suffix}`), {
        workId,
        uid: sharingUid,
        updatedAt: Timestamp.now(),
      })
    }),
    /is no longer opted in/,
  )
  assert.equal((await db.doc(`sharedWorkOwners/race-${suffix}`).get()).exists, false)

  await sharingUser.collection('settings').doc('bookSharing').set({
    enabled: true,
    timeZone: 'America/Los_Angeles',
    createdAt: now,
    updatedAt: now,
  })
  await raceSource.update({workId: conflictWorkId})
  await assert.rejects(
    db.runTransaction(async (transaction) => {
      await assertMigrationProjectionSourcesConsented(
        transaction,
        db,
        [eligibleRaceSource],
        workId,
      )
      transaction.create(db.doc(`sharedWorkOwners/race-${suffix}`), {
        workId,
        uid: sharingUid,
        updatedAt: Timestamp.now(),
      })
    }),
    /has no currently linked source book/,
  )
  assert.equal((await db.doc(`sharedWorkOwners/race-${suffix}`).get()).exists, false)
  await Promise.all([
    raceSource.delete(),
    revokedAlternateSource.delete(),
    ursulaRef.delete(),
    db.doc(`profiles/${secondUsername}`).delete(),
  ])

  // The catalog build mints editions for ISBNs only, so its ISBN-less links
  // are the drift migrate-book-editions.ts exists for: the rehearsal loop
  // (dry-run, apply twice with a no-op second apply, audit) runs here so
  // the migrated state is what the audit calls clean.
  const backfillDryRun = runScript(backfillPath)
  assert.match(backfillDryRun, /^linked books without an edition: [1-9]\d* of /m)
  assert.match(backfillDryRun, /^dry-run: nothing written$/m)
  const backfillApplied = runScript(backfillPath, '--apply')
  assert.match(backfillApplied, /^applied: [1-9]\d* editions created, [1-9]\d* books linked$/m)
  const backfillRerun = runScript(backfillPath, '--apply')
  assert.match(backfillRerun, /^linked books without an edition: 0 of /m)
  assert.match(backfillRerun, /^applied: 0 editions created, 0 books linked$/m)

  // The catalog build stamps no creator; migrate-catalog-creators.ts gives
  // each record the reader whose book first stood on it, same loop.
  const creatorsDryRun = runScript(creatorsPath)
  assert.match(creatorsDryRun, /^records without a creator: [1-9]\d* of /m)
  assert.doesNotMatch(creatorsDryRun, /^REVIEW /m)
  assert.match(creatorsDryRun, /^dry-run: nothing written$/m)
  const creatorsApplied = runScript(creatorsPath, '--apply')
  assert.match(creatorsApplied, /^applied: [1-9]\d* creators stamped$/m)
  const creatorsRerun = runScript(creatorsPath, '--apply')
  assert.match(creatorsRerun, /^records without a creator: 0 of /m)
  assert.match(creatorsRerun, /^applied: 0 creators stamped$/m)

  // The catalog build predates the language field; migrate-work-languages.ts
  // infers each work's default from its editions' ISBN group and stamps the
  // carried copy on every book, same loop. The seeded ISBNs are 978-0
  // numbers, so those works read English; the one work the build minted
  // for an ISBN-less book has nothing to infer from and is listed.
  const languagesDryRun = runScript(languagesPath)
  assert.match(languagesDryRun, /^works without a language field: [1-9]\d* of /m)
  assert.match(languagesDryRun, /^SET works\/\S+ language="en" via=isbn-group$/m)
  assert.equal(languagesDryRun.match(/^REVIEW /gm)?.length, 1)
  assert.match(languagesDryRun, /^REVIEW works\/\S+: no ISBN$/m)
  assert.match(languagesDryRun, /^dry-run: nothing written$/m)
  const languagesApplied = runScript(languagesPath, '--apply')
  assert.match(languagesApplied, /^applied: [1-9]\d* works and [1-9]\d* books stamped$/m)
  const languagesRerun = runScript(languagesPath, '--apply')
  assert.match(languagesRerun, /^works without a language field: 0 of /m)
  assert.match(languagesRerun, /^applied: 0 works and 0 books stamped$/m)
  const audit = runScript(auditPath)
  assert.doesNotMatch(audit, /^catalog\./m)

  await Promise.all([
    db.doc(`catalogAuthors/${catalogTesterAuthorId}`).set({
      canonicalName: 'Catalog Tester', alternateNames: [], nameKeys: ['catalog tester'],
      sortName: 'Tester', kind: 'person', status: 'active', mergedFrom: [],
      createdAt: now, updatedAt: now,
    }),
    db.doc(`works/${cycleWorkA}`).set({
      ...validWork('Cycle A', 'cycle a', [catalogTesterAuthorId]),
      subjects: 'not-an-array',
      status: 'merged',
      mergedInto: cycleWorkB,
    }),
    db.doc(`works/${cycleWorkB}`).set({
      ...validWork('Cycle B', 'cycle b', [catalogTesterAuthorId]),
      status: 'merged',
      mergedInto: cycleWorkA,
    }),
    db.doc(`works/${workId}`).update({ mergedFrom: ['missing-work'] }),
    db.doc(`workTitleIndex/${deterministicTitleIndexId(workId, 'left hand of darkness')}`).delete(),
    db.doc(`editions/${editionId}`).update({ workId: cycleWorkA }),
    db.doc(`isbnIndex/${isbn}`).update({ workId: conflictWorkId }),
    db.doc(`editions/${conflictEditionId}`).update({
      externalIds: { 'open-library': 'OL-CATALOG-TEST' },
      format: 'not-a-format',
    }),
    db.doc(`externalIdIndex/${corruptExternalIndexId}`).set({
      workId: conflictWorkId,
      editionId: `missing-edition-${suffix}`,
      provider: 'open-library',
      externalId: 'OL-DANGLING-TEST',
      unexpected: true,
    }),
    db.doc(`sharedWorkOwners/${projectionId}`).delete(),
    db.doc(`sharedWorkOwners/${staleProjectionId}`).set({
      workId,
      uid: nonSharingUid,
      updatedAt: now,
    }),
    sharedBook.collection('updates').doc('bad-references').set({
      owner: nonSharingUser,
      book: unsharedBook,
      type: 'reading',
      timeRead: 60,
      fromPage: 0,
      toPage: 10,
      pagesRead: 10,
      createdAt: now,
      updatedAt: now,
    }),
    nonSharingUser.update({toggl: null}),
    secretsDb.doc(`togglTokens/${nonSharingUid}`).set({
      apiToken: 'local-corrupt-shape-fixture',
      workspaceId: 1,
      projectId: 2,
      updatedAt: now,
    }),
  ])
  const corruptAudit = runScript(auditPath)
  assert.match(corruptAudit, /^catalog\.work\.merge-cycle /m)
  assert.match(corruptAudit, new RegExp(`^catalog\\.work\\.bad-subjects works/${cycleWorkA}`, 'm'))
  assert.match(corruptAudit, /^catalog\.work\.merge-not-one-hop /m)
  assert.match(corruptAudit, new RegExp(`^catalog\\.work\\.title-index-count works/${workId}`, 'm'))
  assert.match(corruptAudit, new RegExp(`^catalog\\.work\\.merged-from-mismatch works/${workId}`, 'm'))
  assert.match(corruptAudit, new RegExp(`^catalog\\.edition\\.work-not-one-hop editions/${editionId}`, 'm'))
  assert.match(corruptAudit, new RegExp(`^catalog\\.isbn-index\\.work-mismatch isbnIndex/${isbn}`, 'm'))
  assert.match(corruptAudit, new RegExp(`^catalog\\.edition\\.external-index-mismatch editions/${conflictEditionId}`, 'm'))
  assert.match(corruptAudit, new RegExp(`^catalog\\.edition\\.bad-format editions/${conflictEditionId}`, 'm'))
  assert.match(corruptAudit, new RegExp(`^catalog\\.external-index\\.bad-shape externalIdIndex/${corruptExternalIndexId}`, 'm'))
  assert.match(corruptAudit, new RegExp(`^catalog\\.external-index\\.bad-id externalIdIndex/${corruptExternalIndexId}`, 'm'))
  assert.match(corruptAudit, new RegExp(`^catalog\\.external-index\\.edition-missing externalIdIndex/${corruptExternalIndexId}`, 'm'))
  assert.match(corruptAudit, new RegExp(`^book-sharing\\.projection-missing sharedWorkOwners/${projectionId}`, 'm'))
  assert.match(corruptAudit, new RegExp(`^book-sharing\\.projection-without-consent sharedWorkOwners/${staleProjectionId}`, 'm'))
  assert.match(corruptAudit, new RegExp(`^update\\.owner-mismatch users/${sharingUid}/books/shared-copy/updates/bad-references`, 'm'))
  assert.match(corruptAudit, new RegExp(`^update\\.book-mismatch users/${sharingUid}/books/shared-copy/updates/bad-references`, 'm'))
  assert.match(corruptAudit, new RegExp(`^catalog\\.book\\.isbn-provenance-mismatch users/${nonSharingUid}/books/unshared-copy`, 'm'))
  assert.match(corruptAudit, new RegExp(`^user\\.toggl-status\\.bad-shape users/${nonSharingUid}`, 'm'))
  assert.match(corruptAudit, new RegExp(`^toggl-secret\\.status-missing secrets:togglTokens/${nonSharingUid}`, 'm'))
})
