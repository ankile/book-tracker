// Shared foundation for the repo-root database scripts (db-snapshot,
// db-restore, db-audit, migrate-*). Centralizes the three things that must
// never drift between copies: the emulator/prod target guard, batched
// writing with the updatedAt tripwire, and the snapshot type codec.
// See MIGRATIONS.md for the playbook these scripts belong to.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { initializeApp, cert } from 'firebase-admin/app';
import {
  getFirestore,
  Timestamp,
  GeoPoint,
  DocumentReference,
} from 'firebase-admin/firestore';

export const PROJECT_ID = 'book-tracker-d8f24';

// --prod / --apply / --database=<id>; everything else passes through in
// rest (e.g. a snapshot filename). Unknown --flags crash rather than being
// silently ignored — a typoed --aply must not demote a run to dry-run.
export function parseFlags(argv) {
  const flags = { prod: false, apply: false, database: undefined, rest: [] };
  for (const arg of argv) {
    if (arg === '--prod') flags.prod = true;
    else if (arg === '--apply') flags.apply = true;
    else if (arg.startsWith('--database=')) flags.database = arg.slice('--database='.length);
    else if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`);
    else flags.rest.push(arg);
  }
  return flags;
}

// Target guard. Default target is the EMULATOR: without --prod the
// service account key is never read, so reaching production from that
// code path is impossible rather than merely guarded. --prod with the
// emulator env var set is a contradiction and crashes. confirmWrite makes
// prod runs interactive: the operator must type the project id.
export async function connect({ prod, database, confirmWrite = false }) {
  let app;
  if (prod) {
    if (process.env.FIRESTORE_EMULATOR_HOST) {
      throw new Error('--prod with FIRESTORE_EMULATOR_HOST set: ambiguous target, refusing');
    }
    const key = JSON.parse(readFileSync('./serviceAccountKey.json', 'utf8'));
    if (key.project_id !== PROJECT_ID) {
      throw new Error(`serviceAccountKey.json is for ${key.project_id}, expected ${PROJECT_ID}`);
    }
    app = initializeApp({ credential: cert(key) });
    console.log(`TARGET: PRODUCTION ${PROJECT_ID}${database ? ` database=${database}` : ''}`);
    if (confirmWrite) {
      const rl = createInterface({ input: stdin, output: stdout });
      const answer = await rl.question(`This WRITES to production. Type the project id to continue: `);
      rl.close();
      if (answer !== PROJECT_ID) throw new Error('confirmation mismatch, aborting');
    }
  } else {
    if (!process.env.FIRESTORE_EMULATOR_HOST) {
      throw new Error('no FIRESTORE_EMULATOR_HOST set — start the emulator, or pass --prod for production');
    }
    app = initializeApp({ projectId: PROJECT_ID });
    console.log(`TARGET: emulator ${process.env.FIRESTORE_EMULATOR_HOST} (${PROJECT_ID})`);
  }
  return { db: database ? getFirestore(app, database) : getFirestore(app) };
}

// Batched writer with dry-run counting and 500-op rollover.
//
// update() is for mutating existing documents and refuses updatedAt: on
// books it drives the reading-list order, and no migration may touch it —
// the convention is enforced here, not remembered. set() is for documents
// the script owns outright (snapshot restores, new-entity upserts), where
// writing updatedAt is legitimate.
export function batcher(db, { apply }) {
  let batch = db.batch();
  let pending = 0;
  let count = 0;
  const flushIfFull = async () => {
    pending += 1;
    count += 1;
    if (pending >= 500) {
      if (apply) await batch.commit();
      batch = db.batch();
      pending = 0;
    }
  };
  return {
    async set(ref, data, opts) {
      if (opts) batch.set(ref, data, opts);
      else batch.set(ref, data);
      await flushIfFull();
    },
    async update(ref, data) {
      if ('updatedAt' in data) {
        throw new Error(`migration update touches updatedAt on ${ref.path}`);
      }
      batch.update(ref, data);
      await flushIfFull();
    },
    async delete(ref) {
      batch.delete(ref);
      await flushIfFull();
    },
    async flush() {
      if (pending > 0 && apply) await batch.commit();
      batch = db.batch();
      pending = 0;
    },
    count: () => count,
    apply,
  };
}

// Snapshot codec: every Firestore field type the SDK can return, encoded
// losslessly into JSON. Unknown object types crash (a snapshot that
// silently degrades a type is worse than no snapshot), and a plain map
// containing the marker key crashes rather than colliding with it.
export function encodeValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Timestamp) {
    return { __type: 'timestamp', seconds: value.seconds, nanoseconds: value.nanoseconds };
  }
  if (value instanceof DocumentReference) {
    return { __type: 'ref', path: value.path };
  }
  if (value instanceof GeoPoint) {
    return { __type: 'geopoint', latitude: value.latitude, longitude: value.longitude };
  }
  if (Buffer.isBuffer(value)) {
    return { __type: 'bytes', base64: value.toString('base64') };
  }
  if (Array.isArray(value)) return value.map(encodeValue);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`snapshot codec: unhandled type ${value.constructor?.name}`);
  }
  if ('__type' in value) {
    throw new Error('snapshot codec: document field uses the reserved key __type');
  }
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, encodeValue(v)])
  );
}

export function decodeValue(db, value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => decodeValue(db, v));
  switch (value.__type) {
    case 'timestamp':
      return new Timestamp(value.seconds, value.nanoseconds);
    case 'ref':
      return db.doc(value.path);
    case 'geopoint':
      return new GeoPoint(value.latitude, value.longitude);
    case 'bytes':
      return Buffer.from(value.base64, 'base64');
    case undefined:
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, decodeValue(db, v)])
      );
    default:
      throw new Error(`snapshot codec: unknown __type ${value.__type}`);
  }
}
