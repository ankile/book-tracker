// Historical owner-reference migration. Kept runnable for repairing stale
// update documents, with the same emulator-first and dry-run safeguards as
// every other migration in this toolbox.
//
//   node migrate-add-owner.ts                    # emulator dry-run
//   node migrate-add-owner.ts --apply            # emulator apply
//   node migrate-add-owner.ts --prod             # prod dry-run
//   node migrate-add-owner.ts --prod --apply     # prod apply (typed confirm)
import { parseFlags, connect, batcher } from './migrate-lib.ts';

const flags = parseFlags(process.argv.slice(2));
const { db } = await connect({ ...flags, confirmWrite: flags.apply });
const writes = batcher(db, { apply: flags.apply });
const tag = flags.apply ? 'UPDATE' : 'DRY';

// Enumerating users and books with .get() is load-bearing: .get() skips
// missing-ancestor documents, so updates orphaned under a deleted book (or
// deleted user doc) are never backfilled. That is deliberate: giving an
// orphan an owner would resurrect a deleted book's sessions into the
// heatmap. Do not switch to listDocuments(), which surfaces those parents.
async function migrateOwnerToReadingSessions(): Promise<void> {
  const usersSnapshot = await db.collection('users').get();

  for (const userDoc of usersSnapshot.docs) {
    const ownerRef = userDoc.ref;
    const booksSnapshot = await userDoc.ref.collection('books').get();

    for (const bookDoc of booksSnapshot.docs) {
      const updatesSnapshot = await bookDoc.ref.collection('updates').get();

      for (const updateDoc of updatesSnapshot.docs) {
        // Every doc in the subcollection belongs to the path's user, so
        // owner applies regardless of type ('reading' and 'update' alike).
        if (updateDoc.data().owner) continue;

        console.log(`${tag} ${updateDoc.ref.path} owner := ${ownerRef.path}`);
        await writes.update(updateDoc.ref, { owner: ownerRef });
      }
    }
  }

  await writes.flush();
  console.log(
    `${writes.count()} update owners ${flags.apply ? 'applied' : '(dry run, nothing written)'}`,
  );
}

await migrateOwnerToReadingSessions();
