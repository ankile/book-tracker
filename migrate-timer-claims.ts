// One-time rollout migration for the per-user timer claim.
//
// Run after timer-correlation rules and claim-aware Functions are deployed,
// after old start invocations have drained, and before the claim-aware client
// is hosted. The new rules block every uncorrelated client timer mutation.
// New Functions fail closed while timerLifecycle/current is absent. Each
// apply transaction audits every book, upgrades a legacy local timer with a
// deterministic operation id when needed, and writes the matching lifecycle
// document atomically. Malformed or multiple active timers crash.
//
//   node migrate-timer-claims.ts                    # emulator dry-run
//   node migrate-timer-claims.ts --apply            # emulator apply
//   node migrate-timer-claims.ts --prod             # prod dry-run
//   node migrate-timer-claims.ts --prod --apply     # prod apply (typed confirm)
import { parseFlags, connect } from './migrate-lib.ts';
import type { DocumentSnapshot } from 'firebase-admin/firestore';
import {
  planTimerClaim,
  decodeMigratedTimerClaim,
  timerClaimPlanIsApplied,
  type MigratedTimerClaim,
} from './timer-claim-migration.ts';

const flags = parseFlags(process.argv.slice(2));
if (flags.rest.length > 0) throw new Error(`unexpected arguments: ${flags.rest.join(' ')}`);
const { db } = await connect({ ...flags, confirmWrite: flags.apply });

function claimFromSnapshot(snapshot: DocumentSnapshot): MigratedTimerClaim | null {
  if (!snapshot.exists) return null;
  return decodeMigratedTimerClaim(snapshot.data());
}

let writes = 0;
const users = await db.collection('users').get();
for (const user of users.docs) {
  const claimRef = user.ref.collection('timerLifecycle').doc('current');
  const inspect = async () => {
    const [books, claim] = await Promise.all([
      user.ref.collection('books').get(),
      claimRef.get(),
    ]);
    const planned = planTimerClaim(books.docs.map((book) => ({ id: book.id, data: book.data() })));
    return {
      planned,
      current: claimFromSnapshot(claim),
      marked: claim.exists,
    };
  };
  const inspected = await inspect();
  if (inspected.marked) {
    if (!timerClaimPlanIsApplied(inspected.planned, inspected.current)) {
      throw new Error(`users/${user.id} lifecycle conflicts with its active books`);
    }
    continue;
  }
  console.log(`${flags.apply ? 'MIGRATE' : 'DRY'} users/${user.id} timer=${inspected.planned.claim.state}`);
  writes += 1;
  if (!flags.apply) continue;
  await db.runTransaction(async (tx) => {
    const [freshUser, books, claim] = await Promise.all([
      tx.get(user.ref),
      tx.get(user.ref.collection('books')),
      tx.get(claimRef),
    ]);
    if (!freshUser.exists) throw new Error(`users/${user.id} disappeared during migration`);
    const planned = planTimerClaim(books.docs.map((book) => ({ id: book.id, data: book.data() })));
    const current = claimFromSnapshot(claim);
    if (current !== null) {
      if (!timerClaimPlanIsApplied(planned, current)) {
        throw new Error(`users/${user.id} lifecycle changed during migration`);
      }
      return;
    }
    if (planned.bookPatch !== null) {
      tx.update(user.ref.collection('books').doc(planned.bookPatch.bookId), {
        activeTimer: planned.bookPatch.activeTimer,
      });
    }
    tx.set(claimRef, planned.claim);
  });
}

console.log(`${writes} users ${flags.apply ? 'migrated' : 'need migration (dry run, nothing written)'}`);
