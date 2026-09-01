// Build the server-owned work/edition catalog from personal books and add
// explicit catalog-link fields to every personal book. Every live user's
// books seed the catalog — bibliographic data is public whoever added it
// (owner decision 2026-08-31); the operator's copy wins a spelling or
// metadata disagreement. Sharing consent matters only for the reader
// projections (sharedWorkOwners), never for catalog creation.
//
// Ambiguous cases are printed and left unlinked. Operators can resolve an
// exact reviewed set with an optional JSON manifest whose groups contain:
//   { id, bookPaths, canonicalTitle, alternateTitles?, authorNames, authorKinds }
// Book paths are exact users/{uid}/books/{bookId} paths; there is no fuzzy
// exception mechanism.
//
//   node migrate-cross-user-works.ts [reviewed.json]                 # emulator dry-run
//   node migrate-cross-user-works.ts [reviewed.json] --apply         # emulator apply
//   node migrate-cross-user-works.ts [reviewed.json] --prod          # prod dry-run
//   node migrate-cross-user-works.ts [reviewed.json] --prod --apply  # prod apply (typed confirm)
//
// Two more flags:
//   --expect-overlap-groups=N  refuse to run unless the planner finds exactly
//     N migratable groups whose books span more than one account. The reviewed
//     dry-run prints that number; passing it back to the apply turns "the data
//     moved under me" into a refusal instead of a silently different write.
//   --database=ID  target a non-default Firestore database (see migrate-lib.ts).
//     The catalog lives in the default database; the credential database is
//     never a migration target here.
import { readFileSync } from 'node:fs'
import { FieldValue, Timestamp, type DocumentReference, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore'
import { connect, parseFlags } from './migrate-lib.ts'
import {
  deterministicCatalogId,
  deterministicSharedWorkOwnerId,
  deterministicTitleIndexId,
  planCrossUserCatalog,
  type MigrationAmbiguity,
  type MigrationAuthor,
  type MigrationBook,
  type MigrationCandidate,
  type MigrationGroup,
  type CrossUserCatalogPlan,
  type ReviewedWorkGroup,
  assertMigrationProjectionSourcesConsented,
  assertMigrationSourceVersions,
  OPERATOR_UID,
  type MigrationSeedSource,
} from './cross-user-work-migration.ts'
import {
  catalogTitleKeys,
  normalizeCatalogAuthorName,
  normalizeCatalogTitle,
} from './src/lib/utils/catalog.ts'
import { sharingConsentIsValid } from './sharing-consent.ts'

type CatalogDoc = Record<string, unknown>
type ExistingCatalog = {
  authors: Map<string, CatalogDoc>
  works: Map<string, CatalogDoc>
  editions: Map<string, CatalogDoc>
  isbnIndex: Map<string, CatalogDoc>
  titleIndex: Map<string, CatalogDoc>
}

type CatalogTarget = {
  workId: string
  editionIds: Map<string, string>
  createWork: boolean
}

type CreateSpec = {
  ref: DocumentReference
  data: CatalogDoc
  stableKeys: string[]
  seedSources?: MigrationSeedSource[]
}

function catalogCoverUrl(value: unknown): string {
  return typeof value === 'string' && /^https:\/\/[^\s]+$/u.test(value) ? value : ''
}

const rawArgs = process.argv.slice(2)
const overlapExpectations = rawArgs.filter((arg) => arg.startsWith('--expect-overlap-groups='))
if (overlapExpectations.length > 1) throw new Error('--expect-overlap-groups may be specified once')
const expectedOverlapGroups = overlapExpectations.length === 0
  ? null
  : Number(overlapExpectations[0].slice('--expect-overlap-groups='.length))
if (expectedOverlapGroups !== null && (!Number.isSafeInteger(expectedOverlapGroups) || expectedOverlapGroups < 0)) {
  throw new Error('--expect-overlap-groups must be a non-negative integer')
}
const flags = parseFlags(rawArgs.filter((arg) => !arg.startsWith('--expect-overlap-groups=')))
if (flags.rest.length > 1) throw new Error('usage: migrate-cross-user-works.ts [reviewed.json] [--expect-overlap-groups=N] [--prod] [--apply] [--database=ID]')
const reviewedGroups = flags.rest.length === 0
  ? []
  : decodeReviewedManifest(JSON.parse(readFileSync(flags.rest[0], 'utf8')))
const { db } = await connect({ ...flags, confirmWrite: flags.apply })
const tag = flags.apply ? 'SET' : 'DRY'
const existing = await loadCatalog(db)

const users = await db.collection('users').listDocuments()
const profiles = await db.collection('profiles').get()
const profilesByUsername = new Map(profiles.docs.map((profile) => [profile.id, profile.data()]))
const books: MigrationBook[] = []
const liveUsers: DocumentReference[] = []
const authors = new Map<string, MigrationAuthor>()
for (const [authorId, data] of existing.authors) {
  authors.set(authorId, {
    id: authorId,
    name: data.canonicalName,
    kind: data.kind,
    familyName: data.sortName,
    retirement: data.status === 'merged' ? {reason: 'merged', targetId: data.mergedInto} : null,
  })
}

function snapshotVersion(path: string, value: {updateTime?: Timestamp}): number {
  const version = value.updateTime?.toMillis()
  if (version === undefined) throw new Error(`${path} has no Firestore update version`)
  return version
}

function authorVersionsForBook(
  book: CatalogDoc,
  authorDocs: ReadonlyMap<string, {path: string; version: number; data: CatalogDoc}>,
): Array<{path: string; version: number}> {
  const versions = new Map<string, number>()
  const authorIds = Array.isArray(book.authorIds)
    ? book.authorIds.filter((id): id is string => typeof id === 'string')
    : []
  for (const originalId of authorIds) {
    let id = originalId
    const seen = new Set<string>()
    while (!seen.has(id)) {
      seen.add(id)
      const author = authorDocs.get(id)
      if (!author) break
      versions.set(author.path, author.version)
      const retirement = author.data.retirement
      if (!retirement || typeof retirement !== 'object' ||
          (retirement as CatalogDoc).reason !== 'merged') break
      const target = typeof (retirement as CatalogDoc).targetId === 'string'
        ? (retirement as CatalogDoc).targetId
        : (retirement as CatalogDoc).canonicalAuthorId
      if (typeof target !== 'string') break
      id = target
    }
  }
  return [...versions].map(([path, version]) => ({path, version}))
}

for (const userRef of users) {
  const [user, bookDocs, authorDocs, sharing] = await Promise.all([
    userRef.get(),
    userRef.collection('books').get(),
    userRef.collection('authors').get(),
    userRef.collection('settings').doc('bookSharing').get(),
  ])
  const userData = user.data()
  const liveUser = user.exists && userData?.deletedAt === undefined
  // A tombstoned account (SEC-006 soft delete) is frozen for the purge
  // script: its books are neither seeds nor rewrite targets, and its legacy
  // author documents are left exactly as they are.
  if (!liveUser) {
    console.log(`SKIP tombstoned-account ${userRef.path}`)
    continue
  }
  liveUsers.push(userRef)
  const consented = sharingConsentIsValid(userData, sharing.data())
  const seedPriority = userRef.id === OPERATOR_UID ? 0 : 1
  const localAuthorDocs = new Map(authorDocs.docs.map((author) => [author.id, {
    path: author.ref.path,
    version: snapshotVersion(author.ref.path, author),
    data: author.data(),
  }]))

  for (const author of authorDocs.docs) {
    const data = author.data()
    authors.set(`${userRef.id}:${author.id}`, {
      id: `${userRef.id}:${author.id}`,
      name: data.name,
      kind: data.kind,
      familyName: data.familyName,
      retirement: data.retirement && typeof data.retirement === 'object'
        ? {
            ...(data.retirement as Record<string, unknown>),
            targetId: typeof (data.retirement as Record<string, unknown>).targetId === 'string'
              ? `${userRef.id}:${String((data.retirement as Record<string, unknown>).targetId)}`
              : (data.retirement as Record<string, unknown>).targetId,
            canonicalAuthorId: typeof (data.retirement as Record<string, unknown>).canonicalAuthorId === 'string'
              ? `${userRef.id}:${String((data.retirement as Record<string, unknown>).canonicalAuthorId)}`
              : (data.retirement as Record<string, unknown>).canonicalAuthorId,
          }
        : null,
    })
  }
  for (const book of bookDocs.docs) {
    const data = book.data()
    books.push({
      ...data,
      path: book.ref.path,
      uid: userRef.id,
      authorIds: Array.isArray(data.authorIds)
        ? data.authorIds.map((id: unknown) => typeof id === 'string' && !existing.authors.has(id) ? `${userRef.id}:${id}` : id)
        : data.authorIds,
      sharingConsented: consented,
      seedPriority,
      migrationBookVersion: snapshotVersion(book.ref.path, book),
      migrationAuthorVersions: authorVersionsForBook(data, localAuthorDocs),
    })
  }
}

const plan = planCrossUserCatalog(books, authors, reviewedGroups)
const ambiguities: MigrationAmbiguity[] = [...plan.ambiguities]
const blocked = new Set(ambiguities.flatMap((ambiguity) => ambiguity.bookPaths))
const targets = new Map<string, CatalogTarget>()

for (const group of plan.groups) {
  if (group.candidates.some((candidate) => blocked.has(candidate.book.path))) continue
  const target = chooseCatalogTarget(group, existing, ambiguities)
  if (target !== null) targets.set(group.key, target)
}
for (const ambiguity of ambiguities) for (const path of ambiguity.bookPaths) blocked.add(path)
const overlapGroups = plan.groups.filter((group) =>
  targets.has(group.key) &&
  !group.candidates.some((candidate) => blocked.has(candidate.book.path)) &&
  new Set(group.candidates.map((candidate) => candidate.book.uid)).size > 1,
)
if (expectedOverlapGroups !== null && overlapGroups.length !== expectedOverlapGroups) {
  throw new Error(`expected ${expectedOverlapGroups} migratable cross-user overlap groups, planner found ${overlapGroups.length}`)
}
if (expectedOverlapGroups !== null) console.log(`ACCEPT ${overlapGroups.length} cross-user overlap groups`)

// An active catalog author that already carries a planned name key under a
// different document id (admin-renamed, or minted by ensureauthors under its
// random-id fallback) would leave the catalog with two active identities for
// one name, and every later ensureauthors call for that name would refuse as
// ambiguous. Nothing here can choose between them; stop for the operator.
const activeKeyOwners = new Map<string, string>()
for (const [authorId, data] of existing.authors) {
  if (data.status !== 'active' || !Array.isArray(data.nameKeys)) continue
  for (const key of data.nameKeys) if (typeof key === 'string') activeKeyOwners.set(key, authorId)
}
for (const author of plan.authors) {
  for (const key of author.nameKeys) {
    const owner = activeKeyOwners.get(key)
    if (owner !== undefined && owner !== author.authorId) {
      throw new Error(`catalogAuthors/${owner} already owns name key "${key}" planned for ${author.authorId}; merge or rename it before migrating`)
    }
  }
}

const createSets: CreateSpec[][] = []
const authorSpecs = plan.authors.filter((author) => !existing.authors.has(author.authorId)).map((author) => {
  const directSource = plan.candidates.find((candidate) => candidate.personalAuthors.some(
    (candidateAuthor) => (candidateAuthor.catalogId ?? deterministicCatalogId(
      'author', normalizeCatalogAuthorName(candidateAuthor.name),
    )) === author.authorId,
  ))
  // A reviewed manifest may correct every source spelling. In that case the
  // canonical author name is intentionally absent from the personal author
  // rows, so pin creation to one book in the reviewed group instead.
  const source = directSource ?? plan.groups.find((group) =>
    group.authorIds.includes(author.authorId),
  )?.candidates[0]
  if (!source) throw new Error(`planner omitted a source for catalog author ${author.authorId}`)
  return catalogAuthorCreateSpec(db, author, migrationSource(source.book))
})
let catalogWrites = 0

for (const spec of authorSpecs) {
  const existingSnapshot = await spec.ref.get()
  if (!existingSnapshot.exists) {
    catalogWrites += 1
    console.log(`${tag}  create ${spec.ref.path}`)
  } else {
    assertStableFields(spec.ref.path, existingData(existingSnapshot), spec.data, spec.stableKeys)
  }
  if (flags.apply && !existingSnapshot.exists) {
    await db.runTransaction(async (transaction) => {
      const current = await transaction.get(spec.ref)
      if (current.exists) {
        assertStableFields(spec.ref.path, existingData(current), spec.data, spec.stableKeys)
        return
      }
      if (!spec.seedSources) throw new Error(`${spec.ref.path} has no identity source`)
      await assertMigrationSourceVersions(transaction, db, spec.seedSources)
      transaction.create(spec.ref, spec.data)
    })
  }
}

for (const group of plan.groups) {
  const target = targets.get(group.key)
  if (!target) continue
  const specs = [
    ...(target.createWork ? [
      ...workCreateSpecs(db, group, target.workId),
    ] : []),
    ...editionCreateSpecs(db, group, target, existing),
  ]
  if (specs.length > 0) createSets.push([...new Map(specs.map((spec) => [spec.ref.path, spec])).values()])
}

const uniqueCreates = new Map(createSets.flat().map((spec) => [spec.ref.path, spec]))
for (const spec of uniqueCreates.values()) {
  const existingSnapshot = await spec.ref.get()
  if (!existingSnapshot.exists) {
    catalogWrites += 1
    console.log(`${tag}  create ${spec.ref.path}`)
  } else {
    assertStableFields(spec.ref.path, existingData(existingSnapshot), spec.data, spec.stableKeys)
  }
}

if (flags.apply) {
  for (const specs of createSets) {
    await db.runTransaction(async (transaction) => {
      const snapshots = await Promise.all(specs.map((spec) => transaction.get(spec.ref)))
      const newSpecs = specs.filter((_, index) => !snapshots[index].exists)
      const seedSources = newSpecs.flatMap((spec) => {
        if (!spec.seedSources || spec.seedSources.length === 0) {
          throw new Error(`${spec.ref.path} has no catalog seed source`)
        }
        return spec.seedSources
      })
      await assertMigrationSourceVersions(transaction, db, seedSources)
      for (let index = 0; index < specs.length; index += 1) {
        const spec = specs[index]
        const snapshot = snapshots[index]
        if (snapshot.exists) assertStableFields(spec.ref.path, existingData(snapshot), spec.data, spec.stableKeys)
        else transaction.create(spec.ref, spec.data)
      }
    })
  }
}

let bookWrites = 0
let bookConflicts = 0
const projectionSpecs = new Map<string, CreateSpec>()
const candidatesByPath = new Map(plan.candidates.map((candidate) => [candidate.book.path, candidate]))
for (const book of books.sort((left, right) => left.path.localeCompare(right.path))) {
  const candidate = candidatesByPath.get(book.path)
  if (!candidate) throw new Error(`planner omitted ${book.path}`)
  const group = plan.groups.find((item) => item.candidates.some((itemCandidate) => itemCandidate.book.path === book.path))
  const target = group && !blocked.has(book.path) ? targets.get(group.key) : undefined
  const desiredLink = target ? linkedPatch(candidate, target) : nullPatch()
  const state = linkState(book)
  let linkPatch: CatalogDoc = {}
  if (state === 'invalid') {
    ambiguities.push({ type: 'invalid-existing-link', bookPaths: [book.path], detail: 'Catalog link fields are partial or malformed' })
  } else if (state === 'linked') {
    if (book.sharingConsented === true && typeof book.workId === 'string') {
      addSharedWorkOwnerSpec(projectionSpecs, db, book.workId, migrationSource(book))
    }
    if (!sameLink(book, desiredLink)) {
      ambiguities.push({ type: 'existing-link-conflict', bookPaths: [book.path], detail: 'Migration will not replace an existing catalog link' })
      bookConflicts += 1
    }
  } else if (!sameLink(book, desiredLink)) {
    linkPatch = desiredLink
  }
  if (state !== 'linked' && book.sharingConsented === true && typeof desiredLink.workId === 'string') {
    addSharedWorkOwnerSpec(projectionSpecs, db, desiredLink.workId, migrationSource(book))
  }
  const authorPatch = candidate.authorProblems.length === 0 && !sameAuthorship(book, candidate)
    ? {authorIds: candidate.personalAuthorIds, author: FieldValue.delete(), authors: FieldValue.delete()}
    : {}
  const desired = {...linkPatch, ...authorPatch}
  if (Object.keys(desired).length === 0) continue
  bookWrites += 1
  console.log(`${tag}  update ${book.path}${Object.keys(linkPatch).length > 0 ? ` catalog link -> ${desiredLink.workId ?? 'null'}` : ''}${Object.keys(authorPatch).length > 0 ? ' shared authors' : ''}`)
  if (flags.apply) {
    const ref = db.doc(book.path)
    await db.runTransaction(async (transaction) => {
      await assertMigrationSourceVersions(transaction, db, [migrationSource(book)])
      const current = await transaction.get(ref)
      if (!current.exists) throw new Error(`${book.path} disappeared during migration`)
      if (!sameInitialLink(existingData(current), book)) throw new Error(`${book.path} catalog link changed during migration`)
      transaction.update(ref, desired)
    })
  }
}

// Legacy per-user author documents are retained, not deleted (soft-delete
// policy, SEC-006): once no book references them they are unreachable —
// Rules keep them owner-readable only, the client no longer lists them —
// and db-audit counts them so the drift stays visible until a purge is
// decided separately. The migration only proves that nothing still points
// at them; a lingering reference is a REVIEW line, never a deletion.
let legacyAuthorsRetained = 0
let legacyAuthorsStillReferenced = 0
for (const userRef of liveUsers) {
  const plannedBooks = plan.candidates.filter((candidate) => candidate.book.uid === userRef.id)
  const localAuthors = await userRef.collection('authors').get()
  if (localAuthors.empty) continue
  legacyAuthorsRetained += localAuthors.size
  if (plannedBooks.some((candidate) => candidate.authorProblems.length > 0)) {
    legacyAuthorsStillReferenced += localAuthors.size
    console.log(`REVIEW legacy-authors-still-referenced ${userRef.path} :: unresolved personal author reference keeps ${localAuthors.size} legacy author documents live`)
    continue
  }
  if (flags.apply) {
    const currentBooks = await userRef.collection('books').get()
    const localIds = new Set(localAuthors.docs.map((snapshot) => snapshot.id))
    for (const snapshot of currentBooks.docs) {
      const data = snapshot.data()
      if (data.author !== undefined || data.authors !== undefined ||
          !Array.isArray(data.authorIds) || data.authorIds.some((id) => localIds.has(id))) {
        throw new Error(`${snapshot.ref.path} still references the legacy author collection after apply`)
      }
    }
  }
}

for (const spec of projectionSpecs.values()) {
  const snapshot = await spec.ref.get()
  if (!snapshot.exists) catalogWrites += 1
  else assertStableFields(spec.ref.path, existingData(snapshot), spec.data, spec.stableKeys)
  if (!snapshot.exists) console.log(`${tag}  create ${spec.ref.path}`)
  if (flags.apply) {
    await db.runTransaction(async (transaction) => {
      const current = await transaction.get(spec.ref)
      if (current.exists) {
        assertStableFields(spec.ref.path, existingData(current), spec.data, spec.stableKeys)
      } else {
        if (!spec.seedSources) throw new Error(`${spec.ref.path} has no sharing projection source`)
        await assertMigrationProjectionSourcesConsented(
          transaction,
          db,
          spec.seedSources,
          String(spec.data.workId),
        )
        transaction.create(spec.ref, spec.data)
      }
    })
  }
}

for (const ambiguity of ambiguities.sort((left, right) => left.type.localeCompare(right.type) || left.bookPaths.join().localeCompare(right.bookPaths.join()))) {
  console.log(`REVIEW ${ambiguity.type} ${ambiguity.bookPaths.join(',')} :: ${ambiguity.detail}`)
}
console.log(`${catalogWrites} catalog documents ${flags.apply ? 'created' : '(dry run, nothing written)'}`)
console.log(`${bookWrites} personal books ${flags.apply ? 'updated' : '(dry run, nothing written)'}`)
console.log(`${legacyAuthorsRetained} legacy author documents retained (${legacyAuthorsStillReferenced} still referenced by unresolved books); nothing is ever deleted`)
console.log(`${ambiguities.length} reviewed ambiguities; ${bookConflicts} existing-link conflicts`)

function decodeReviewedManifest(value: unknown): ReviewedWorkGroup[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { groups?: unknown }).groups)) {
    throw new Error('review manifest must be an object with a groups array')
  }
  return (value as { groups: unknown[] }).groups.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`review group ${index} must be an object`)
    const group = item as Record<string, unknown>
    if (typeof group.id !== 'string' || typeof group.canonicalTitle !== 'string') throw new Error(`review group ${index} needs string id and canonicalTitle`)
    if (!Array.isArray(group.bookPaths) || !group.bookPaths.every((path) => typeof path === 'string')) throw new Error(`review group ${index}.bookPaths must be strings`)
    if (!Array.isArray(group.authorNames) || !group.authorNames.every((name) => typeof name === 'string')) throw new Error(`review group ${index}.authorNames must be strings`)
    if (!Array.isArray(group.authorKinds) || group.authorKinds.length !== group.authorNames.length ||
        !group.authorKinds.every((kind) => kind === 'person' || kind === 'entity' || kind === 'placeholder')) {
      throw new Error(`review group ${index}.authorKinds must match authorNames and use person, entity, or placeholder`)
    }
    const reviewedKinds = new Map<string, string>()
    for (const [authorIndex, name] of group.authorNames.entries()) {
      const key = normalizeCatalogAuthorName(name)
      if (!key) throw new Error(`review group ${index}.authorNames must be non-empty`)
      const kind = group.authorKinds[authorIndex] as string
      const existingKind = reviewedKinds.get(key)
      if (existingKind && existingKind !== kind) {
        throw new Error(`review group ${index} gives one author conflicting kinds`)
      }
      reviewedKinds.set(key, kind)
    }
    if (group.alternateTitles !== undefined && (!Array.isArray(group.alternateTitles) || !group.alternateTitles.every((title) => typeof title === 'string'))) {
      throw new Error(`review group ${index}.alternateTitles must be strings`)
    }
    return {
      id: group.id,
      bookPaths: group.bookPaths as string[],
      canonicalTitle: group.canonicalTitle,
      alternateTitles: group.alternateTitles as string[] | undefined,
      authorNames: group.authorNames as string[],
      authorKinds: group.authorKinds as ReviewedWorkGroup['authorKinds'],
    }
  })
}

async function loadCatalog(db: Firestore): Promise<ExistingCatalog> {
  const [authors, works, editions, isbnIndex, titleIndex] = await Promise.all([
    db.collection('catalogAuthors').get(),
    db.collection('works').get(),
    db.collection('editions').get(),
    db.collection('isbnIndex').get(),
    db.collection('workTitleIndex').get(),
  ])
  return {
    authors: new Map(authors.docs.map((doc) => [doc.id, doc.data()])),
    works: new Map(works.docs.map((doc) => [doc.id, doc.data()])),
    editions: new Map(editions.docs.map((doc) => [doc.id, doc.data()])),
    isbnIndex: new Map(isbnIndex.docs.map((doc) => [doc.id, doc.data()])),
    titleIndex: new Map(titleIndex.docs.map((doc) => [doc.id, doc.data()])),
  }
}

function resolveWorkId(workId: string, works: ReadonlyMap<string, CatalogDoc>): string {
  const work = works.get(workId)
  if (!work) throw new Error(`catalog work ${workId} does not exist`)
  if (work.status !== 'merged') return workId
  if (typeof work.mergedInto !== 'string') throw new Error(`merged work ${workId} has no mergedInto`)
  const target = works.get(work.mergedInto)
  if (!target || target.status !== 'active') throw new Error(`merged work ${workId} does not point directly to an active work`)
  return work.mergedInto
}

function chooseCatalogTarget(group: MigrationGroup, existing: ExistingCatalog, ambiguities: MigrationAmbiguity[]): CatalogTarget | null {
  const isbnTargets = new Set<string>()
  for (const isbn of group.isbns) {
    const entry = existing.isbnIndex.get(isbn)
    if (typeof entry?.workId === 'string') isbnTargets.add(resolveWorkId(entry.workId, existing.works))
  }
  if (isbnTargets.size > 1) {
    ambiguities.push({ type: 'existing-isbn-conflict', bookPaths: group.candidates.map((candidate) => candidate.book.path), detail: `ISBNs point to multiple works: ${[...isbnTargets].join(', ')}` })
    return null
  }

  let workId = [...isbnTargets][0]
  if (workId) {
    // resolveWorkId only returns an id it read from existing.works.
    const work = existing.works.get(workId)
    if (work === undefined) throw new Error(`catalog work ${workId} disappeared while planning`)
    const workTitleKeys = Array.isArray(work.titleKeys) ? work.titleKeys : []
    const textMatches = group.candidates.some((candidate) => workTitleKeys.includes(candidate.titleKey))
    const authorMatches = JSON.stringify([...group.authorIds].sort()) ===
      JSON.stringify(Array.isArray(work.authorIds) ? work.authorIds.filter((id): id is string => typeof id === 'string').sort() : [])
    if (!textMatches || !authorMatches) {
      ambiguities.push({ type: 'existing-isbn-text-conflict', bookPaths: group.candidates.map((candidate) => candidate.book.path), detail: `ISBN points to ${workId}, whose title/authors disagree` })
      return null
    }
  } else {
    const textTargets = [...existing.works.entries()].filter(([, work]) =>
      work.status === 'active' &&
      group.candidates.some((candidate) => (Array.isArray(work.titleKeys) ? work.titleKeys : []).includes(candidate.titleKey)) &&
      JSON.stringify([...group.authorIds].sort()) ===
        JSON.stringify(Array.isArray(work.authorIds) ? work.authorIds.filter((id): id is string => typeof id === 'string').sort() : [])
    )
    if (textTargets.length > 1) {
      ambiguities.push({ type: 'existing-title-conflict', bookPaths: group.candidates.map((candidate) => candidate.book.path), detail: `Title/authors match multiple works: ${textTargets.map(([id]) => id).join(', ')}` })
      return null
    }
    workId = textTargets[0]?.[0]
  }

  if (!workId) workId = group.workId
  const editionIds = new Map<string, string>()
  for (const isbn of group.isbns) {
    const indexed = existing.isbnIndex.get(isbn)
    if (typeof indexed?.editionId === 'string') {
      editionIds.set(isbn, indexed.editionId)
      continue
    }
    const matchingEditions = [...existing.editions.entries()].filter(([, edition]) =>
      edition.isbn13 === isbn && typeof edition.workId === 'string' && resolveWorkId(edition.workId, existing.works) === workId
    )
    if (matchingEditions.length > 1) {
      ambiguities.push({ type: 'duplicate-edition-isbn', bookPaths: group.candidates.map((candidate) => candidate.book.path), detail: `${isbn} has multiple editions in ${workId}` })
      return null
    }
    const existingEditionId = matchingEditions[0]?.[0]
    if (existingEditionId) editionIds.set(isbn, existingEditionId)
    else editionIds.set(isbn, deterministicCatalogId('edition', `${workId}\0${isbn}`))
  }
  return { workId, editionIds, createWork: !existing.works.has(workId) }
}

function workCreateSpecs(db: Firestore, group: MigrationGroup, workId: string): CreateSpec[] {
  const now = Timestamp.now()
  const titleKeys = catalogTitleKeys(group.canonicalTitle, group.alternateTitles)
  const preferred = preferredSeedCandidate(group)
  const seedSources = migrationGroupSeedSources(group)
  const work: CatalogDoc = {
    canonicalTitle: group.canonicalTitle,
    alternateTitles: group.alternateTitles,
    titleKeys,
    authorIds: group.authorIds,
    coverUrl: catalogCoverUrl(preferred.book.coverUrl),
    subjects: Array.isArray(preferred.book.subjects) ? preferred.book.subjects.filter((subject): subject is string => typeof subject === 'string') : [],
    fiction: typeof preferred.book.fiction === 'boolean' ? preferred.book.fiction : null,
    status: 'active',
    mergedFrom: [],
    createdAt: now,
    updatedAt: now,
  }
  const specs: CreateSpec[] = [{
    ref: db.collection('works').doc(workId),
    data: work,
    stableKeys: Object.keys(work).filter((key) => key !== 'createdAt' && key !== 'updatedAt'),
    seedSources,
  }]
  for (const [index, titleKey] of titleKeys.entries()) {
    // catalogTitleKeys() derives every key from exactly these titles, so a
    // key with no title is a normalization disagreement, not a title to
    // guess at: indexing it under the canonical title would make the row
    // unfindable by the title that produced it.
    const alternate = group.alternateTitles.find(
      (candidate) => normalizeCatalogTitle(candidate) === titleKey,
    )
    if (index > 0 && alternate === undefined) {
      throw new Error(`title key "${titleKey}" of ${workId} matches no title of the group`)
    }
    const title = index === 0 ? group.canonicalTitle : alternate as string
    specs.push({
      ref: db.collection('workTitleIndex').doc(deterministicTitleIndexId(workId, titleKey)),
      data: { workId, title, titleKey, status: 'active' },
      stableKeys: ['workId', 'title', 'titleKey', 'status'],
      seedSources,
    })
  }
  return specs
}

function catalogAuthorCreateSpec(
  db: Firestore,
  author: CrossUserCatalogPlan['authors'][number],
  seedSource: MigrationSeedSource,
): CreateSpec {
  const now = Timestamp.now()
  const data: CatalogDoc = {
    canonicalName: author.canonicalName,
    alternateNames: author.alternateNames,
    nameKeys: author.nameKeys,
    sortName: author.sortName,
    kind: author.kind,
    status: 'active',
    mergedFrom: [],
    createdAt: now,
    updatedAt: now,
  }
  return {
    ref: db.collection('catalogAuthors').doc(author.authorId),
    data,
    stableKeys: Object.keys(data).filter((key) => key !== 'createdAt' && key !== 'updatedAt'),
    seedSources: [seedSource],
  }
}

function editionCreateSpecs(db: Firestore, group: MigrationGroup, target: CatalogTarget, existing: ExistingCatalog): CreateSpec[] {
  const specs: CreateSpec[] = []
  const seedSources = migrationGroupSeedSources(group)
  for (const isbn of group.isbns) {
    const candidate = preferredSeedCandidate(group, (item) => item.isbn13 === isbn)
    if (!candidate) throw new Error(`missing edition source for ${isbn}`)
    const editionId = target.editionIds.get(isbn)
    if (!editionId) throw new Error(`missing edition id for ${isbn}`)
    if (!existing.editions.has(editionId)) {
      const edition: CatalogDoc = {
        workId: target.workId,
        isbn13: isbn,
        title: candidate.title,
        publisher: typeof candidate.book.publisher === 'string' ? candidate.book.publisher : '',
        publishedDate: typeof candidate.book.publishedDate === 'string' ? candidate.book.publishedDate : '',
        language: '',
        translatorNames: [],
        format: 'unknown',
        suggestedPageCount: typeof candidate.book.pageCount === 'number' && candidate.book.pageCount > 0 ? candidate.book.pageCount : null,
        coverUrl: catalogCoverUrl(candidate.book.coverUrl),
        externalIds: {},
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      }
      specs.push({ ref: db.collection('editions').doc(editionId), data: edition, stableKeys: Object.keys(edition).filter((key) => key !== 'createdAt' && key !== 'updatedAt'), seedSources })
    }
    specs.push({
      ref: db.collection('isbnIndex').doc(isbn),
      data: { workId: target.workId, editionId },
      stableKeys: ['workId', 'editionId'],
      seedSources,
    })
  }
  return specs
}

function preferredSeedCandidate(
  group: MigrationGroup,
  predicate: (candidate: MigrationCandidate) => boolean = () => true,
): MigrationCandidate {
  const candidates = group.candidates
    .filter(predicate)
    .sort((left, right) =>
      left.book.seedPriority - right.book.seedPriority ||
      left.book.path.localeCompare(right.book.path),
    )
  const preferred = candidates[0]
  if (!preferred) throw new Error(`migration group ${group.key} has no metadata source`)
  return preferred
}

function migrationGroupSeedSources(group: MigrationGroup): MigrationSeedSource[] {
  return group.candidates.map((candidate) => migrationSource(candidate.book))
}

function migrationSource(book: MigrationBook): MigrationSeedSource {
  if (book.migrationBookVersion === undefined || book.migrationAuthorVersions === undefined) {
    throw new Error(`${book.path} has no captured migration identity version`)
  }
  return {
    uid: book.uid,
    bookPath: book.path,
    bookVersion: book.migrationBookVersion,
    authorVersions: book.migrationAuthorVersions,
  }
}

// data() is undefined only when the snapshot does not exist, which every
// caller has already ruled out; the fallback would have compared a created
// document against an empty one and reported no conflict.
function existingData(snapshot: DocumentSnapshot): CatalogDoc {
  const data = snapshot.data()
  if (data === undefined) throw new Error(`${snapshot.ref.path} exists without data`)
  return data
}

function assertStableFields(path: string, actual: CatalogDoc, expected: CatalogDoc, keys: string[]): void {
  for (const key of keys) {
    if (JSON.stringify(actual[key]) !== JSON.stringify(expected[key])) {
      throw new Error(`${path}.${key} conflicts with deterministic migration output`)
    }
  }
}

function linkedPatch(candidate: MigrationCandidate, target: CatalogTarget): CatalogDoc {
  const editionId = candidate.isbn13 ? target.editionIds.get(candidate.isbn13) ?? null : null
  return {
    workId: target.workId,
    editionId,
    matchMethod: editionId === null ? 'migration' : 'isbn',
    linkedAt: Timestamp.now(),
  }
}

function sharedWorkOwnerSpec(
  db: Firestore,
  workId: string,
  source: MigrationSeedSource,
): CreateSpec {
  const {uid} = source
  const id = deterministicSharedWorkOwnerId(workId, uid)
  return {
    ref: db.collection('sharedWorkOwners').doc(id),
    data: {workId, uid, updatedAt: Timestamp.now()},
    stableKeys: ['workId', 'uid'],
    seedSources: [source],
  }
}

function addSharedWorkOwnerSpec(
  specs: Map<string, CreateSpec>,
  db: Firestore,
  workId: string,
  source: MigrationSeedSource,
): void {
  const spec = sharedWorkOwnerSpec(db, workId, source)
  const existing = specs.get(spec.ref.path)
  if (!existing) {
    specs.set(spec.ref.path, spec)
    return
  }
  existing.seedSources = [...(existing.seedSources ?? []), ...(spec.seedSources ?? [])]
}

function nullPatch(): CatalogDoc {
  return { workId: null, editionId: null, matchMethod: null, linkedAt: null }
}

function linkState(book: Record<string, unknown>): 'absent' | 'null' | 'linked' | 'invalid' {
  const keys = ['workId', 'editionId', 'matchMethod', 'linkedAt']
  if (keys.every((key) => !(key in book))) return 'absent'
  if (keys.every((key) => key in book && book[key] === null)) return 'null'
  if (typeof book.workId === 'string' && (typeof book.editionId === 'string' || book.editionId === null) && typeof book.matchMethod === 'string' && book.linkedAt instanceof Timestamp) return 'linked'
  return 'invalid'
}

function sameLink(actual: Record<string, unknown>, desired: CatalogDoc): boolean {
  return actual.workId === desired.workId && actual.editionId === desired.editionId && actual.matchMethod === desired.matchMethod &&
    ((actual.linkedAt === null && desired.linkedAt === null) || (actual.linkedAt instanceof Timestamp && desired.linkedAt instanceof Timestamp))
}

function sameInitialLink(current: CatalogDoc, initial: CatalogDoc): boolean {
  for (const key of ['workId', 'editionId', 'matchMethod', 'linkedAt']) {
    const currentHas = key in current
    const initialHas = key in initial
    if (currentHas !== initialHas) return false
    const left = current[key]
    const right = initial[key]
    if (left instanceof Timestamp && right instanceof Timestamp ? !left.isEqual(right) : left !== right) return false
  }
  return true
}

function sameAuthorship(book: MigrationBook, candidate: MigrationCandidate): boolean {
  if ('author' in book || 'authors' in book || !Array.isArray(book.authorIds)) return false
  const currentIds = book.authorIds.map((id) => {
    if (typeof id !== 'string') return null
    const separator = id.indexOf(':')
    return separator === -1 ? id : id.slice(separator + 1)
  })
  return currentIds.every((id): id is string => id !== null) &&
    JSON.stringify(currentIds) === JSON.stringify(candidate.personalAuthorIds)
}
