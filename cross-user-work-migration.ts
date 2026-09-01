import { createHash } from 'node:crypto'
import type { DocumentSnapshot, Firestore, Transaction } from 'firebase-admin/firestore'
import { normalizeCatalogAuthorName, normalizeCatalogTitle } from './src/lib/utils/catalog.ts'
import { normalizeIsbn } from './src/lib/utils/isbn.ts'
import { sharingConsentIsValid } from './sharing-consent.ts'

// The operator's copy wins a spelling or metadata disagreement between two
// users' copies of the same book (seedPriority 0 against 1).
export const OPERATOR_UID = '1Cf0CaNfgnVSvTrF5dYjzRd9Xri2'

// What a created catalog document was derived from: the exact personal book
// and per-user author documents, at the Firestore versions the planner read.
// Re-checked inside the write transaction so a concurrent edit to the
// identity a document is built from aborts the create instead of freezing a
// stale spelling into the shared catalog.
export type MigrationSeedSource = {
  uid: string
  bookPath: string
  bookVersion: number
  authorVersions: Array<{path: string; version: number}>
}

export type MigrationAuthor = {
  id: string
  name?: unknown
  kind?: unknown
  familyName?: unknown
  retirement?: { reason?: unknown; targetId?: unknown; canonicalAuthorId?: unknown } | null
}

export type MigrationBook = {
  path: string
  uid: string
  title?: unknown
  isbn?: unknown
  pageCount?: unknown
  authorIds?: unknown
  author?: unknown
  authors?: unknown
  publisher?: unknown
  publishedDate?: unknown
  coverUrl?: unknown
  subjects?: unknown
  fiction?: unknown
  sharingConsented?: boolean
  // 0 for the operator's copy, 1 for everyone else: which spelling and
  // metadata becomes canonical when copies disagree. Every live user's
  // book seeds the catalog (catalog data is public).
  seedPriority: number
  workId?: unknown
  editionId?: unknown
  matchMethod?: unknown
  linkedAt?: unknown
  migrationBookVersion?: number
  migrationAuthorVersions?: Array<{path: string; version: number}>
}

export type ReviewedWorkGroup = {
  id: string
  bookPaths: string[]
  canonicalTitle: string
  alternateTitles?: string[]
  authorNames: string[]
  authorKinds: Array<'person' | 'entity' | 'placeholder'>
}

type ReviewedAuthor = {
  name: string
  kind: 'person' | 'entity' | 'placeholder'
}

export type MigrationCandidate = {
  book: MigrationBook
  title: string
  titleKey: string
  authorNames: string[]
  personalAuthors: Array<{name: string; kind: 'person' | 'entity' | 'placeholder'; sortName: string; catalogId?: string}>
  personalAuthorIds: string[]
  authorProblems: string[]
  isbn13: string | null
  identityKey: string | null
  reviewedGroupId: string | null
  problems: string[]
}

export type MigrationGroup = {
  key: string
  candidates: MigrationCandidate[]
  canonicalTitle: string
  alternateTitles: string[]
  authorNames: string[]
  authorIds: string[]
  isbns: string[]
  workId: string
  editionIds: Record<string, string>
  reviewedGroupId: string | null
}

export type MigrationCatalogAuthor = {
  authorId: string
  canonicalName: string
  alternateNames: string[]
  nameKeys: string[]
  sortName: string
  kind: 'person' | 'entity' | 'placeholder'
}

export type MigrationAmbiguity = {
  type: string
  bookPaths: string[]
  detail: string
}

export type CrossUserCatalogPlan = {
  candidates: MigrationCandidate[]
  authors: MigrationCatalogAuthor[]
  groups: MigrationGroup[]
  ambiguities: MigrationAmbiguity[]
}

const MAX_PERSONAL_BOOK_AUTHORS = 6
const MAX_WORK_AUTHORS = 20

export const deterministicCatalogId = (prefix: 'author' | 'work' | 'edition' | 'title', key: string): string => {
  const digest = createHash('sha256').update(`${prefix}\0${key}`).digest('hex').slice(0, 24)
  return `${prefix}_${digest}`
}

export const deterministicTitleIndexId = (workId: string, titleKey: string): string =>
  createHash('sha256').update(`${workId}\0${titleKey}`).digest('hex')

// The two ids the backend also mints (catalogProjection.sharedWorkOwnerId and
// catalog.externalIndexId). They live here so the migration and the audit
// share one copy; test-fixtures/catalog-ids.json pins the digests both sides
// must produce.
export const deterministicSharedWorkOwnerId = (workId: string, uid: string): string =>
  createHash('sha256').update(`${workId}\0${uid}`).digest('hex')

export const deterministicExternalIndexId = (provider: string, externalId: string): string =>
  createHash('sha256').update(`${provider}\0${externalId}`).digest('hex')

const cleanNames = (names: string[], includePlaceholders = false): string[] => {
  const byKey = new Map<string, string>()
  for (const name of names) {
    const trimmed = name.trim()
    const key = normalizeCatalogAuthorName(trimmed)
    if (key && (includePlaceholders || key !== 'various authors') && !byKey.has(key)) byKey.set(key, trimmed)
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, name]) => name)
}

const cleanReviewedAuthors = (group: ReviewedWorkGroup): { authors: ReviewedAuthor[]; problem: string | null } => {
  if (!Array.isArray(group.authorKinds) || group.authorKinds.length !== group.authorNames.length) {
    return { authors: [], problem: 'authorKinds must match authorNames' }
  }
  const byKey = new Map<string, ReviewedAuthor>()
  for (const [index, rawName] of group.authorNames.entries()) {
    const name = rawName.trim()
    const key = normalizeCatalogAuthorName(name)
    const kind = group.authorKinds[index]
    if (!key) return { authors: [], problem: `authorNames[${index}] must be non-empty` }
    if (kind !== 'person' && kind !== 'entity' && kind !== 'placeholder') {
      return { authors: [], problem: `authorKinds[${index}] is invalid` }
    }
    // The reviewed kind is authoritative. The migration's own heuristic
    // reads the name "Various Authors" as a placeholder, but a manifest
    // that classifies it as an entity means the operator decided that name
    // is the work's identity; only a reviewed placeholder is dropped.
    if (kind === 'placeholder') continue
    const existing = byKey.get(key)
    if (existing && existing.kind !== kind) {
      return { authors: [], problem: `Conflicting kinds for reviewed author ${name}` }
    }
    if (!existing) byKey.set(key, { name, kind })
  }
  return {
    authors: [...byKey.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, author]) => author),
    problem: null,
  }
}

const cleanTitles = (titles: string[]): string[] => {
  const byKey = new Map<string, string>()
  for (const title of titles) {
    const trimmed = title.trim()
    const key = normalizeCatalogTitle(trimmed)
    if (key && !byKey.has(key)) byKey.set(key, trimmed)
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, title]) => title)
}

const legacyAuthorNames = (book: MigrationBook): string[] => {
  const embedded = Array.isArray(book.authors)
    ? book.authors.flatMap((value) => {
        if (typeof value === 'string') return [value]
        if (value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string') {
          return [(value as { name: string }).name]
        }
        return []
      })
    : []
  return cleanNames([...embedded, ...(typeof book.author === 'string' ? [book.author] : [])], true)
}

const resolvedPersonalAuthors = (
  book: MigrationBook,
  authorsById: ReadonlyMap<string, MigrationAuthor>,
): { authors: MigrationCandidate['personalAuthors']; problems: string[] } => {
  // A non-string id is a schema violation, not a value to drop: dropping it
  // would rewrite the book with fewer authors than the client displays.
  const ids: string[] = []
  const idProblems: string[] = []
  if (Array.isArray(book.authorIds)) {
    for (const [index, value] of book.authorIds.entries()) {
      if (typeof value === 'string') ids.push(value)
      else idProblems.push(`non-string-author-id:${index}`)
    }
  }
  if (ids.length === 0 && idProblems.length === 0) {
    return {
      authors: cleanNames(legacyAuthorNames(book), true).map((name) => {
        const kind = normalizeCatalogAuthorName(name) === 'various authors' ? 'placeholder' as const : 'person' as const
        return {name, kind, sortName: name}
      }),
      problems: [],
    }
  }

  const resolved: MigrationCandidate['personalAuthors'] = []
  const problems: string[] = [...idProblems]
  for (const originalId of ids) {
    let id = originalId
    const seen = new Set<string>()
    while (true) {
      if (seen.has(id)) {
        problems.push(`author-cycle:${originalId}`)
        break
      }
      seen.add(id)
      const author = authorsById.get(id)
      if (!author) {
        problems.push(`missing-author:${id}`)
        break
      }
      const retirement = author.retirement
      if (retirement?.reason === 'merged') {
        const targetId = typeof retirement.targetId === 'string' ? retirement.targetId : retirement.canonicalAuthorId
        if (typeof targetId !== 'string') {
          problems.push(`invalid-author-redirect:${id}`)
          break
        }
        id = targetId
        continue
      }
      // A retired-as-deleted author is still displayed by the client for a
      // book that references it (an offline write can trail the deletion),
      // so dropping it here would silently rewrite the book with fewer
      // authors. Leave the book for review instead.
      if (retirement?.reason === 'deleted') {
        problems.push(`deleted-author:${id}`)
        break
      }
      if (typeof author.name !== 'string' || !author.name.trim()) {
        problems.push(`invalid-author-name:${id}`)
        break
      }
      // An absent kind is the pre-catalog legacy shape and reads as a
      // person; any other value is a schema violation the migration must
      // not silently reclassify.
      if (author.kind !== undefined && author.kind !== 'person' &&
          author.kind !== 'entity' && author.kind !== 'placeholder') {
        problems.push(`invalid-author-kind:${id}`)
        break
      }
      const kind: ReviewedAuthor['kind'] = author.kind === 'entity'
        ? 'entity'
        : author.kind === 'placeholder' ? 'placeholder' : 'person'
      const name = author.name.trim().replace(/\s+/g, ' ')
      const sortName = kind === 'person' && typeof author.familyName === 'string' && author.familyName.trim()
        ? author.familyName.trim().replace(/\s+/g, ' ')
        : name
      resolved.push({name, kind, sortName, ...(id.includes(':') ? {} : {catalogId: id})})
      break
    }
  }
  const byKey = new Map<string, MigrationCandidate['personalAuthors'][number]>()
  for (const author of resolved) {
    const key = normalizeCatalogAuthorName(author.name)
    if (key && !byKey.has(key)) byKey.set(key, author)
  }
  return {authors: [...byKey.values()], problems}
}

export const resolveMigrationAuthors = (
  book: MigrationBook,
  authorsById: ReadonlyMap<string, MigrationAuthor>
): { names: string[]; problems: string[] } => {
  const resolved = resolvedPersonalAuthors(book, authorsById)
  return {
    names: cleanNames(resolved.authors.filter((author) => author.kind !== 'placeholder').map((author) => author.name)),
    problems: resolved.problems,
  }
}

const reviewedAssignments = (
  books: MigrationBook[],
  reviewedGroups: ReviewedWorkGroup[]
): { byPath: Map<string, ReviewedWorkGroup>; ambiguities: MigrationAmbiguity[] } => {
  const knownPaths = new Set(books.map((book) => book.path))
  const byPath = new Map<string, ReviewedWorkGroup>()
  const ambiguities: MigrationAmbiguity[] = []
  const ids = new Set<string>()

  for (const group of reviewedGroups) {
    if (!group.id.trim() || ids.has(group.id)) {
      ambiguities.push({ type: 'invalid-reviewed-group', bookPaths: group.bookPaths, detail: `Duplicate or empty reviewed group id: ${group.id}` })
      continue
    }
    ids.add(group.id)
    const cleaned = cleanReviewedAuthors(group)
    if (cleaned.problem) {
      ambiguities.push({ type: 'invalid-reviewed-group', bookPaths: group.bookPaths, detail: cleaned.problem })
      continue
    }
    const normalizedGroup: ReviewedWorkGroup = {
      ...group,
      authorNames: cleaned.authors.map((author) => author.name),
      authorKinds: cleaned.authors.map((author) => author.kind),
    }
    for (const path of group.bookPaths) {
      if (!knownPaths.has(path)) {
        ambiguities.push({ type: 'invalid-reviewed-group', bookPaths: [path], detail: `Reviewed path does not exist: ${path}` })
        continue
      }
      if (byPath.has(path)) {
        ambiguities.push({ type: 'invalid-reviewed-group', bookPaths: [path], detail: `Book appears in more than one reviewed group: ${path}` })
        continue
      }
      byPath.set(path, normalizedGroup)
    }
  }
  return { byPath, ambiguities }
}

const makeCandidate = (
  book: MigrationBook,
  authorsById: ReadonlyMap<string, MigrationAuthor>,
  reviewed: ReviewedWorkGroup | undefined
): MigrationCandidate => {
  const title = typeof book.title === 'string' ? book.title.trim() : ''
  const titleKey = normalizeCatalogTitle(title)
  const resolvedAuthors = resolveMigrationAuthors(book, authorsById)
  const personal = resolvedPersonalAuthors(book, authorsById)
  const authorNames = reviewed ? reviewed.authorNames : resolvedAuthors.names
  const authorKey = authorNames.map(normalizeCatalogAuthorName).sort().join('|')
  const reviewedGroupId = reviewed?.id ?? null
  const identityKey = reviewedGroupId
    ? `reviewed:${reviewedGroupId}`
    : titleKey && authorKey
      ? `title:${titleKey}\0authors:${authorKey}`
      : null
  const problems = [...new Set([...resolvedAuthors.problems, ...personal.problems])]
  if (!titleKey) problems.push('missing-title')
  if (!authorKey && !reviewedGroupId) problems.push('missing-resolved-author')
  const isbn13 = normalizeIsbn(typeof book.isbn === 'string' ? book.isbn : '')
  if (typeof book.isbn === 'string' && book.isbn.trim() && !isbn13) problems.push('invalid-isbn')
  const personalAuthorIds = personal.authors.map((author) =>
    author.catalogId ?? deterministicCatalogId('author', normalizeCatalogAuthorName(author.name)),
  )
  if (personalAuthorIds.length > MAX_PERSONAL_BOOK_AUTHORS) {
    personal.problems.push('too-many-personal-authors')
    problems.push('too-many-personal-authors')
  }
  return {
    book, title, titleKey, authorNames, personalAuthors: personal.authors, personalAuthorIds,
    authorProblems: personal.problems,
    isbn13, identityKey, reviewedGroupId, problems,
  }
}

const preferredCandidate = (candidates: MigrationCandidate[]): MigrationCandidate =>
  [...candidates].sort(
    (left, right) =>
      left.book.seedPriority - right.book.seedPriority ||
      left.book.path.localeCompare(right.book.path)
  )[0]

export const planCrossUserCatalog = (
  books: MigrationBook[],
  authorsById: ReadonlyMap<string, MigrationAuthor>,
  reviewedGroups: ReviewedWorkGroup[] = []
): CrossUserCatalogPlan => {
  const reviewed = reviewedAssignments(books, reviewedGroups)
  const candidates = books.map((book) => makeCandidate(book, authorsById, reviewed.byPath.get(book.path)))
  const ambiguities = [...reviewed.ambiguities]
  const blocked = new Set<string>()

  for (const candidate of candidates) {
    const fatalProblems = candidate.problems.filter((problem) => problem !== 'invalid-isbn')
    if (fatalProblems.length > 0) {
      blocked.add(candidate.book.path)
      ambiguities.push({ type: 'unresolved-book', bookPaths: [candidate.book.path], detail: fatalProblems.join(', ') })
    }
  }

  const byIsbn = new Map<string, MigrationCandidate[]>()
  for (const candidate of candidates) {
    if (candidate.isbn13 && !blocked.has(candidate.book.path)) {
      const bucket = byIsbn.get(candidate.isbn13) ?? []
      bucket.push(candidate)
      byIsbn.set(candidate.isbn13, bucket)
    }
  }
  for (const [isbn, bucket] of byIsbn) {
    const identities = new Set(bucket.flatMap((candidate) => (candidate.identityKey ? [candidate.identityKey] : [])))
    if (identities.size > 1) {
      const paths = bucket.map((candidate) => candidate.book.path).sort()
      for (const path of paths) blocked.add(path)
      ambiguities.push({ type: 'isbn-conflict', bookPaths: paths, detail: `ISBN ${isbn} has conflicting title/author identities` })
    }
  }

  const byIdentity = new Map<string, MigrationCandidate[]>()
  for (const candidate of candidates) {
    if (blocked.has(candidate.book.path) || !candidate.identityKey) continue
    const bucket = byIdentity.get(candidate.identityKey) ?? []
    bucket.push(candidate)
    byIdentity.set(candidate.identityKey, bucket)
  }

  const reviewedById = new Map([...reviewed.byPath.values()].map((group) => [group.id, group]))
  const groups: MigrationGroup[] = []
  for (const [key, groupCandidates] of [...byIdentity.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const preferred = preferredCandidate(groupCandidates)
    const reviewedGroup = preferred.reviewedGroupId ? reviewedById.get(preferred.reviewedGroupId) : undefined
    const canonicalTitle = reviewedGroup?.canonicalTitle.trim() || preferred.title
    const alternateTitles = cleanTitles([
      ...(reviewedGroup?.alternateTitles ?? []),
      ...groupCandidates.map((candidate) => candidate.title),
    ]).filter((title) => normalizeCatalogTitle(title) !== normalizeCatalogTitle(canonicalTitle))
    const authorNames = reviewedGroup ? reviewedGroup.authorNames : preferred.authorNames
    const authorIds = authorNames.map((name) => {
      const key = normalizeCatalogAuthorName(name)
      const existingId = candidates.flatMap((candidate) => candidate.personalAuthors)
        .find((author) => normalizeCatalogAuthorName(author.name) === key)?.catalogId
      return existingId ?? deterministicCatalogId('author', key)
    })
    if (authorIds.length > MAX_WORK_AUTHORS) {
      const paths = groupCandidates.map((candidate) => candidate.book.path).sort()
      for (const path of paths) blocked.add(path)
      ambiguities.push({
        type: 'too-many-work-authors',
        bookPaths: paths,
        detail: `Work identity has ${authorIds.length} authors; the catalog limit is ${MAX_WORK_AUTHORS}`,
      })
      continue
    }
    if (reviewedGroup) {
      if (authorIds.length > MAX_PERSONAL_BOOK_AUTHORS) {
        const paths = groupCandidates.map((candidate) => candidate.book.path).sort()
        for (const candidate of groupCandidates) {
          blocked.add(candidate.book.path)
          if (!candidate.authorProblems.includes('too-many-personal-authors')) {
            candidate.authorProblems.push('too-many-personal-authors')
          }
          if (!candidate.problems.includes('too-many-personal-authors')) {
            candidate.problems.push('too-many-personal-authors')
          }
        }
        ambiguities.push({
          type: 'too-many-personal-authors',
          bookPaths: paths,
          detail: `Reviewed authorship has ${authorIds.length} authors; personal books allow ${MAX_PERSONAL_BOOK_AUTHORS}`,
        })
      } else {
        for (const candidate of groupCandidates) candidate.personalAuthorIds = [...authorIds]
      }
    }
    const isbns = [...new Set(groupCandidates.flatMap((candidate) => (candidate.isbn13 ? [candidate.isbn13] : [])))].sort()
    const workId = deterministicCatalogId('work', key)
    const editionIds = Object.fromEntries(isbns.map(
      (isbn) => [isbn, deterministicCatalogId('edition', `${workId}\0${isbn}`)],
    ))
    groups.push({
      key,
      candidates: [...groupCandidates].sort((left, right) => left.book.path.localeCompare(right.book.path)),
      canonicalTitle,
      alternateTitles,
      authorNames,
      authorIds,
      isbns,
      workId,
      editionIds,
      reviewedGroupId: preferred.reviewedGroupId,
    })
  }

  const authorVariants = new Map<string, MigrationCandidate['personalAuthors']>()
  for (const candidate of candidates) {
    if (candidate.reviewedGroupId !== null) continue
    for (const author of candidate.personalAuthors) {
      const key = normalizeCatalogAuthorName(author.name)
      const variants = authorVariants.get(key) ?? []
      if (!variants.some((variant) => variant.name === author.name && variant.kind === author.kind && variant.sortName === author.sortName && variant.catalogId === author.catalogId)) {
        variants.push(author)
      }
      authorVariants.set(key, variants)
    }
  }
  for (const group of groups) {
    const reviewedGroup = group.reviewedGroupId === null ? undefined : reviewedById.get(group.reviewedGroupId)
    for (const [authorIndex, name] of group.authorNames.entries()) {
      const key = normalizeCatalogAuthorName(name)
      const existing = authorVariants.get(key) ?? []
      const exactSources = group.candidates.flatMap((candidate) => candidate.personalAuthors)
        .filter((author) => normalizeCatalogAuthorName(author.name) === key)
      const provenance = exactSources[0] ?? existing[0]
      const reviewedKind = reviewedGroup?.authorKinds[authorIndex]
      const kind = reviewedKind ?? provenance?.kind ?? 'person' as const
      // A manifest corrects spellings but carries no sortName; a person
      // with no personal-author provenance sorts by the last name token so
      // "Milan Kundera" files under K, as every legacy person did.
      const sortName = provenance?.sortName ??
        (kind === 'person' ? name.trim().split(/\s+/u).at(-1) ?? name : name)
      const canonical = {
        name,
        kind,
        sortName,
        ...(provenance?.catalogId === undefined ? {} : {catalogId: provenance.catalogId}),
      }
      // A placeholder personal author carries no identity, so a reviewed
      // kind reclassifies it rather than conflicting with it; person and
      // entity provenance still has to agree with the manifest.
      const variants = [canonical, ...exactSources, ...existing]
        .filter((variant) => reviewedKind === undefined || variant.kind !== 'placeholder')
        .filter((variant, index, all) =>
          all.findIndex((candidate) => candidate.name === variant.name &&
            candidate.kind === variant.kind && candidate.sortName === variant.sortName &&
            candidate.catalogId === variant.catalogId) === index,
        )
      authorVariants.set(key, variants)
    }
  }
  const catalogAuthors = [...authorVariants].sort(([left], [right]) =>
    left.localeCompare(right),
  ).flatMap(([key, variants]) => {
    const canonical = variants[0]
    const kinds = new Set(variants.map((variant) => variant.kind))
    if (kinds.size > 1) {
      const affected = candidates.filter((candidate) =>
        candidate.personalAuthors.some((author) => normalizeCatalogAuthorName(author.name) === key) ||
        groups.some((group) => group.candidates.includes(candidate) &&
          group.authorNames.some((name) => normalizeCatalogAuthorName(name) === key)),
      )
      const problem = `author-kind-conflict:${key}`
      for (const candidate of affected) {
        if (!candidate.authorProblems.includes(problem)) candidate.authorProblems.push(problem)
        if (!candidate.problems.includes(problem)) candidate.problems.push(problem)
      }
      ambiguities.push({
        type: 'author-kind-conflict',
        bookPaths: affected.map((candidate) => candidate.book.path).sort(),
        detail: `${canonical.name} is classified as ${[...kinds].sort().join(' and ')}`,
      })
      return []
    }
    return [{
      authorId: variants.find((variant) => variant.catalogId !== undefined)?.catalogId ?? deterministicCatalogId('author', key),
      canonicalName: canonical.name,
      alternateNames: [...new Set(variants.slice(1).map((variant) => variant.name))],
      nameKeys: [key],
      sortName: canonical.sortName,
      kind: canonical.kind,
    }]
  })

  return {
    candidates,
    authors: catalogAuthors,
    groups,
    ambiguities: ambiguities.sort((left, right) => left.type.localeCompare(right.type) || left.bookPaths.join().localeCompare(right.bookPaths.join())),
  }
}

function assertSnapshotVersion(
  path: string,
  expectedVersion: number,
  snapshot: DocumentSnapshot,
): void {
  if (!snapshot.exists || snapshot.updateTime?.toMillis() !== expectedVersion) {
    throw new Error(`catalog identity source ${path} changed during migration`)
  }
}

export async function assertMigrationSourceVersions(
  transaction: Transaction,
  db: Firestore,
  sources: readonly MigrationSeedSource[],
): Promise<void> {
  const uniqueSources = [...new Map(sources.map((source) => [source.bookPath, source])).values()]
  const authorVersions = new Map<string, number>()
  for (const source of uniqueSources) {
    for (const author of source.authorVersions) {
      const existing = authorVersions.get(author.path)
      if (existing !== undefined && existing !== author.version) {
        throw new Error(`catalog identity source ${author.path} has conflicting versions`)
      }
      authorVersions.set(author.path, author.version)
    }
  }
  const [books, authors] = await Promise.all([
    Promise.all(uniqueSources.map((source) => transaction.get(db.doc(source.bookPath)))),
    Promise.all([...authorVersions].map(([path]) => transaction.get(db.doc(path)))),
  ])
  for (let index = 0; index < uniqueSources.length; index += 1) {
    assertSnapshotVersion(uniqueSources[index].bookPath, uniqueSources[index].bookVersion, books[index])
  }
  for (let index = 0; index < authors.length; index += 1) {
    const [path, version] = [...authorVersions][index]
    assertSnapshotVersion(path, version, authors[index])
  }
}

// A sharedWorkOwners row is the one projection sharing consent governs, so
// the consent the planner saw is re-read inside the write transaction: a
// user who withdrew while the migration ran must not gain a reader row.
export async function assertMigrationProjectionSourcesConsented(
  transaction: Transaction,
  db: Firestore,
  sources: readonly MigrationSeedSource[],
  workId: string,
): Promise<void> {
  if (sources.length === 0) throw new Error(`sharing projection for ${workId} has no source books`)
  const uniqueSources = [...new Map(sources.map((source) => [source.bookPath, source])).values()]
  const uid = uniqueSources[0].uid
  if (uniqueSources.some((source) => source.uid !== uid)) {
    throw new Error(`sharing projection for ${workId} mixes source owners`)
  }
  for (const source of uniqueSources) {
    const expectedPrefix = `users/${uid}/books/`
    if (!source.bookPath.startsWith(expectedPrefix) || source.bookPath.length === expectedPrefix.length) {
      throw new Error(`invalid sharing projection source ${source.bookPath}`)
    }
  }

  const [user, setting, ...books] = await Promise.all([
    transaction.get(db.doc(`users/${uid}`)),
    transaction.get(db.doc(`users/${uid}/settings/bookSharing`)),
    ...uniqueSources.map((source) => transaction.get(db.doc(source.bookPath))),
  ])
  const settingData = setting.data()
  const profile = typeof settingData?.profileUsername === 'string'
    ? await transaction.get(db.doc(`profiles/${settingData.profileUsername}`))
    : null
  if (!sharingConsentIsValid(uid, user.data(), settingData, profile?.data())) {
    throw new Error(`sharing projection source user ${uid} is no longer opted in`)
  }
  if (!books.some((book) => book.exists && book.get('workId') === workId)) {
    throw new Error(`sharing projection for ${workId} has no currently linked source book`)
  }
}
