// Physical purge of ONE tombstoned account (SEC-006). Account deletion is
// a soft delete: deleteUserDocument stamps deletedAt on users/{uid} and
// on the account's profiles and removes nothing but the account's
// discovery markers. This script is the only path that removes the data,
// and it is an operator decision per account, never scheduled: one uid
// per run, dry-run by default, and it refuses a document that is not
// tombstoned and an account that still exists in Auth (a tombstone is
// only ever written by the deletion trigger; one on a live account is
// drift, and purging it would destroy a working account's data).
//
// What goes, in this order: every profile of the uid together with its
// discovery marker (only while the marker still names this uid — a freed
// username is first-writer-wins), the ownership record, then the whole
// users/{uid} tree (books with their updates, authors, timerLifecycle,
// togglQueue, functionQuotas) by recursiveDelete. A book delete in
// production also fires deletebookupdates, which is idempotent with the
// recursive delete. Take a snapshot first (db-snapshot.ts --prod), as the
// playbook says — this is the one migration that is not reversible from
// the database itself.
//
//   node migrate-purge-deleted-accounts.ts <uid>                  # emulator dry-run
//   node migrate-purge-deleted-accounts.ts <uid> --apply          # emulator apply
//   node migrate-purge-deleted-accounts.ts <uid> --prod           # prod dry-run
//   node migrate-purge-deleted-accounts.ts <uid> --prod --apply   # prod apply (typed confirm)
import { getAuth } from 'firebase-admin/auth';
import type { DocumentReference } from 'firebase-admin/firestore';
import { parseFlags, connect, batcher } from './migrate-lib.ts';

const flags = parseFlags(process.argv.slice(2));
if (flags.rest.length !== 1) throw new Error('usage: migrate-purge-deleted-accounts.ts <uid> [--prod] [--apply]');
const [uid] = flags.rest;
const { db } = await connect({ ...flags, confirmWrite: flags.apply });
const writes = batcher(db, { apply: flags.apply });
const tag = flags.apply ? 'DELETE' : 'DRY';

// Auth first: the account must be gone there. getUser throws
// auth/user-not-found for a deleted (or never-created) uid; any other
// outcome, including a network error, stops the run.
try {
  await getAuth().getUser(uid);
  throw new Error(`${uid} still exists in Auth; refusing to purge a live account`);
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'auth/user-not-found')) throw error;
}
console.log(`${uid} is not in Auth`);

const userRef = db.collection('users').doc(uid);
const user = await userRef.get();
// The live-account guard runs only when the document is present: a
// missing root means the account never existed OR a prior partial purge
// already removed it. Either way there is nothing live to protect, and a
// re-run must be able to finish an interrupted purge (clean the public
// docs and any orphaned subcollections) rather than throw. A present
// document with no deletedAt is a live account — refuse.
if (user.exists) {
  const deletedAt = user.get('deletedAt');
  if (deletedAt === undefined) {
    throw new Error(`${userRef.path} is not tombstoned (no deletedAt); refusing to purge a live account`);
  }
  console.log(`${userRef.path} tombstoned at ${deletedAt.toDate().toISOString()}`);
} else {
  console.log(`${userRef.path} is absent — cleaning any orphaned data from an earlier partial purge`);
}

const profiles = await db.collection('profiles').where('uid', '==', uid).get();
for (const profile of profiles.docs) {
  const marker = await db.collection('profileDiscovery').doc(profile.id).get();
  if (marker.exists && marker.get('uid') === uid) {
    console.log(`${tag} ${marker.ref.path}`);
    await writes.delete(marker.ref);
  }
  console.log(`${tag} ${profile.ref.path}`);
  await writes.delete(profile.ref);
}
const owner = await db.collection('profileOwners').doc(uid).get();
if (owner.exists) {
  console.log(`${tag} ${owner.ref.path}`);
  await writes.delete(owner.ref);
}
await writes.flush();

// The tree: counted by listing (so orphans under a missing root count
// too), removed subcollection by subcollection with recursiveDelete, and
// the root document deleted LAST. Root-last is what makes a re-run of an
// interrupted purge safe: while the root is still present the guard above
// re-verifies the tombstone, and once it is gone a re-run treats the
// account as absent and cleans whatever orphans remain, ending at 0 writes.
async function countTree(ref: DocumentReference): Promise<number> {
  let count = (await ref.get()).exists ? 1 : 0;
  for (const collection of await ref.listCollections()) {
    for (const child of await collection.listDocuments()) count += await countTree(child);
  }
  return count;
}
const treeSize = await countTree(userRef);
console.log(`${tag} ${userRef.path} tree: ${treeSize} documents`);
if (flags.apply) {
  for (const collection of await userRef.listCollections()) {
    await db.recursiveDelete(collection);
  }
  await userRef.delete();
}

console.log(
  `${writes.count()} public documents and a ${treeSize}-document tree ${flags.apply ? 'deleted' : '(dry run, nothing written)'}`,
);
