// Backfill of the profile ownership record (rules sitting, 2026-08-29): the
// one-profile-per-account rule keys on profileOwners/{uid} = { username },
// which the client moves in every profile batch. A profile created before
// that rule has no record; the rules treat it as legacy (its delete and
// update batches create the record), but until one of those runs the
// account is not in the shape the rules describe. This writes the missing
// record for every existing profile, and nothing else.
//
// Idempotent: a record that already names the profile is skipped. A record
// that names a DIFFERENT profile, or two profiles for one uid, is a
// conflict this script must not resolve — it crashes, and an operator
// decides.
//
//   node migrate-profile-owners.ts                    # emulator dry-run
//   node migrate-profile-owners.ts --apply            # emulator apply
//   node migrate-profile-owners.ts --prod             # prod dry-run
//   node migrate-profile-owners.ts --prod --apply     # prod apply (typed confirm)
import { parseFlags, connect, batcher } from './migrate-lib.ts';
import { USERNAME_PATTERN } from './rules-shape.ts';

const flags = parseFlags(process.argv.slice(2));
const { db } = await connect({ ...flags, confirmWrite: flags.apply });
const writes = batcher(db, { apply: flags.apply });
const tag = flags.apply ? 'SET' : 'DRY';

const profiles = await db.collection('profiles').get();
const seen = new Map<string, string>();
for (const profile of profiles.docs) {
  const username = profile.id;
  const uid = profile.data().uid;
  if (typeof uid !== 'string' || uid === '') throw new Error(`${profile.ref.path} has no uid`);
  if (!USERNAME_PATTERN.test(username)) throw new Error(`${profile.ref.path} is not a valid username`);
  const previous = seen.get(uid);
  if (previous !== undefined) throw new Error(`uid ${uid} owns both ${previous} and ${username}`);
  seen.set(uid, username);

  const record = db.collection('profileOwners').doc(uid);
  const existing = await record.get();
  if (existing.exists) {
    const named = existing.data()?.username;
    if (named !== username) throw new Error(`${record.path} names ${String(named)}, profile is ${username}`);
    console.log(`ok   ${record.path} already names ${username}`);
    continue;
  }
  console.log(`${tag}  ${record.path} := { username: ${username} }`);
  await writes.set(record, { username });
}
await writes.flush();
console.log(`${writes.count()} ownership records ${flags.apply ? 'written' : '(dry run, nothing written)'}`);
