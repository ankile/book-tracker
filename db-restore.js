// Restore a db-snapshot.js dump. Primary use: load a prod snapshot into
// the emulator for migration rehearsal. Prod restore is disaster recovery
// only and demands typed confirmation.
//
// Semantics: full-overwrite set() of every dumped doc. Never deletes, so
// documents CREATED after the snapshot (e.g. by a bad migration) survive
// a restore — audit afterwards and remove those by hand if needed.
// users/*/togglQueue/* is skipped: restoring a 'pending' item would make
// the syncqueue trigger replay a real Toggl API call.
//
//   node db-restore.js snapshots/<file>.json           # into the emulator
//   node db-restore.js snapshots/<file>.json --prod    # disaster recovery
import { readFileSync } from 'node:fs';
import { parseFlags, connect, decodeValue, batcher, PROJECT_ID } from './migrate-lib.js';

const flags = parseFlags(process.argv.slice(2));
const [file] = flags.rest;
if (!file) throw new Error('usage: node db-restore.js <snapshot.json> [--prod] [--database=<id>]');

const dump = JSON.parse(readFileSync(file, 'utf8'));
if (dump.projectId !== PROJECT_ID) {
  throw new Error(`snapshot is from ${dump.projectId}, expected ${PROJECT_ID}`);
}

const { db } = await connect({ ...flags, confirmWrite: flags.prod });
const writer = batcher(db, { apply: true });

let skipped = 0;
for (const { path, data } of dump.docs) {
  if (/^users\/[^/]+\/togglQueue\//.test(path)) {
    skipped += 1;
    continue;
  }
  await writer.set(db.doc(path), decodeValue(db, data));
}
await writer.flush();
console.log(`restored ${writer.count()} documents from ${file} (${skipped} togglQueue docs skipped)`);
