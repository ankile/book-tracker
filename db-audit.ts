// Read-only drift report over the whole database. Run before and after
// every migration and diff the outputs: deterministic path-sorted lines,
// one per finding, then per-class counts.
//
// User traversal uses listDocuments() because a missing user parent can
// still own live book/timer subcollections. Book/update traversal uses
// .get(); the dedicated orphan checks report missing parent documents.
//
//   node db-audit.ts            # emulator
//   node db-audit.ts --prod     # production (read-only)
import { parseFlags, connect, openDatabase } from './migrate-lib.ts';
import { isFinished } from './src/lib/utils/finished.ts';
import { auditTimerClaimState } from './timer-claim-migration.ts';
import { auditReadingProgressSource } from './reading-progress-source-migration.ts';
import { Timestamp } from 'firebase-admin/firestore';
import {
  deterministicExternalIndexId,
  deterministicSharedWorkOwnerId,
  deterministicTitleIndexId,
} from './cross-user-work-migration.ts';
import {
  SHARING_SETTING_KEYS,
  SHARING_USERNAME,
  sharingConsentIsValid,
  validTimeZone,
} from './sharing-consent.ts';
import {
  catalogTitleKeys,
  normalizeCatalogAuthorName,
  normalizeCatalogTitle,
} from './src/lib/utils/catalog.ts';
import { normalizeIsbn } from './src/lib/utils/isbn.ts';
import {
  bookShapeViolations,
  profileOwnerRecordViolations,
  profileShapeViolations,
} from './rules-shape.ts';

const flags = parseFlags(process.argv.slice(2));
const { db } = await connect(flags);

interface Finding {
  cls: string;
  path: string;
  detail: string;
}

const findings: Finding[] = [];
const found = (cls: string, path: string, detail = ''): void => {
  findings.push({ cls, path, detail });
};

const userProfiles = await db.collection('users').get();
const users = await db.collection('users').listDocuments();
// Integration credentials (SEC-004) live in the `secrets` database; this
// audit reads their shape and linkage but NEVER their values — no finding
// detail below may carry a token.
const togglTokens = await openDatabase('secrets').collection('togglTokens').get();
const publicProfiles = await db.collection('profiles').get();
const profileDiscoveries = await db.collection('profileDiscovery').get();
const profileOwners = await db.collection('profileOwners').get();
const catalogAuthors = await db.collection('catalogAuthors').get();
const works = await db.collection('works').get();
const editions = await db.collection('editions').get();
const isbnIndexes = await db.collection('isbnIndex').get();
const externalIdIndexes = await db.collection('externalIdIndex').get();
const workTitleIndexes = await db.collection('workTitleIndex').get();
const sharedWorkOwners = await db.collection('sharedWorkOwners').get();
const existingUsers = new Set(userProfiles.docs.map((d) => d.id));
const userProfilesById = new Map(userProfiles.docs.map((d) => [d.id, d.data()]));

const worksById = new Map(works.docs.map((doc) => [doc.id, doc.data()]));
const catalogAuthorsById = new Map(catalogAuthors.docs.map((doc) => [doc.id, doc.data()]));
const editionsById = new Map(editions.docs.map((doc) => [doc.id, doc.data()]));
const isbnIndexesById = new Map(isbnIndexes.docs.map((doc) => [doc.id, doc.data()]));
const externalIdIndexesById = new Map(externalIdIndexes.docs.map((doc) => [doc.id, doc.data()]));
const titleIndexesById = new Map(workTitleIndexes.docs.map((doc) => [doc.id, doc.data()]));

const trustedExternalProviders = new Set(['google-books', 'open-library']);
const validCatalogCover = (value: unknown): boolean =>
  value === '' || (typeof value === 'string' && /^https:\/\/[^\s]+$/u.test(value));

const resolveCatalogWork = (id: string): {id: string | null; hops: number; cycle: boolean} => {
  const visited = new Set<string>();
  let current = id;
  let hops = 0;
  while (true) {
    if (visited.has(current)) return {id: null, hops, cycle: true};
    visited.add(current);
    const work = worksById.get(current);
    if (work === undefined) return {id: null, hops, cycle: false};
    if (work.status !== 'merged') return {id: current, hops, cycle: false};
    if (typeof work.mergedInto !== 'string') return {id: null, hops, cycle: false};
    current = work.mergedInto;
    hops += 1;
  }
};

const resolveCatalogAuthor = (id: string): {id: string | null; hops: number; cycle: boolean} => {
  const visited = new Set<string>();
  let current = id;
  let hops = 0;
  while (true) {
    if (visited.has(current)) return {id: null, hops, cycle: true};
    visited.add(current);
    const author = catalogAuthorsById.get(current);
    if (author === undefined) return {id: null, hops, cycle: false};
    if (author.status !== 'merged') return {id: current, hops, cycle: false};
    if (typeof author.mergedInto !== 'string') return {id: null, hops, cycle: false};
    current = author.mergedInto;
    hops += 1;
  }
};

for (const authorDoc of catalogAuthors.docs) {
  const author = authorDoc.data();
  const path = authorDoc.ref.path;
  const required = [
    'canonicalName', 'alternateNames', 'nameKeys', 'sortName', 'kind',
    'status', 'createdAt', 'updatedAt',
  ];
  for (const field of required) {
    if (author[field] === undefined) found(`catalog.author.missing.${field}`, path);
  }
  const allowed = new Set([...required, 'mergedInto', 'mergedFrom']);
  for (const field of Object.keys(author)) {
    if (!allowed.has(field)) found('catalog.author.unexpected-field', path, field);
  }
  if (typeof author.canonicalName !== 'string' || author.canonicalName.trim() === '' ||
      typeof author.sortName !== 'string' || author.sortName.trim() === '') {
    found('catalog.author.bad-name', path);
  }
  if (!['person', 'entity', 'placeholder'].includes(author.kind)) {
    found('catalog.author.bad-kind', path, String(author.kind));
  }
  if (!['active', 'merged'].includes(author.status)) {
    found('catalog.author.bad-status', path, String(author.status));
  }
  if (!Array.isArray(author.alternateNames) ||
      author.alternateNames.some((name) => typeof name !== 'string')) {
    found('catalog.author.bad-alternate-names', path);
  }
  if (typeof author.canonicalName === 'string' && Array.isArray(author.alternateNames) &&
      author.alternateNames.every((name) => typeof name === 'string')) {
    const expected = [...new Set(
      [author.canonicalName, ...author.alternateNames].map(normalizeCatalogAuthorName),
    )];
    if (JSON.stringify(author.nameKeys) !== JSON.stringify(expected)) {
      found('catalog.author.name-keys-mismatch', path, JSON.stringify(author.nameKeys));
    }
  }
  if (!(author.createdAt instanceof Timestamp) || !(author.updatedAt instanceof Timestamp)) {
    found('catalog.author.bad-timestamps', path);
  }
  const resolution = resolveCatalogAuthor(authorDoc.id);
  if (resolution.cycle) found('catalog.author.merge-cycle', path);
  if (author.status === 'merged') {
    if (typeof author.mergedInto !== 'string' ||
        catalogAuthorsById.get(author.mergedInto)?.status !== 'active') {
      found('catalog.author.merge-target-missing', path, String(author.mergedInto));
    } else if (resolution.hops !== 1) {
      found('catalog.author.merge-not-one-hop', path, String(resolution.hops));
    }
  } else if (author.mergedInto !== undefined) {
    found('catalog.author.active-has-merged-into', path, String(author.mergedInto));
  }
  if (author.status === 'active') {
    if (!Array.isArray(author.mergedFrom) || author.mergedFrom.length > 29 ||
        new Set(author.mergedFrom).size !== author.mergedFrom.length) {
      found('catalog.author.bad-merged-from', path, JSON.stringify(author.mergedFrom));
    } else {
      for (const sourceId of author.mergedFrom) {
        const source = typeof sourceId === 'string' ? catalogAuthorsById.get(sourceId) : undefined;
        if (source?.status !== 'merged' || source.mergedInto !== authorDoc.id) {
          found('catalog.author.merged-from-mismatch', path, String(sourceId));
        }
      }
    }
  }
}

for (const workDoc of works.docs) {
  const work = workDoc.data();
  const path = workDoc.ref.path;
  const required = [
    'canonicalTitle', 'alternateTitles', 'titleKeys', 'authorIds',
    'coverUrl', 'subjects', 'fiction', 'status', 'mergedFrom',
    'createdAt', 'updatedAt',
  ];
  for (const field of required) if (work[field] === undefined) found(`catalog.work.missing.${field}`, path);
  // createdBy names the verified account whose catalog.create minted the
  // work; the migration and the admin tools leave it absent.
  const allowedWorkFields = new Set([...required, 'mergedInto', 'createdBy']);
  for (const field of Object.keys(work)) {
    if (!allowedWorkFields.has(field)) found('catalog.work.unexpected-field', path, field);
  }
  if (!['active', 'merged', 'hidden'].includes(work.status)) found('catalog.work.bad-status', path, String(work.status));
  if (typeof work.canonicalTitle !== 'string' || work.canonicalTitle.trim() === '') {
    found('catalog.work.bad-title', path, JSON.stringify(work.canonicalTitle));
  }
  if (!validCatalogCover(work.coverUrl)) {
    found('catalog.work.bad-cover-url', path, JSON.stringify(work.coverUrl));
  }
  if (!Array.isArray(work.alternateTitles) || work.alternateTitles.some((title) => typeof title !== 'string')) {
    found('catalog.work.bad-alternate-titles', path, JSON.stringify(work.alternateTitles));
  }
  if (!Array.isArray(work.authorIds) || work.authorIds.length === 0 ||
      work.authorIds.length > 20 || new Set(work.authorIds).size !== work.authorIds.length ||
      work.authorIds.some((id) => typeof id !== 'string')) {
    found('catalog.work.bad-authors', path, JSON.stringify(work.authorIds));
  } else {
    // Merges canonicalize work references in a post-commit sweep; a
    // surviving alias resolves but marks an interrupted sweep.
    for (const authorId of work.authorIds) {
      const resolution = resolveCatalogAuthor(authorId);
      if (resolution.id === null) found('catalog.work.author-unresolved', path, authorId);
      else if (resolution.hops !== 0) found('catalog.work.author-not-canonical', path, authorId);
    }
  }
  if (!Array.isArray(work.subjects) || work.subjects.length > 25 ||
      work.subjects.some((subject) => typeof subject !== 'string')) {
    found('catalog.work.bad-subjects', path, JSON.stringify(work.subjects));
  }
  if (work.fiction !== null && typeof work.fiction !== 'boolean') {
    found('catalog.work.bad-fiction', path, JSON.stringify(work.fiction));
  }
  if (!(work.createdAt instanceof Timestamp) || !(work.updatedAt instanceof Timestamp)) {
    found('catalog.work.bad-timestamps', path);
  }
  if (typeof work.canonicalTitle === 'string' && Array.isArray(work.alternateTitles) && work.alternateTitles.every((title) => typeof title === 'string')) {
    const expectedTitleKeys = catalogTitleKeys(work.canonicalTitle, work.alternateTitles);
    if (JSON.stringify(work.titleKeys) !== JSON.stringify(expectedTitleKeys)) {
      found('catalog.work.title-keys-mismatch', path, `${JSON.stringify(work.titleKeys)} != ${JSON.stringify(expectedTitleKeys)}`);
    }
  }
  const resolution = resolveCatalogWork(workDoc.id);
  if (resolution.cycle) found('catalog.work.merge-cycle', path);
  if (work.status === 'merged') {
    if (typeof work.mergedInto !== 'string' || !worksById.has(work.mergedInto)) {
      found('catalog.work.merge-target-missing', path, String(work.mergedInto));
    } else if (worksById.get(work.mergedInto)?.status === 'merged') {
      found('catalog.work.merge-not-one-hop', path, work.mergedInto);
    }
  } else if (work.mergedInto !== undefined) {
    found('catalog.work.active-has-merged-into', path, String(work.mergedInto));
  }
  if (work.status !== 'merged') {
    if (!Array.isArray(work.mergedFrom) || work.mergedFrom.length > 29 || new Set(work.mergedFrom).size !== work.mergedFrom.length) {
      found('catalog.work.bad-merged-from', path, JSON.stringify(work.mergedFrom));
    } else {
      for (const sourceId of work.mergedFrom) {
        const source = typeof sourceId === 'string' ? worksById.get(sourceId) : undefined;
        if (source?.status !== 'merged' || source.mergedInto !== workDoc.id) {
          found('catalog.work.merged-from-mismatch', path, String(sourceId));
        }
      }
    }
  }
}

for (const editionDoc of editions.docs) {
  const edition = editionDoc.data();
  const path = editionDoc.ref.path;
  const allowedEditionFields = new Set([
    'workId', 'isbn13', 'title', 'publisher', 'publishedDate',
    'language', 'translatorNames', 'format', 'suggestedPageCount', 'coverUrl',
    'externalIds', 'createdAt', 'updatedAt',
  ]);
  for (const field of allowedEditionFields) {
    if (edition[field] === undefined) found(`catalog.edition.missing.${field}`, path);
  }
  for (const field of Object.keys(edition)) {
    if (!allowedEditionFields.has(field)) found('catalog.edition.unexpected-field', path, field);
  }
  if (!validCatalogCover(edition.coverUrl)) {
    found('catalog.edition.bad-cover-url', path, JSON.stringify(edition.coverUrl));
  }
  if (typeof edition.title !== 'string' || edition.title.trim() === '') {
    found('catalog.edition.bad-title', path, JSON.stringify(edition.title));
  }
  for (const field of ['publisher', 'publishedDate', 'language']) {
    if (typeof edition[field] !== 'string') {
      found(`catalog.edition.bad-${field}`, path, JSON.stringify(edition[field]));
    }
  }
  if (!Array.isArray(edition.translatorNames) ||
      edition.translatorNames.some((name) => typeof name !== 'string')) {
    found('catalog.edition.bad-translators', path, JSON.stringify(edition.translatorNames));
  }
  if (!['full', 'abridged', 'revised', 'unknown'].includes(edition.format)) {
    found('catalog.edition.bad-format', path, String(edition.format));
  }
  if (edition.suggestedPageCount !== null &&
      (!Number.isSafeInteger(edition.suggestedPageCount) || edition.suggestedPageCount <= 0)) {
    found('catalog.edition.bad-page-count', path, String(edition.suggestedPageCount));
  }
  if (!(edition.createdAt instanceof Timestamp) || !(edition.updatedAt instanceof Timestamp)) {
    found('catalog.edition.bad-timestamps', path);
  }
  if (typeof edition.workId !== 'string') {
    found('catalog.edition.bad-work-id', path, String(edition.workId));
  } else {
    const resolution = resolveCatalogWork(edition.workId);
    if (resolution.id === null) found('catalog.edition.work-unresolved', path, edition.workId);
    if (resolution.hops > 1) found('catalog.edition.work-not-one-hop', path, edition.workId);
  }
  if (edition.isbn13 !== null && (typeof edition.isbn13 !== 'string' || normalizeIsbn(edition.isbn13) !== edition.isbn13)) {
    found('catalog.edition.bad-isbn', path, String(edition.isbn13));
  }
  if (typeof edition.isbn13 === 'string') {
    const index = isbnIndexesById.get(edition.isbn13);
    if (index?.editionId !== editionDoc.id || index.workId !== edition.workId) {
      found('catalog.edition.isbn-index-mismatch', path, edition.isbn13);
    }
  }
  if (
    typeof edition.externalIds !== 'object' ||
    edition.externalIds === null ||
    Array.isArray(edition.externalIds)
  ) {
    found('catalog.edition.bad-external-ids', path, JSON.stringify(edition.externalIds));
  } else {
    for (const [provider, externalId] of Object.entries(edition.externalIds)) {
      if (!trustedExternalProviders.has(provider) || typeof externalId !== 'string' || externalId === '') {
        found('catalog.edition.bad-external-id', path, `${provider}:${String(externalId)}`);
        continue;
      }
      const index = externalIdIndexesById.get(deterministicExternalIndexId(provider, externalId));
      if (
        index?.editionId !== editionDoc.id ||
        index.workId !== edition.workId ||
        index.provider !== provider ||
        index.externalId !== externalId
      ) {
        found('catalog.edition.external-index-mismatch', path, `${provider}:${externalId}`);
      }
    }
  }
}

for (const indexDoc of isbnIndexes.docs) {
  const index = indexDoc.data();
  const path = indexDoc.ref.path;
  if (normalizeIsbn(indexDoc.id) !== indexDoc.id) found('catalog.isbn-index.bad-id', path);
  // One row, one shape finding: the key set and the field types are the
  // same defect seen twice.
  if (Object.keys(index).sort().join(',') !== 'editionId,workId' ||
      typeof index.workId !== 'string' || typeof index.editionId !== 'string') {
    found('catalog.isbn-index.bad-shape', path, JSON.stringify(index));
    continue;
  }
  const edition = editionsById.get(index.editionId);
  if (edition === undefined) {
    found('catalog.isbn-index.edition-missing', path, index.editionId);
    continue;
  }
  if (edition.isbn13 !== indexDoc.id) found('catalog.isbn-index.edition-isbn-mismatch', path, String(edition.isbn13));
  const indexedWork = resolveCatalogWork(index.workId);
  const editionWork = typeof edition.workId === 'string' ? resolveCatalogWork(edition.workId) : {id: null, hops: 0, cycle: false};
  if (indexedWork.id === null || indexedWork.id !== editionWork.id) {
    found('catalog.isbn-index.work-mismatch', path, `${index.workId} != ${String(edition.workId)}`);
  }
}

for (const indexDoc of externalIdIndexes.docs) {
  const index = indexDoc.data();
  const path = indexDoc.ref.path;
  if (Object.keys(index).sort().join(',') !== 'editionId,externalId,provider,workId') {
    found('catalog.external-index.bad-shape', path, JSON.stringify(index));
  }
  if (
    typeof index.workId !== 'string' ||
    typeof index.editionId !== 'string' ||
    typeof index.provider !== 'string' ||
    !trustedExternalProviders.has(index.provider) ||
    typeof index.externalId !== 'string' ||
    index.externalId === ''
  ) {
    found('catalog.external-index.bad-fields', path, JSON.stringify(index));
    continue;
  }
  if (deterministicExternalIndexId(index.provider, index.externalId) !== indexDoc.id) {
    found('catalog.external-index.bad-id', path, `${index.provider}:${index.externalId}`);
  }
  const edition = editionsById.get(index.editionId);
  if (edition === undefined) {
    found('catalog.external-index.edition-missing', path, index.editionId);
    continue;
  }
  if (edition.externalIds?.[index.provider] !== index.externalId) {
    found('catalog.external-index.edition-id-mismatch', path, String(edition.externalIds?.[index.provider]));
  }
  const indexedWork = resolveCatalogWork(index.workId);
  const editionWork = typeof edition.workId === 'string'
    ? resolveCatalogWork(edition.workId)
    : {id: null, hops: 0, cycle: false};
  if (indexedWork.id === null || indexedWork.id !== editionWork.id) {
    found('catalog.external-index.work-mismatch', path, `${index.workId} != ${String(edition.workId)}`);
  }
}

const titleRowsByPair = new Map<string, string[]>();
for (const indexDoc of workTitleIndexes.docs) {
  const index = indexDoc.data();
  const path = indexDoc.ref.path;
  if (Object.keys(index).sort().join(',') !== 'status,title,titleKey,workId' ||
      typeof index.workId !== 'string' || typeof index.title !== 'string' ||
      typeof index.titleKey !== 'string' ||
      (index.status !== 'active' && index.status !== 'hidden')) {
    found('catalog.title-index.bad-shape', path, JSON.stringify(index));
    continue;
  }
  if (index.titleKey !== normalizeCatalogTitle(index.title)) found('catalog.title-index.bad-key', path, index.titleKey);
  if (indexDoc.id !== deterministicTitleIndexId(index.workId, index.titleKey)) found('catalog.title-index.bad-id', path);
  const work = worksById.get(index.workId);
  if (work === undefined) found('catalog.title-index.work-missing', path, index.workId);
  else if (work.status === 'merged' || !Array.isArray(work.titleKeys) || !work.titleKeys.includes(index.titleKey)) {
    found('catalog.title-index.work-mismatch', path, index.workId);
  } else if (index.status !== work.status) {
    found('catalog.title-index.status-mismatch', path, `${index.status} != ${String(work.status)}`);
  }
  const pair = `${index.workId}\0${index.titleKey}`;
  titleRowsByPair.set(pair, [...(titleRowsByPair.get(pair) ?? []), indexDoc.id]);
}
for (const [workId, work] of worksById) {
  if (work.status === 'merged' || !Array.isArray(work.titleKeys)) continue;
  for (const titleKey of work.titleKeys) {
    if (typeof titleKey !== 'string') continue;
    const rows = titleRowsByPair.get(`${workId}\0${titleKey}`) ?? [];
    if (rows.length !== 1) found('catalog.work.title-index-count', `works/${workId}`, `${titleKey}: ${rows.length}`);
  }
}

const publicProfilesByUsername = new Map(
  publicProfiles.docs.map((profile) => [profile.id, profile.data()]),
);
for (const discovery of profileDiscoveries.docs) {
  const marker = discovery.data();
  const path = discovery.ref.path;
  if (!/^[a-z0-9-]{3,30}$/.test(discovery.id)) {
    found('profile-discovery.bad-username', path, discovery.id);
  }
  if (
    Object.keys(marker).sort().join(',') !== 'createdAt,uid' ||
    typeof marker.uid !== 'string' ||
    marker.uid === '' ||
    !(marker.createdAt instanceof Timestamp)
  ) {
    found('profile-discovery.bad-shape', path, JSON.stringify(marker));
  }
  const profile = publicProfilesByUsername.get(discovery.id);
  if (profile === undefined) {
    found('profile-discovery.profile-missing', path);
  } else {
    if (profile.uid !== marker.uid) {
      found('profile-discovery.owner-mismatch', path, `${String(marker.uid)} != ${String(profile.uid)}`);
    }
    if (profile.public !== true) {
      found('profile-discovery.profile-private', path);
    }
    // Deletion prunes the account's markers (SEC-006 follow-up); one left
    // on a tombstoned profile is the trigger's job half done, and the
    // tombstone leaves `public` true, so the check above cannot see it.
    if (profile.deletedAt !== undefined) {
      found('profile-discovery.profile-tombstoned', path);
    }
  }
}

// Rules-sitting invariants (2026-08-29): a profile belongs to a verified,
// existing account and is named by exactly one profileOwners/{uid} record,
// which the client moves in every profile batch. A profile without its
// record is the legacy shape (migrate-profile-owners.ts backfills it); a
// record without its profile, or naming a profile that is not the
// account's, is drift the rules should have made impossible.
const ownerRecordsByUid = new Map(profileOwners.docs.map((record) => [record.id, record.data()]));
// Account deletion is a soft delete (SEC-006): users/{uid} and the
// account's profiles carry deletedAt and nothing is removed. A profile of
// a tombstoned account without its own tombstone is still public — the
// trigger's job left undone; a tombstoned profile on a live account is
// drift no path produces. Tombstoned profiles are not client-writable, so
// the rules-shape mirror (which would flag deletedAt) does not apply.
const tombstonedUsers = new Set(
  userProfiles.docs.filter((d) => d.get('deletedAt') !== undefined).map((d) => d.id),
);
for (const user of userProfiles.docs) {
  const deletedAt = user.get('deletedAt');
  if (deletedAt !== undefined && !(deletedAt instanceof Timestamp)) {
    found('user.bad-tombstone', user.ref.path, JSON.stringify(deletedAt));
  }
}

// SEC-004: the credential lives only in secrets:togglTokens/{uid}; the
// user document carries a status-only mirror. A token still on a user
// document is the pre-migration state and a live client-readable
// credential — the finding every other check here exists to prevent.
const togglSecretUids = new Set(togglTokens.docs.map((d) => d.id));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const togglStatusShape = (toggl: Record<string, unknown>): boolean =>
  Object.keys(toggl).sort().join(',') === 'connectedAt,projectId,workspaceId' &&
  toggl.connectedAt instanceof Timestamp &&
  Number.isInteger(toggl.workspaceId) && (toggl.workspaceId as number) > 0 &&
  Number.isInteger(toggl.projectId) && (toggl.projectId as number) > 0;
for (const user of userProfiles.docs) {
  const toggl: unknown = user.get('toggl');
  if (toggl === undefined) continue;
  if (!isRecord(toggl)) {
    found('user.toggl-status.bad-shape', user.ref.path, typeof toggl);
    continue;
  }
  if ('apiToken' in toggl) {
    found('user.toggl-legacy-token', user.ref.path, 'credential stored client-readable');
    continue;
  }
  if (!togglStatusShape(toggl)) {
    found('user.toggl-status.bad-shape', user.ref.path, Object.keys(toggl).sort().join(','));
    continue;
  }
  // A tombstoned account keeps its status mirror while the trigger
  // deletes the credential, so the orphan check is for live accounts.
  if (!togglSecretUids.has(user.id) && !tombstonedUsers.has(user.id)) {
    found('user.toggl-status-orphan', user.ref.path);
  }
}
for (const secret of togglTokens.docs) {
  const data = secret.data();
  const path = `secrets:${secret.ref.path}`;
  const keys = Object.keys(data).sort().join(',');
  if (
    keys !== 'apiToken,projectId,updatedAt,workspaceId' ||
    typeof data.apiToken !== 'string' || data.apiToken === '' ||
    !Number.isInteger(data.workspaceId) || data.workspaceId <= 0 ||
    !Number.isInteger(data.projectId) || data.projectId <= 0 ||
    !(data.updatedAt instanceof Timestamp)
  ) {
    found('toggl-secret.bad-shape', path, keys);
    continue;
  }
  if (!existingUsers.has(secret.id)) {
    found('toggl-secret.account-missing', path, secret.id);
    continue;
  }
  if (tombstonedUsers.has(secret.id)) {
    found('toggl-secret.tombstoned', path, secret.id);
    continue;
  }
  const status: unknown = userProfiles.docs.find((d) => d.id === secret.id)?.get('toggl');
  if (!isRecord(status) || 'apiToken' in status) {
    found('toggl-secret.status-missing', path);
  } else if (status.workspaceId !== data.workspaceId || status.projectId !== data.projectId) {
    found('toggl-secret.status-mismatch', path, `${String(status.workspaceId)}/${String(status.projectId)} != ${String(data.workspaceId)}/${String(data.projectId)}`);
  }
}
for (const profile of publicProfiles.docs) {
  const data = profile.data();
  const path = profile.ref.path;
  const tombstoned = data.deletedAt !== undefined;
  if (tombstoned && !(data.deletedAt instanceof Timestamp)) {
    found('profile.bad-tombstone', path, JSON.stringify(data.deletedAt));
  }
  if (!tombstoned) {
    for (const violation of profileShapeViolations(data, String(data.uid))) {
      found('profile.rules-shape', path, violation);
    }
  }
  if (typeof data.uid !== 'string') continue;
  if (!existingUsers.has(data.uid)) found('profile.account-missing', path, data.uid);
  if (tombstonedUsers.has(data.uid) && !tombstoned) found('profile.tombstone-missing', path, data.uid);
  if (!tombstonedUsers.has(data.uid) && tombstoned) found('profile.tombstone-orphan', path, data.uid);
  const record = ownerRecordsByUid.get(data.uid);
  if (record === undefined) found('profile.owner-record-missing', path, `profileOwners/${data.uid}`);
  else if (record.username !== profile.id) {
    found('profile.owner-record-mismatch', path, `profileOwners/${data.uid} names ${String(record.username)}`);
  }
}
for (const record of profileOwners.docs) {
  const data = record.data();
  const path = record.ref.path;
  for (const violation of profileOwnerRecordViolations(data)) found('profile-owner.bad-shape', path, violation);
  if (typeof data.username !== 'string') continue;
  const profile = publicProfilesByUsername.get(data.username);
  if (profile === undefined) found('profile-owner.profile-missing', path, data.username);
  else if (profile.uid !== record.id) {
    found('profile-owner.uid-mismatch', path, `${data.username} belongs to ${String(profile.uid)}`);
  }
}

// Author/catalog bookkeeping. Shared authors may legitimately be unreferenced
// because they remain useful for autocomplete. Personal author documents are
// legacy state and are findings below; the counts make migration drift visible.
let legacyAuthorDocCount = 0;
let catalogLinkedBookCount = 0;
let bookSharingSettingCount = 0;
const consentedSharingUsers = new Set<string>();

// The backend judges consent with sharing-consent.ts; the audit adds one
// assertion the backend deliberately does not make, that the setting
// document carries exactly its four keys with both timestamps. A row that
// fails the shape is reported once and not restated as a consent finding.
const auditSharingSetting = (
  userId: string,
  path: string,
  setting: Record<string, unknown>,
): boolean => {
  if (
    Object.keys(setting).sort().join(',') !== [...SHARING_SETTING_KEYS].join(',') ||
    !(setting.createdAt instanceof Timestamp) || !(setting.updatedAt instanceof Timestamp) ||
    typeof setting.profileUsername !== 'string' ||
    !SHARING_USERNAME.test(setting.profileUsername) ||
    !validTimeZone(setting.timeZone)
  ) {
    found('book-sharing.bad-shape', path, JSON.stringify(setting));
    return false;
  }
  if (!existingUsers.has(userId)) {
    found('book-sharing.user-missing', path, userId);
    return false;
  }
  const profile = publicProfilesByUsername.get(setting.profileUsername);
  if (profile === undefined) {
    found('book-sharing.profile-missing', path, setting.profileUsername);
    return false;
  }
  if (profile.uid !== userId || profile.public !== true) {
    found('book-sharing.profile-not-public-owner', path, setting.profileUsername);
    return false;
  }
  return sharingConsentIsValid(userId, userProfilesById.get(userId), setting, profile);
};
const linkedOwnerWorkPairs = new Set<string>();

for (const user of users) {
  const books = await user.collection('books').get();
  const lifecycle = await user.collection('timerLifecycle').doc('current').get();
  const bookSharing = await user.collection('settings').doc('bookSharing').get();
  const setting = bookSharing.data();
  if (setting !== undefined) {
    bookSharingSettingCount += 1;
    if (auditSharingSetting(user.id, bookSharing.ref.path, setting)) {
      consentedSharingUsers.add(user.id);
    }
  }
  for (const finding of auditTimerClaimState(
    books.docs.map((book) => ({id: book.id, data: book.data()})),
    {exists: lifecycle.exists, data: lifecycle.data()},
  )) {
    found(finding.cls, lifecycle.ref.path, finding.detail);
  }

  // Personal author subcollections are retired but retained (the migration
  // never deletes; SEC-006). A retained document is a count, not drift;
  // one a book still points at is the straggler the migration left for
  // review, and that book cannot be edited until it is resolved.
  const authorDocs = await user.collection('authors').get();
  legacyAuthorDocCount += authorDocs.size;
  const legacyAuthorIds = new Set(authorDocs.docs.map((authorDoc) => authorDoc.id));
  for (const book of books.docs) {
    const ids = book.data().authorIds;
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      if (typeof id === 'string' && legacyAuthorIds.has(id)) {
        found('catalog.author.legacy-personal-doc-referenced', book.ref.path, id);
      }
    }
  }

  // A tombstoned account (SEC-006 soft delete) is frozen: the catalog
  // migration skips it and no client can edit its books, so the fields
  // those two would have added are not drift anyone can act on.
  const tombstoned = tombstonedUsers.has(user.id);

  for (const book of books.docs) {
    const b = book.data();
    const p = book.ref.path;
    for (const violation of bookShapeViolations(b, user.path)) found('book.rules-shape', p, violation);

    const requiredBookFields = ['createdAt', 'updatedAt', 'authorIds', 'isbn', 'owner', 'pagesRead', 'timeRead', 'finished', 'currentPage', 'currentPageUpdateId', 'pageCount', 'coverUrl', 'publisher', 'publishedDate', 'subjects', 'fiction'];
    if (!tombstoned) requiredBookFields.push('workId', 'editionId', 'matchMethod', 'linkedAt');
    for (const field of requiredBookFields) {
      if (b[field] === undefined) found(`book.missing.${field}`, p);
    }
    if (b.workId === null) {
      if (b.editionId !== null || b.matchMethod !== null || b.linkedAt !== null) {
        found('catalog.book.null-link-mismatch', p, `${String(b.editionId)}/${String(b.matchMethod)}/${String(b.linkedAt)}`);
      }
    } else if (typeof b.workId === 'string') {
      catalogLinkedBookCount += 1;
      linkedOwnerWorkPairs.add(`${user.id}\0${b.workId}`);
      const resolvedWork = resolveCatalogWork(b.workId);
      if (resolvedWork.id === null) found('catalog.book.work-unresolved', p, b.workId);
      if (resolvedWork.hops > 1) found('catalog.book.work-not-one-hop', p, b.workId);
      if (!(b.linkedAt instanceof Timestamp) || !['isbn', 'external-id', 'catalog-choice', 'migration', 'admin'].includes(b.matchMethod)) {
        found('catalog.book.bad-provenance', p, `${String(b.matchMethod)}/${String(b.linkedAt)}`);
      }
      if (b.editionId !== null) {
        const edition = typeof b.editionId === 'string' ? editionsById.get(b.editionId) : undefined;
        if (edition === undefined) {
          found('catalog.book.edition-missing', p, String(b.editionId));
        } else {
          const editionWork = typeof edition.workId === 'string' ? resolveCatalogWork(edition.workId) : {id: null, hops: 0, cycle: false};
          if (resolvedWork.id === null || resolvedWork.id !== editionWork.id) {
            found('catalog.book.edition-work-mismatch', p, `${b.workId}/${String(edition.workId)}`);
          }
        }
      }
      if (b.matchMethod === 'isbn') {
        const normalizedBookIsbn = normalizeIsbn(typeof b.isbn === 'string' ? b.isbn : '');
        const index = normalizedBookIsbn ? isbnIndexesById.get(normalizedBookIsbn) : undefined;
        const indexedWork = typeof index?.workId === 'string' ? resolveCatalogWork(index.workId) : {id: null, hops: 0, cycle: false};
        if (!normalizedBookIsbn || index === undefined || index.editionId !== b.editionId || indexedWork.id !== resolvedWork.id) {
          found('catalog.book.isbn-provenance-mismatch', p, normalizedBookIsbn ?? String(b.isbn));
        }
      }
    } else if (b.workId !== undefined) {
      found('catalog.book.bad-work-id', p, String(b.workId));
    }
    // ISBN-derived metadata shapes (see utils/bookMetadata.ts); the string
    // fields ride the missing check above, these two have structure.
    if (b.subjects !== undefined && (!Array.isArray(b.subjects) || b.subjects.some((s) => typeof s !== 'string' || s === ''))) {
      found('book.subjects-bad-shape', p, JSON.stringify(b.subjects));
    }
    if (b.fiction !== undefined && b.fiction !== null && typeof b.fiction !== 'boolean') {
      found('book.bad-fiction', p, String(b.fiction));
    }
    for (const field of ['currentPage', 'pageCount', 'pagesRead', 'timeRead']) {
      if (b[field] !== undefined && !Number.isFinite(b[field])) {
        found(`book.nonnumeric.${field}`, p, String(b[field]));
      }
    }
    if (b.finished === true && b.currentPage === undefined && b.pageCount === undefined) {
      found('book.finished-no-pages', p);
    } else if (b.finished === true && !isFinished(b.currentPage, b.pageCount)) {
      found('book.finished-pages-disagree', p, `${b.currentPage}/${b.pageCount}`);
    }
    if (b.finished !== true && isFinished(b.currentPage, b.pageCount)) {
      found('book.unfinished-pages-equal', p, `${b.currentPage}/${b.pageCount}`);
    }
    // finishedAt: stamped by the client when finished flips, backfilled by
    // migrate-finished-at.ts; a finished book without it is migration drift.
    if (b.finished === true && !(b.finishedAt instanceof Timestamp) && !tombstoned) {
      found('book.finished-without-finishedAt', p);
    }
    if (Number.isFinite(b.currentPage) && Number.isFinite(b.pageCount) && b.currentPage > b.pageCount) {
      found('book.page-overrun', p, `${b.currentPage}/${b.pageCount}`);
    }
    if (b.activeTimer) found('book.active-timer', p, JSON.stringify(b.activeTimer));

    // Author references: every id resolves to an author doc, no dupes.
    if (b.authorIds !== undefined) {
      if (
        !Array.isArray(b.authorIds) ||
        b.authorIds.some((id) => typeof id !== 'string' || id === '') ||
        new Set(b.authorIds).size !== b.authorIds.length
      ) {
        found('book.authorids-bad-shape', p, JSON.stringify(b.authorIds));
      } else {
        for (const id of b.authorIds) {
          const resolution = resolveCatalogAuthor(id);
          if (resolution.id === null) found('catalog.book.author-unresolved', p, id);
          // A one-hop merged alias is a supported cached/offline reference.
          // The next metadata edit resolves it to the active author.
        }
      }
    }

    // Legacy authorship fields mean the last writer was an old client (the
    // current client deletes them on every write): this is the migration
    // pre-flight before the authorIds run, and the straggler detector
    // after it — a migration re-run clears it either way.
    if (b.author !== undefined || b.authors !== undefined) {
      const which = ['author', 'authors'].filter((f) => b[f] !== undefined).join('+');
      found('book.legacy-author-field', p, which);
      if (Array.isArray(b.authors)) {
        for (const a of b.authors) if (typeof a?.id !== 'string') found('book.legacy-author-id-bad', p);
      }
    }

    const updates = await book.ref.collection('updates').get();
    for (const finding of auditReadingProgressSource(
      b,
      updates.docs.map((update) => ({id: update.id, data: update.data()})),
    )) {
      found(finding.cls, p, finding.detail);
    }
    for (const update of updates.docs) {
      const u = update.data();
      const up = update.ref.path;
      if (!['reading', 'update'].includes(u.type)) found('update.bad-type', up, String(u.type));
      if (u.owner === undefined) found('update.missing.owner', up);
      else if (u.owner?.path !== user.path) found('update.owner-mismatch', up, String(u.owner?.path));
      if (u.createdAt === undefined) found('update.missing.createdAt', up);
      if (u.book === undefined) found('update.missing.book', up);
      else if (u.book?.path !== p) found('update.book-mismatch', up, String(u.book?.path));
      if (Number.isFinite(u.fromPage) && Number.isFinite(u.toPage) && u.pagesRead !== u.toPage - u.fromPage) {
        found('update.pages-arithmetic', up, `${u.fromPage}->${u.toPage} pagesRead=${u.pagesRead}`);
      }
    }
  }

}

const projectedPairs = new Set<string>();
for (const projection of sharedWorkOwners.docs) {
  const data = projection.data();
  const path = projection.ref.path;
  if (
    Object.keys(data).sort().join(',') !== 'uid,updatedAt,workId' ||
    typeof data.uid !== 'string' || data.uid === '' || data.uid.includes('/') ||
    typeof data.workId !== 'string' || data.workId === '' || data.workId.includes('/') ||
    !(data.updatedAt instanceof Timestamp)
  ) {
    found('book-sharing.projection-bad-shape', path, JSON.stringify(data));
    continue;
  }
  const pair = `${data.uid}\0${data.workId}`;
  projectedPairs.add(pair);
  if (projection.id !== deterministicSharedWorkOwnerId(data.workId, data.uid)) {
    found('book-sharing.projection-bad-id', path, pair);
  }
  if (!existingUsers.has(data.uid)) found('book-sharing.projection-user-missing', path, data.uid);
  if (!worksById.has(data.workId)) found('book-sharing.projection-work-missing', path, data.workId);
  if (!consentedSharingUsers.has(data.uid)) found('book-sharing.projection-without-consent', path, data.uid);
  if (!linkedOwnerWorkPairs.has(pair)) found('book-sharing.projection-without-book', path, pair);
}
for (const pair of linkedOwnerWorkPairs) {
  const separator = pair.indexOf('\0');
  const uid = pair.slice(0, separator);
  const workId = pair.slice(separator + 1);
  if (consentedSharingUsers.has(uid) && !projectedPairs.has(pair)) {
    found('book-sharing.projection-missing', `sharedWorkOwners/${deterministicSharedWorkOwnerId(workId, uid)}`, pair);
  }
}

// Orphans: parents that are listable but do not exist as documents, with
// children underneath. Report-only, never repaired (see migrate-add-owner).
for (const ref of users) {
  if (!existingUsers.has(ref.id)) found('orphan.user', ref.path);
}
for (const user of users) {
  const listedBooks = await user.collection('books').listDocuments();
  const existing = new Set((await user.collection('books').get()).docs.map((d) => d.id));
  for (const ref of listedBooks) {
    if (!existing.has(ref.id)) found('orphan.book', ref.path);
  }
}

findings.sort((a, b) => (a.cls === b.cls ? (a.path < b.path ? -1 : 1) : a.cls < b.cls ? -1 : 1));
for (const f of findings) {
  console.log(`${f.cls} ${f.path}${f.detail ? ` [${f.detail}]` : ''}`);
}
console.log('---');
const counts: Record<string, number> = {};
for (const f of findings) counts[f.cls] = (counts[f.cls] ?? 0) + 1;
for (const cls of Object.keys(counts).sort()) console.log(`${cls}: ${counts[cls]}`);
console.log(`user-documents: ${userProfiles.size}`);
console.log(`user-refs: ${users.length}`);
console.log(`phantom-users: ${users.filter((user) => !existingUsers.has(user.id)).length}`);
console.log(`catalog-authors: ${catalogAuthors.size}`);
console.log(`legacy-personal-author-docs: ${legacyAuthorDocCount}`);
console.log(`public-profiles: ${publicProfiles.size}`);
console.log(`profile-discoveries: ${profileDiscoveries.size}`);
console.log(`profile-owners: ${profileOwners.size}`);
console.log(`deleted-accounts: ${tombstonedUsers.size}`);
console.log(`catalog-works: ${works.size}`);
console.log(`catalog-editions: ${editions.size}`);
console.log(`catalog-isbn-indexes: ${isbnIndexes.size}`);
console.log(`catalog-external-id-indexes: ${externalIdIndexes.size}`);
console.log(`catalog-title-indexes: ${workTitleIndexes.size}`);
console.log(`shared-work-owners: ${sharedWorkOwners.size}`);
console.log(`catalog-linked-books: ${catalogLinkedBookCount}`);
console.log(`book-sharing-settings: ${bookSharingSettingCount}`);
console.log(`toggl-secrets: ${togglTokens.size}`);
console.log(`findings: ${findings.length}`);
