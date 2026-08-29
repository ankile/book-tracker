import { createHash } from 'node:crypto'
import { normalizeCatalogAuthorName, normalizeCatalogTitle } from './src/lib/utils/catalog.ts'
import { normalizeIsbn } from './src/lib/utils/isbn.ts'

export type MigrationAuthor = {
  id: string
  name?: unknown
  kind?: unknown
  retirement?: { reason?: unknown; targetId?: unknown; canonicalAuthorId?: unknown } | null
}

export type MigrationBook = {
  path: string
  uid: string
  bookId: string
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
  eligibleSeed: boolean
  sharingEligible?: boolean
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
}

export type MigrationCandidate = {
  book: MigrationBook
  title: string
  titleKey: string
  authorNames: string[]
  authorKey: string
  isbn13: string | null
  identityKey: string | null
  reviewedGroupId: string | null
  problems: string[]
}

export type MigrationGroup = {
  key: string
  candidates: MigrationCandidate[]
  eligibleSeed: boolean
  canonicalTitle: string
  alternateTitles: string[]
  authorNames: string[]
  isbns: string[]
  seedIsbns: string[]
  workId: string
  editionIds: Record<string, string>
  reviewedGroupId: string | null
}

export type MigrationAmbiguity = {
  type: string
  bookPaths: string[]
  detail: string
}

export type CrossUserCatalogPlan = {
  candidates: MigrationCandidate[]
  groups: MigrationGroup[]
  ambiguities: MigrationAmbiguity[]
}

export const deterministicCatalogId = (prefix: 'work' | 'edition' | 'title', key: string): string => {
  const digest = createHash('sha256').update(`${prefix}\0${key}`).digest('hex').slice(0, 24)
  return `${prefix}_${digest}`
}

export const deterministicTitleIndexId = (workId: string, titleKey: string): string =>
  createHash('sha256').update(`${workId}\0${titleKey}`).digest('hex')

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

const cleanNames = (names: string[]): string[] => {
  const byKey = new Map<string, string>()
  for (const name of names) {
    const trimmed = name.trim()
    const key = normalizeCatalogAuthorName(trimmed)
    if (key && key !== 'various authors' && !byKey.has(key)) byKey.set(key, trimmed)
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, name]) => name)
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
  return cleanNames([...embedded, ...(typeof book.author === 'string' ? [book.author] : [])])
}

export const resolveMigrationAuthors = (
  book: MigrationBook,
  authorsById: ReadonlyMap<string, MigrationAuthor>
): { names: string[]; problems: string[] } => {
  const ids = stringList(book.authorIds)
  if (ids.length === 0) return { names: legacyAuthorNames(book), problems: [] }

  const names: string[] = []
  const problems: string[] = []
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
        const targetId = typeof retirement.targetId === 'string'
          ? retirement.targetId
          : retirement.canonicalAuthorId
        if (typeof targetId !== 'string') {
          problems.push(`invalid-author-redirect:${id}`)
          break
        }
        id = targetId
        continue
      }
      if (retirement?.reason === 'deleted' || author.kind === 'placeholder') break
      if (typeof author.name !== 'string' || !author.name.trim()) {
        problems.push(`invalid-author-name:${id}`)
        break
      }
      names.push(author.name)
      break
    }
  }
  return { names: cleanNames(names), problems }
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
    for (const path of group.bookPaths) {
      if (!knownPaths.has(path)) {
        ambiguities.push({ type: 'invalid-reviewed-group', bookPaths: [path], detail: `Reviewed path does not exist: ${path}` })
        continue
      }
      if (byPath.has(path)) {
        ambiguities.push({ type: 'invalid-reviewed-group', bookPaths: [path], detail: `Book appears in more than one reviewed group: ${path}` })
        continue
      }
      byPath.set(path, group)
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
  const authorNames = reviewed ? cleanNames(reviewed.authorNames) : resolvedAuthors.names
  const authorKey = authorNames.map(normalizeCatalogAuthorName).sort().join('|')
  const reviewedGroupId = reviewed?.id ?? null
  const identityKey = reviewedGroupId
    ? `reviewed:${reviewedGroupId}`
    : titleKey && authorKey
      ? `title:${titleKey}\0authors:${authorKey}`
      : null
  const problems = [...resolvedAuthors.problems]
  if (!titleKey) problems.push('missing-title')
  if (!authorKey && !reviewedGroupId) problems.push('missing-resolved-author')
  const isbn13 = normalizeIsbn(typeof book.isbn === 'string' ? book.isbn : '')
  if (typeof book.isbn === 'string' && book.isbn.trim() && !isbn13) problems.push('invalid-isbn')
  return { book, title, titleKey, authorNames, authorKey, isbn13, identityKey, reviewedGroupId, problems }
}

const preferredCandidate = (candidates: MigrationCandidate[]): MigrationCandidate =>
  [...candidates].sort(
    (left, right) =>
      left.book.seedPriority - right.book.seedPriority ||
      Number(right.book.eligibleSeed) - Number(left.book.eligibleSeed) ||
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

  const reviewedById = new Map(reviewedGroups.map((group) => [group.id, group]))
  const groups: MigrationGroup[] = []
  for (const [key, groupCandidates] of [...byIdentity.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const eligibleCandidates = groupCandidates.filter((candidate) => candidate.book.eligibleSeed)
    const preferred = preferredCandidate(eligibleCandidates.length > 0 ? eligibleCandidates : groupCandidates)
    const reviewedGroup = preferred.reviewedGroupId ? reviewedById.get(preferred.reviewedGroupId) : undefined
    const canonicalTitle = reviewedGroup?.canonicalTitle.trim() || preferred.title
    const alternateTitles = cleanTitles([
      ...(reviewedGroup?.alternateTitles ?? []),
      ...eligibleCandidates.map((candidate) => candidate.title),
    ]).filter((title) => normalizeCatalogTitle(title) !== normalizeCatalogTitle(canonicalTitle))
    const authorNames = reviewedGroup ? cleanNames(reviewedGroup.authorNames) : preferred.authorNames
    const isbns = [...new Set(groupCandidates.flatMap((candidate) => (candidate.isbn13 ? [candidate.isbn13] : [])))].sort()
    const seedIsbns = [...new Set(eligibleCandidates.flatMap(
      (candidate) => candidate.isbn13 ? [candidate.isbn13] : [],
    ))].sort()
    const workId = deterministicCatalogId('work', key)
    const editionIds = Object.fromEntries(seedIsbns.map(
      (isbn) => [isbn, deterministicCatalogId('edition', `${workId}\0${isbn}`)],
    ))
    groups.push({
      key,
      candidates: [...groupCandidates].sort((left, right) => left.book.path.localeCompare(right.book.path)),
      eligibleSeed: groupCandidates.some((candidate) => candidate.book.eligibleSeed),
      canonicalTitle,
      alternateTitles,
      authorNames,
      isbns,
      seedIsbns,
      workId,
      editionIds,
      reviewedGroupId: preferred.reviewedGroupId,
    })
  }

  return {
    candidates,
    groups,
    ambiguities: ambiguities.sort((left, right) => left.type.localeCompare(right.type) || left.bookPaths.join().localeCompare(right.bookPaths.join())),
  }
}
