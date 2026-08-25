// Restore a db-snapshot.ts dump. Primary use: load a prod snapshot into
// the emulator for migration rehearsal. Prod restore is disaster recovery
// only and demands typed confirmation.
//
// Semantics: full-overwrite set() of every dumped doc. Never deletes, so
// documents CREATED after the snapshot (e.g. by a bad migration) survive
// a restore — audit afterwards and remove those by hand if needed.
// users/*/togglQueue/* is skipped: restoring a 'pending' item would make
// the syncqueue trigger replay a real Toggl API call.
//
//   node db-restore.ts snapshots/<file>.json                    # emulator dry-run
//   node db-restore.ts snapshots/<file>.json --apply            # emulator apply
//   node db-restore.ts snapshots/<file>.json --prod             # prod dry-run
//   node db-restore.ts snapshots/<file>.json --prod --apply     # disaster recovery
// A dry run prints NOTHING WRITTEN at both startup and completion. --prod
// chooses the target only; --apply enables writes, and production apply still
// requires typing the project id through connect().
import { readFileSync } from 'node:fs';
import {
  parseFlags,
  connect,
  decodeValue,
  batcher,
  PROJECT_ID,
  type EncodedDocument,
} from './migrate-lib.ts';
import {
  restoreCompletionBanner,
  restoreStartBanner,
} from './db-restore-messages.ts';

interface SnapshotDump {
  projectId: string;
  docs: Array<{ path: string; data: EncodedDocument }>;
}

const flags = parseFlags(process.argv.slice(2));
if (flags.rest.length !== 1) {
  throw new Error(
    'restore requires exactly one snapshot file: node db-restore.ts <snapshot.json> [--prod] [--apply] [--database=<id>]',
  );
}
const [file] = flags.rest;

const dump: SnapshotDump = JSON.parse(readFileSync(file, 'utf8'));
if (dump.projectId !== PROJECT_ID) {
  throw new Error(`snapshot is from ${dump.projectId}, expected ${PROJECT_ID}`);
}

console.log(restoreStartBanner({ file, flags }));
const { db } = await connect({ ...flags, confirmWrite: flags.apply });
const writer = batcher(db, { apply: flags.apply });

let skipped = 0;
for (const { path, data } of dump.docs) {
  if (/^users\/[^/]+\/togglQueue\//.test(path)) {
    skipped += 1;
    continue;
  }
  await writer.set(db.doc(path), decodeValue(db, data));
}
await writer.flush();
console.log(restoreCompletionBanner({
  file,
  flags,
  documents: writer.count(),
  skipped,
}));
