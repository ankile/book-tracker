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
import { AUTHOR_KINDS, joinPersonName } from './src/lib/utils/authors.ts';
import { auditTimerClaimState } from './timer-claim-migration.ts';
import { auditReadingProgressSource } from './reading-progress-source-migration.ts';
import { Timestamp } from 'firebase-admin/firestore';
import {
  authorShapeViolations,
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
const existingUsers = new Set(userProfiles.docs.map((d) => d.id));

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
const togglStatusShape = (toggl: Record<string, unknown>): boolean =>
  Object.keys(toggl).sort().join(',') === 'connectedAt,projectId,workspaceId' &&
  toggl.connectedAt instanceof Timestamp &&
  Number.isInteger(toggl.workspaceId) && (toggl.workspaceId as number) > 0 &&
  Number.isInteger(toggl.projectId) && (toggl.projectId as number) > 0;
for (const user of userProfiles.docs) {
  const toggl = user.get('toggl') as Record<string, unknown> | undefined;
  if (toggl === undefined) continue;
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
  const status = userProfiles.docs.find((d) => d.id === secret.id)?.get('toggl') as Record<string, unknown> | undefined;
  if (status === undefined || 'apiToken' in status) {
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

// Info-level author bookkeeping (summary lines, not findings): orphaned
// author docs are a legitimate steady state — deleting or editing a book
// never garbage-collects its authors, and an orphan is still useful for
// autocomplete — but the counts make drift visible in audit diffs.
let authorDocCount = 0;
let authorOrphanCount = 0;

for (const user of users) {
  const books = await user.collection('books').get();
  const lifecycle = await user.collection('timerLifecycle').doc('current').get();
  for (const finding of auditTimerClaimState(
    books.docs.map((book) => ({id: book.id, data: book.data()})),
    {exists: lifecycle.exists, data: lifecycle.data()},
  )) {
    found(finding.cls, lifecycle.ref.path, finding.detail);
  }

  // Author entity checks: doc shape only. Ids are deterministic at
  // creation but OPAQUE afterward (rename edits name/nameLower in place),
  // so id === authorIdFor(name) is deliberately NOT an invariant.
  const authorDocs = await user.collection('authors').get();
  const authorDocIds = new Set(authorDocs.docs.map((d) => d.id));
  const mergedTargets = new Map<string, string>();
  authorDocCount += authorDocs.size;
  for (const authorDoc of authorDocs.docs) {
    const a = authorDoc.data();
    const ap = authorDoc.ref.path;
    for (const violation of authorShapeViolations(a)) found('authordoc.rules-shape', ap, violation);
    if (typeof a.name !== 'string' || a.name.trim() === '') {
      found('authordoc.bad-name', ap, JSON.stringify(a.name));
    } else if (a.nameLower !== a.name.toLowerCase()) {
      found('authordoc.namelower-mismatch', ap, `${a.nameLower} != ${a.name.toLowerCase()}`);
    }
    if (!AUTHOR_KINDS.includes(a.kind)) found('authordoc.bad-kind', ap, String(a.kind));
    // Persons carry explicit name parts; the stored name is exactly their
    // join, so display, sorting, and abbreviation can never disagree.
    if (a.kind === 'person') {
      if (typeof a.familyName !== 'string' || a.familyName.trim() === '') {
        found('authordoc.missing-familyname', ap, a.name);
      } else {
        if (a.givenName !== undefined && (typeof a.givenName !== 'string' || a.givenName.trim() === '')) {
          found('authordoc.bad-givenname', ap, JSON.stringify(a.givenName));
        }
        const joined = joinPersonName({ givenName: a.givenName ?? '', familyName: a.familyName });
        if (a.name !== joined) found('authordoc.name-parts-mismatch', ap, `${a.name} != ${joined}`);
      }
    } else if (a.givenName !== undefined || a.familyName !== undefined) {
      found('authordoc.parts-on-nonperson', ap, a.name);
    }
    if (a.retirement !== undefined) {
      const retirement = a.retirement;
      if (typeof retirement !== 'object' || retirement === null || Array.isArray(retirement)) {
        found('authordoc.bad-retirement', ap, JSON.stringify(retirement));
      } else if (
        retirement.reason === 'deleted' &&
        Object.keys(retirement).length === 1
      ) {
        // A soft-deleted doc remains as a safe resolution target for a
        // stale/offline book write.
      } else if (
        retirement.reason === 'merged' &&
        typeof retirement.targetId === 'string' &&
        retirement.targetId !== authorDoc.id &&
        Object.keys(retirement).length === 2
      ) {
        mergedTargets.set(authorDoc.id, retirement.targetId);
      } else {
        found('authordoc.bad-retirement', ap, JSON.stringify(retirement));
      }
    }
  }

  for (const [sourceId, targetId] of mergedTargets) {
    if (!authorDocIds.has(targetId)) {
      found('authordoc.merge-target-missing', `${user.path}/authors/${sourceId}`, targetId);
      continue;
    }
    const visited = new Set<string>();
    let current = sourceId;
    while (mergedTargets.has(current)) {
      if (visited.has(current)) {
        found('authordoc.merge-cycle', `${user.path}/authors/${sourceId}`, [...visited, current].join(' -> '));
        break;
      }
      visited.add(current);
      const next = mergedTargets.get(current);
      if (next === undefined) throw new Error('Known merged author has no target.');
      current = next;
    }
  }

  const canonicalAuthorId = (id: string): string => {
    const visited = new Set<string>();
    let current = id;
    while (mergedTargets.has(current)) {
      if (visited.has(current)) return id;
      visited.add(current);
      const target = mergedTargets.get(current);
      if (target === undefined || !authorDocIds.has(target)) return id;
      current = target;
    }
    return current;
  };

  const referencedAuthorIds = new Set<string>();

  for (const book of books.docs) {
    const b = book.data();
    const p = book.ref.path;
    for (const violation of bookShapeViolations(b, user.path)) found('book.rules-shape', p, violation);

    for (const field of ['createdAt', 'updatedAt', 'authorIds', 'isbn', 'owner', 'pagesRead', 'timeRead', 'finished', 'currentPage', 'currentPageUpdateId', 'pageCount', 'coverUrl', 'publisher', 'publishedDate', 'subjects', 'fiction']) {
      if (b[field] === undefined) found(`book.missing.${field}`, p);
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
          referencedAuthorIds.add(id);
          referencedAuthorIds.add(canonicalAuthorId(id));
          if (!authorDocIds.has(id)) found('book.author-doc-missing', p, id);
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
        for (const a of b.authors) {
          referencedAuthorIds.add(a.id);
          referencedAuthorIds.add(canonicalAuthorId(a.id));
        }
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
      if (u.createdAt === undefined) found('update.missing.createdAt', up);
      if (u.book === undefined) found('update.missing.book', up);
      if (Number.isFinite(u.fromPage) && Number.isFinite(u.toPage) && u.pagesRead !== u.toPage - u.fromPage) {
        found('update.pages-arithmetic', up, `${u.fromPage}->${u.toPage} pagesRead=${u.pagesRead}`);
      }
    }
  }

  for (const authorDoc of authorDocs.docs) {
    if (!referencedAuthorIds.has(authorDoc.id)) authorOrphanCount += 1;
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
console.log(`author-docs: ${authorDocCount}`);
console.log(`author-orphans: ${authorOrphanCount}`);
console.log(`public-profiles: ${publicProfiles.size}`);
console.log(`profile-discoveries: ${profileDiscoveries.size}`);
console.log(`profile-owners: ${profileOwners.size}`);
console.log(`deleted-accounts: ${tombstonedUsers.size}`);
console.log(`toggl-secrets: ${togglTokens.size}`);
console.log(`findings: ${findings.length}`);
