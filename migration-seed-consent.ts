import { Timestamp, type DocumentSnapshot, type Firestore, type Transaction } from 'firebase-admin/firestore'

export const OPERATOR_UID = '1Cf0CaNfgnVSvTrF5dYjzRd9Xri2'

export type MigrationSeedSource = {
  uid: string
  bookPath: string
  bookVersion: number
  authorVersions: Array<{path: string; version: number}>
}

type CatalogDoc = Record<string, unknown>

function validTimeZone(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}

function validSharingSetting(value: CatalogDoc | undefined): value is CatalogDoc {
  if (value === undefined || !validTimeZone(value.timeZone) ||
      typeof value.profileUsername !== 'string' ||
      !/^[a-z0-9-]{3,30}$/.test(value.profileUsername) ||
      !(value.createdAt instanceof Timestamp) || !(value.updatedAt instanceof Timestamp)) return false
  return Object.keys(value).every((key) =>
    ['profileUsername', 'timeZone', 'createdAt', 'updatedAt'].includes(key),
  )
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

export function migrationSeedIsEligible(
  uid: string,
  user: CatalogDoc | undefined,
  setting: CatalogDoc | undefined,
  profile: CatalogDoc | undefined,
): boolean {
  if (user === undefined || user.deletedAt !== undefined) return false
  if (uid === OPERATOR_UID) return true
  return migrationSharingConsentIsValid(uid, user, setting, profile)
}

export function migrationSharingConsentIsValid(
  uid: string,
  user: CatalogDoc | undefined,
  setting: CatalogDoc | undefined,
  profile: CatalogDoc | undefined,
): boolean {
  return user !== undefined && user.deletedAt === undefined && validSharingSetting(setting) &&
    profile?.uid === uid && profile.public === true && profile.deletedAt === undefined
}

export async function assertMigrationSeedSourcesEligible(
  transaction: Transaction,
  db: Firestore,
  sources: readonly MigrationSeedSource[],
): Promise<void> {
  const uniqueSources = [...new Map(sources.map((source) => [source.bookPath, source])).values()]
  const sourceReads = await Promise.all(uniqueSources.map(async (source) => {
    const expectedPrefix = `users/${source.uid}/books/`
    if (!source.bookPath.startsWith(expectedPrefix) || source.bookPath.length === expectedPrefix.length) {
      throw new Error(`invalid catalog seed source ${source.bookPath}`)
    }
    const [user, book, setting] = await Promise.all([
      transaction.get(db.doc(`users/${source.uid}`)),
      transaction.get(db.doc(source.bookPath)),
      source.uid === OPERATOR_UID
        ? Promise.resolve(null)
        : transaction.get(db.doc(`users/${source.uid}/settings/bookSharing`)),
    ])
    if (!book.exists) throw new Error(`catalog seed source ${source.bookPath} no longer exists`)
    assertSnapshotVersion(source.bookPath, source.bookVersion, book)
    return { source, user: user.data(), setting: setting?.data() }
  }))

  const authorVersions = new Map<string, number>()
  for (const source of uniqueSources) {
    for (const author of source.authorVersions) authorVersions.set(author.path, author.version)
  }
  const authorSnapshots = await Promise.all(
    [...authorVersions].map(([path]) => transaction.get(db.doc(path))),
  )
  for (let index = 0; index < authorSnapshots.length; index += 1) {
    const [path, version] = [...authorVersions][index]
    assertSnapshotVersion(path, version, authorSnapshots[index])
  }

  const profileNames = [...new Set(sourceReads.flatMap(({ source, setting }) =>
    source.uid !== OPERATOR_UID && typeof setting?.profileUsername === 'string'
      ? [setting.profileUsername]
      : [],
  ))]
  const profiles = await Promise.all(profileNames.map((username) => transaction.get(db.doc(`profiles/${username}`))))
  const profilesByUsername = new Map(profiles.map((profile) => [profile.id, profile.data()]))

  for (const { source, user, setting } of sourceReads) {
    const profile = typeof setting?.profileUsername === 'string'
      ? profilesByUsername.get(setting.profileUsername)
      : undefined
    if (!migrationSeedIsEligible(source.uid, user, setting, profile)) {
      throw new Error(`catalog seed source ${source.bookPath} is no longer eligible to publish metadata`)
    }
  }
}

export async function assertMigrationProjectionSourcesEligible(
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
  if (!migrationSharingConsentIsValid(uid, user.data(), settingData, profile?.data())) {
    throw new Error(`sharing projection source user ${uid} is no longer opted in`)
  }
  if (!books.some((book) => book.exists && book.get('workId') === workId)) {
    throw new Error(`sharing projection for ${workId} has no currently linked source book`)
  }
}
