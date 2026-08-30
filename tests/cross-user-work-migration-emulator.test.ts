import './setup.ts';

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { initializeApp } from 'firebase-admin/app'
import { getFirestore, Timestamp, type DocumentReference } from 'firebase-admin/firestore'
import { deterministicCatalogId, deterministicTitleIndexId } from '../cross-user-work-migration.ts'
import {
  assertMigrationProjectionSourcesEligible,
  assertMigrationSeedSourcesEligible,
  assertMigrationSourceVersions,
} from '../migration-seed-consent.ts'

const db = getFirestore(initializeApp({ projectId: 'book-tracker-d8f24' }, 'catalog-migration-test'))
const suffix = Date.now().toString(36)
const sharingUid = `catalog-sharing-${suffix}`
const privateUid = `catalog-private-${suffix}`
const username = `catalog-${suffix}`.slice(0, 30)
const privateRaceUsername = `race-${suffix}`.slice(0, 30)
const migrationPath = fileURLToPath(new URL('../migrate-cross-user-works.ts', import.meta.url))
const auditPath = fileURLToPath(new URL('../db-audit.ts', import.meta.url))
const groupKey = 'title:left hand of darkness\0authors:ursula k le guin'
const workId = deterministicCatalogId('work', groupKey)
const isbn = '9780441478125'
const editionId = deterministicCatalogId('edition', `${workId}\0${isbn}`)
const privateIsbn = '9780316769488'
const privateEditionId = deterministicCatalogId('edition', `${workId}\0${privateIsbn}`)
const latePrivateIsbn = '9780140328721'
const latePrivateEditionId = deterministicCatalogId('edition', `${workId}\0${latePrivateIsbn}`)
const projectionId = createHash('sha256').update(`${workId}\0${sharingUid}`).digest('hex')
const stalePrivateProjectionId = createHash('sha256').update(`${workId}\0${privateUid}`).digest('hex')
const conflictIsbn = '9781473217386'
const conflictWorkId = `work-existing-${suffix}`
const conflictEditionId = `edition-existing-${suffix}`
const conflictTitleKey = 'different book'
const cycleWorkA = `work-cycle-a-${suffix}`
const cycleWorkB = `work-cycle-b-${suffix}`
const corruptExternalIndexId = `bad-external-index-${suffix}`
const revokedSeedWorkId = `revoked-seed-${suffix}`
const leGuinAuthorId = deterministicCatalogId('author', 'ursula k le guin')
const butlerAuthorId = deterministicCatalogId('author', 'octavia e butler')
const someoneElseAuthorId = deterministicCatalogId('author', 'someone else')
const catalogTesterAuthorId = deterministicCatalogId('author', 'catalog tester')
const kindPersonUid = `catalog-kind-person-${suffix}`
const kindEntityUid = `catalog-kind-entity-${suffix}`
const conflictingKindAuthorId = deterministicCatalogId('author', 'same catalog name')

after(async () => {
  await Promise.all([
    db.recursiveDelete(db.doc(`users/${sharingUid}`)),
    db.recursiveDelete(db.doc(`users/${privateUid}`)),
    db.recursiveDelete(db.doc(`users/${kindPersonUid}`)),
    db.recursiveDelete(db.doc(`users/${kindEntityUid}`)),
    db.doc(`profiles/${username}`).delete(),
    db.doc(`profiles/${privateRaceUsername}`).delete(),
    db.doc(`works/${workId}`).delete(),
    db.doc(`editions/${editionId}`).delete(),
    db.doc(`editions/${privateEditionId}`).delete(),
    db.doc(`editions/${latePrivateEditionId}`).delete(),
    db.doc(`isbnIndex/${isbn}`).delete(),
    db.doc(`isbnIndex/${privateIsbn}`).delete(),
    db.doc(`isbnIndex/${latePrivateIsbn}`).delete(),
    db.doc(`workTitleIndex/${deterministicTitleIndexId(workId, 'left hand of darkness')}`).delete(),
    db.doc(`sharedWorkOwners/${projectionId}`).delete(),
    db.doc(`sharedWorkOwners/${stalePrivateProjectionId}`).delete(),
    db.doc(`works/${conflictWorkId}`).delete(),
    db.doc(`editions/${conflictEditionId}`).delete(),
    db.doc(`isbnIndex/${conflictIsbn}`).delete(),
    db.doc(`workTitleIndex/${deterministicTitleIndexId(conflictWorkId, conflictTitleKey)}`).delete(),
    db.doc(`works/${cycleWorkA}`).delete(),
    db.doc(`works/${cycleWorkB}`).delete(),
    db.doc(`externalIdIndex/${corruptExternalIndexId}`).delete(),
    db.doc(`works/${revokedSeedWorkId}`).delete(),
    db.doc(`catalogAuthors/${leGuinAuthorId}`).delete(),
    db.doc(`catalogAuthors/${butlerAuthorId}`).delete(),
    db.doc(`catalogAuthors/${someoneElseAuthorId}`).delete(),
    db.doc(`catalogAuthors/${catalogTesterAuthorId}`).delete(),
    db.doc(`catalogAuthors/${conflictingKindAuthorId}`).delete(),
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
    visibility: 'searchable',
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
    personBook.set({title: 'Person Classification', isbn: '', authorIds: ['same-name']}),
    entityBook.set({title: 'Entity Classification', isbn: '', authorIds: ['same-name']}),
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
  const privateUser = db.doc(`users/${privateUid}`)
  const sharedBook = sharingUser.collection('books').doc('shared-copy')
  const privateBook = privateUser.collection('books').doc('private-copy')
  const privateMetadataBook = privateUser.collection('books').doc('private-metadata-copy')
  const unmatchedBook = privateUser.collection('books').doc('private-only')
  const conflictBook = sharingUser.collection('books').doc('isbn-conflict')
  const privateConflictBook = privateUser.collection('books').doc('isbn-conflict-copy')
  const originalUpdatedAt = Timestamp.fromMillis(123_456)
  const now = Timestamp.now()

  await Promise.all([
    sharingUser.set({ uid: sharingUid }),
    privateUser.set({ uid: privateUid }),
    db.doc(`profiles/${username}`).set({ uid: sharingUid, public: true }),
    db.doc(`catalogAuthors/${someoneElseAuthorId}`).set({
      canonicalName: 'Someone Else', alternateNames: [], nameKeys: ['someone else'],
      sortName: 'Else', kind: 'person', status: 'active', mergedFrom: [],
      createdAt: now, updatedAt: now,
    }),
    sharingUser.collection('settings').doc('bookSharing').set({
      profileUsername: username,
      timeZone: 'America/Los_Angeles',
      createdAt: now,
      updatedAt: now,
    }),
    sharingUser.collection('authors').doc('ursula').set({ name: 'Ursula K. Le Guin', kind: 'person' }),
    sharingUser.collection('authors').doc('octavia').set({ name: 'Octavia E. Butler', kind: 'person' }),
    privateUser.collection('authors').doc('ursula').set({ name: 'Ursula K. Le Guin', kind: 'person' }),
    privateUser.collection('authors').doc('octavia').set({ name: 'Octavia E. Butler', kind: 'person' }),
    sharedBook.set({
      title: 'The Left Hand of Darkness',
      isbn,
      authorIds: ['ursula'],
      pageCount: 304,
      coverUrl: 'http://private-cover.example.test/not-shareable.jpg',
      updatedAt: originalUpdatedAt,
    }),
    privateBook.set({ title: 'Left Hand of Darkness, The', isbn, authorIds: ['ursula'], pageCount: 320, updatedAt: originalUpdatedAt }),
    privateMetadataBook.set({
      title: 'The Left Hand of Darkness', isbn: privateIsbn, authorIds: ['ursula'],
      pageCount: 999, publisher: 'Private Shelf Press', publishedDate: 'secret-date',
      coverUrl: 'https://private.example.test/cover.jpg', updatedAt: originalUpdatedAt,
    }),
    unmatchedBook.set({ title: 'Parable of the Sower', isbn: '', authorIds: ['octavia'], pageCount: 264, updatedAt: originalUpdatedAt }),
    conflictBook.set({ title: 'Kindred', isbn: conflictIsbn, authorIds: ['octavia'], pageCount: 304, updatedAt: originalUpdatedAt }),
    privateConflictBook.set({ title: 'Kindred', isbn: conflictIsbn, authorIds: ['octavia'], pageCount: 288, updatedAt: originalUpdatedAt }),
    db.doc(`works/${conflictWorkId}`).set(validWork('A Different Book', conflictTitleKey, [someoneElseAuthorId])),
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
      createdAt: now,
      updatedAt: now,
    }),
    db.doc(`isbnIndex/${conflictIsbn}`).set({ workId: conflictWorkId, editionId: conflictEditionId }),
    db.doc(`workTitleIndex/${deterministicTitleIndexId(conflictWorkId, conflictTitleKey)}`).set({
      workId: conflictWorkId,
      title: 'A Different Book',
      titleKey: conflictTitleKey,
      visibility: 'searchable',
    }),
  ])

  const dryRun = runScript(migrationPath, '--expect-overlap-groups=1')
  assert.match(dryRun, /^ACCEPT 1 cross-user overlap groups$/m)
  assert.match(dryRun, new RegExp(`DRY  create works/${workId}`))
  assert.match(dryRun, /REVIEW existing-isbn-text-conflict/)
  assert.equal((await db.doc(`works/${workId}`).get()).exists, false)
  assert.equal((await db.doc(`sharedWorkOwners/${projectionId}`).get()).exists, false)
  assert.equal((await sharedBook.get()).data()?.workId, undefined)

  const applied = runScript(migrationPath, '--apply')
  assert.match(applied, new RegExp(`SET  create works/${workId}`))
  assert.match(applied, /REVIEW existing-isbn-text-conflict/)
  assert.equal((await db.doc(`works/${workId}`).get()).data()?.coverUrl, '')
  assert.equal((await db.doc(`catalogAuthors/${leGuinAuthorId}`).get()).get('canonicalName'), 'Ursula K. Le Guin')
  assert.equal((await db.doc(`editions/${editionId}`).get()).data()?.coverUrl, '')
  assert.deepEqual((await db.doc(`isbnIndex/${isbn}`).get()).data(), { workId, editionId })
  assert.equal((await db.doc(`isbnIndex/${privateIsbn}`).get()).exists, false)
  assert.equal((await db.doc(`editions/${privateEditionId}`).get()).exists, false)
  const projection = await db.doc(`sharedWorkOwners/${projectionId}`).get()
  assert.deepEqual(Object.keys(projection.data() ?? {}).sort(), ['uid', 'updatedAt', 'workId'])
  assert.equal(projection.get('workId'), workId)
  assert.equal(projection.get('uid'), sharingUid)
  assert.equal(projection.get('updatedAt') instanceof Timestamp, true)
  assert.equal((await db.collection('sharedWorkOwners').where('uid', '==', privateUid).get()).empty, true)
  assert.deepEqual((await db.doc(`isbnIndex/${conflictIsbn}`).get()).data(), {
    workId: conflictWorkId,
    editionId: conflictEditionId,
  })

  const shared = (await sharedBook.get()).data()
  const privateCopy = (await privateBook.get()).data()
  const privateMetadataCopy = (await privateMetadataBook.get()).data()
  const unmatched = (await unmatchedBook.get()).data()
  const conflict = (await conflictBook.get()).data()
  const privateConflict = (await privateConflictBook.get()).data()
  for (const snapshot of [shared, privateCopy, privateMetadataCopy]) {
    assert.deepEqual(snapshot?.authorIds, [leGuinAuthorId])
  }
  for (const snapshot of [unmatched, conflict, privateConflict]) assert.deepEqual(snapshot?.authorIds, [butlerAuthorId])
  assert.equal((await sharingUser.collection('authors').get()).empty, true)
  assert.equal((await privateUser.collection('authors').get()).empty, true)
  assert.equal(shared?.workId, workId)
  assert.equal(shared?.editionId, editionId)
  assert.equal(shared?.matchMethod, 'isbn')
  assert.equal(privateCopy?.workId, workId)
  assert.equal(privateCopy?.editionId, editionId)
  assert.equal(privateMetadataCopy?.workId, workId)
  assert.equal(privateMetadataCopy?.editionId, null)
  assert.equal(privateMetadataCopy?.matchMethod, 'migration')
  assert.deepEqual(
    { workId: unmatched?.workId, editionId: unmatched?.editionId, matchMethod: unmatched?.matchMethod, linkedAt: unmatched?.linkedAt },
    { workId: null, editionId: null, matchMethod: null, linkedAt: null },
  )
  assert.deepEqual(
    { workId: conflict?.workId, editionId: conflict?.editionId, matchMethod: conflict?.matchMethod, linkedAt: conflict?.linkedAt },
    { workId: null, editionId: null, matchMethod: null, linkedAt: null },
  )
  assert.deepEqual(
    { workId: privateConflict?.workId, editionId: privateConflict?.editionId, matchMethod: privateConflict?.matchMethod, linkedAt: privateConflict?.linkedAt },
    { workId: null, editionId: null, matchMethod: null, linkedAt: null },
  )
  for (const snapshot of [shared, privateCopy, privateMetadataCopy, unmatched, conflict, privateConflict]) {
    assert.equal(snapshot?.updatedAt.toMillis(), originalUpdatedAt.toMillis())
  }

  const rerun = runScript(migrationPath, '--apply')
  assert.match(rerun, /^0 catalog documents created$/m)
  assert.match(rerun, /^0 personal books updated$/m)

  const latePrivateBook = privateUser.collection('books').doc('late-private-copy')
  await latePrivateBook.set({
    title: 'The Left Hand of Darkness', isbn: latePrivateIsbn, authorIds: [leGuinAuthorId],
    pageCount: 777, publisher: 'Still Private Press', updatedAt: originalUpdatedAt,
  })
  const lateApply = runScript(migrationPath, '--apply')
  assert.match(lateApply, /^0 catalog documents created$/m)
  assert.equal((await db.doc(`isbnIndex/${latePrivateIsbn}`).get()).exists, false)
  assert.equal((await db.doc(`editions/${latePrivateEditionId}`).get()).exists, false)
  assert.equal((await latePrivateBook.get()).get('workId'), workId)
  assert.equal((await latePrivateBook.get()).get('editionId'), null)
  const lateRerun = runScript(migrationPath, '--apply')
  assert.match(lateRerun, /^0 catalog documents created$/m)
  assert.match(lateRerun, /^0 personal books updated$/m)

  const raceSource = sharingUser.collection('books').doc('preferred-race-source')
  const revokedAlternateSource = privateUser.collection('books').doc('revoked-alternate-source')
  await Promise.all([
    raceSource.set({title: 'Preferred Seed', authorIds: [leGuinAuthorId], pageCount: 100}),
    revokedAlternateSource.set({title: 'Translated Seed', authorIds: [leGuinAuthorId], pageCount: 110}),
    db.doc(`profiles/${privateRaceUsername}`).set({uid: privateUid, public: true}),
    privateUser.collection('settings').doc('bookSharing').set({
      profileUsername: privateRaceUsername,
      timeZone: 'America/Los_Angeles',
      createdAt: now,
      updatedAt: now,
    }),
  ])
  const eligibleRaceSource = await migrationSource(sharingUid, raceSource)
  const revokedRaceSource = await migrationSource(privateUid, revokedAlternateSource)
  await privateUser.collection('settings').doc('bookSharing').delete()
  await assert.rejects(
    db.runTransaction(async (transaction) => {
      await assertMigrationSeedSourcesEligible(transaction, db, [
        eligibleRaceSource,
        revokedRaceSource,
      ])
      transaction.create(db.doc(`works/${revokedSeedWorkId}`), validWork('Revoked Seed', 'revoked seed', [leGuinAuthorId]))
    }),
    /is no longer eligible to publish metadata/,
  )
  assert.equal((await db.doc(`works/${revokedSeedWorkId}`).get()).exists, false)

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
      await assertMigrationSeedSourcesEligible(transaction, db, [authorRaceSource])
    }),
    /changed during migration/,
  )
  await ursulaRef.update({name: 'Ursula K. Le Guin'})

  await sharingUser.collection('settings').doc('bookSharing').delete()
  await raceSource.update({workId})
  await assert.rejects(
    db.runTransaction(async (transaction) => {
      await assertMigrationProjectionSourcesEligible(
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
    profileUsername: username,
    timeZone: 'America/Los_Angeles',
    createdAt: now,
    updatedAt: now,
  })
  await raceSource.update({workId: conflictWorkId})
  await assert.rejects(
    db.runTransaction(async (transaction) => {
      await assertMigrationProjectionSourcesEligible(
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
    db.doc(`profiles/${privateRaceUsername}`).delete(),
  ])

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
    db.doc(`sharedWorkOwners/${stalePrivateProjectionId}`).set({
      workId,
      uid: privateUid,
      updatedAt: now,
    }),
    sharedBook.collection('updates').doc('bad-references').set({
      owner: privateUser,
      book: privateBook,
      type: 'reading',
      timeRead: 60,
      fromPage: 0,
      toPage: 10,
      pagesRead: 10,
      createdAt: now,
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
  assert.match(corruptAudit, new RegExp(`^book-sharing\\.projection-without-consent sharedWorkOwners/${stalePrivateProjectionId}`, 'm'))
  assert.match(corruptAudit, new RegExp(`^update\\.owner-mismatch users/${sharingUid}/books/shared-copy/updates/bad-references`, 'm'))
  assert.match(corruptAudit, new RegExp(`^update\\.book-mismatch users/${sharingUid}/books/shared-copy/updates/bad-references`, 'm'))
  assert.match(corruptAudit, new RegExp(`^catalog\\.book\\.isbn-provenance-mismatch users/${privateUid}/books/private-copy`, 'm'))
})
