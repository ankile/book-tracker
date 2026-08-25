// Full-database dump to snapshots/<timestamp>.json. Run before every
// migration (and any time a known-good baseline is wanted).
//
// Traversal uses listCollections()/listDocuments() — deliberately the
// OPPOSITE of the migration convention (.get()) — because a backup must
// capture orphaned subcollection docs under deleted parents. Only
// existing documents are dumped; orphan structure restores correctly
// because Firestore allows subcollection docs under missing parents.
//
//   node db-snapshot.ts                # emulator (FIRESTORE_EMULATOR_HOST)
//   node db-snapshot.ts --prod         # production (read-only, no confirm)
//   node db-snapshot.ts --prod --database=recovered   # a restored backup db
import { mkdirSync, writeFileSync } from 'node:fs';
import type { DocumentReference } from 'firebase-admin/firestore';
import {
  parseFlags,
  connect,
  encodeValue,
  PROJECT_ID,
  type EncodedDocument,
} from './migrate-lib.ts';

const flags = parseFlags(process.argv.slice(2));
const { db } = await connect(flags);

interface SnapshotDocument {
  path: string;
  data: EncodedDocument;
}

const docs: SnapshotDocument[] = [];

// The walk costs ~two round-trips per document (get + listCollections), so
// it runs under a concurrency pool: sequential, a few-thousand-doc dump
// takes tens of minutes; pooled it takes about a minute.
const LIMIT = 50;
let running = 0;
const waiters: Array<() => void> = [];
async function pooled<T>(fn: () => Promise<T>): Promise<T> {
  while (running >= LIMIT) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  running += 1;
  try {
    return await fn();
  } finally {
    running -= 1;
    waiters.shift()?.();
  }
}

async function walkDocRef(docRef: DocumentReference): Promise<void> {
  const [snap, subcollections] = await Promise.all([
    pooled(() => docRef.get()),
    pooled(() => docRef.listCollections()),
  ]);
  if (snap.exists) {
    docs.push({ path: docRef.path, data: encodeValue(snap.data()!) });
  }
  await Promise.all(subcollections.map(async (sub) => {
    const children = await pooled(() => sub.listDocuments());
    await Promise.all(children.map(walkDocRef));
  }));
}

await Promise.all((await db.listCollections()).map(async (col) => {
  const roots = await pooled(() => col.listDocuments());
  await Promise.all(roots.map(walkDocRef));
}));

docs.sort((a, b) => (a.path < b.path ? -1 : 1));

const takenAt = new Date().toISOString();
const target = flags.prod ? 'prod' : 'emulator';
const database = flags.database ?? '(default)';
const file = `snapshots/${takenAt.replaceAll(':', '-')}-${target}.json`;
mkdirSync('snapshots', { recursive: true });
writeFileSync(file, JSON.stringify(
  { projectId: PROJECT_ID, database, target, takenAt, docCount: docs.length, docs },
  null, 1,
));
console.log(`${docs.length} documents -> ${file}`);
