// Shared foundation for the repo-root database scripts (db-snapshot,
// db-restore, db-audit, migrate-*). Centralizes the three things that must
// never drift between copies: the emulator/prod target guard, batched
// writing with the updatedAt tripwire, and the snapshot type codec.
// See MIGRATIONS.md for the playbook these scripts belong to.
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { initializeApp } from 'firebase-admin/app';
import type { Credential } from 'firebase-admin/app';
import {
  Firestore,
  Timestamp,
  GeoPoint,
  DocumentReference,
} from 'firebase-admin/firestore';
import type {
  DocumentData,
  SetOptions,
} from 'firebase-admin/firestore';
import { OAuth2Client } from 'google-auth-library';

export interface MigrationFlags {
  prod: boolean;
  apply: boolean;
  database: string | undefined;
  rest: string[];
}

interface ConnectOptions {
  prod: boolean;
  database?: string;
  confirmWrite?: boolean;
}

type EncodedMarker =
  | { __type: 'timestamp'; seconds: number; nanoseconds: number }
  | { __type: 'ref'; path: string }
  | { __type: 'geopoint'; latitude: number; longitude: number }
  | { __type: 'bytes'; base64: string };

export type EncodedValue =
  | null
  | boolean
  | number
  | string
  | undefined
  | EncodedMarker
  | EncodedValue[]
  | { [key: string]: EncodedValue };

export type EncodedDocument = { [key: string]: EncodedValue };

export type DecodedValue =
  | null
  | boolean
  | number
  | string
  | undefined
  | Timestamp
  | GeoPoint
  | Buffer
  | DocumentReference
  | DecodedValue[]
  | { [key: string]: DecodedValue };

export type DecodedDocument = { [key: string]: DecodedValue };

export interface MigrationBatcher {
  set(ref: DocumentReference, data: DocumentData, opts?: SetOptions): Promise<void>;
  update(ref: DocumentReference, data: DocumentData): Promise<void>;
  delete(ref: DocumentReference): Promise<void>;
  flush(): Promise<void>;
  count(): number;
  apply: boolean;
}

export const PROJECT_ID = 'book-tracker-d8f24';

// Production credential (SEC-048/SEC-057): no key file. The operator's own
// gcloud login mints a one-hour access token on demand; both clients ask
// again when it expires, so long runs keep working and nothing secret is
// ever on disk. The account is pinned because this machine's default gcloud
// account is a different one — an unexpected account fails inside gcloud
// instead of silently targeting production as someone else. Revoking the
// login (`gcloud auth revoke`, or the Google Account's third-party access
// page) ends every script's access at once.
export const OPERATOR_ACCOUNT = 'lars.ankile@gmail.com';

export function mintOperatorToken(): string {
  const token = execFileSync(
    'gcloud',
    ['auth', 'print-access-token', `--account=${OPERATOR_ACCOUNT}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  ).trim();
  if (token === '') throw new Error('gcloud returned an empty access token');
  return token;
}

// firebase-admin's credential shape — used only for the Auth admin API
// (migrate-purge-deleted-accounts). firebase-admin's own Firestore wrapper
// refuses anything but a key file or ADC, so Firestore is opened directly
// below with the google-auth-library client instead.
export function gcloudCredential(): Credential {
  return {
    async getAccessToken() {
      return { access_token: mintOperatorToken(), expires_in: 3600 };
    },
  };
}

// google-auth-library's shape — handed to the Firestore gRPC channel. The
// refresh handler IS the gcloud call; the quota project is what user
// credentials need for APIs that bill per project.
function gcloudAuthClient(): OAuth2Client {
  const client = new OAuth2Client({ quotaProjectId: PROJECT_ID });
  client.refreshHandler = async () => ({
    access_token: mintOperatorToken(),
    expiry_date: Date.now() + 55 * 60 * 1000,
  });
  return client;
}

// Set by connect(); openDatabase() reads it so every script opens every
// database (default or `secrets`) against the same confirmed target.
let target: { prod: false } | { prod: true; authClient: OAuth2Client } | undefined;

export function openDatabase(databaseId?: string): Firestore {
  if (target === undefined) throw new Error('openDatabase() before connect()');
  const settings = databaseId === undefined ? {} : { databaseId };
  return target.prod
    ? new Firestore({ projectId: PROJECT_ID, authClient: target.authClient, ...settings })
    : new Firestore({ projectId: PROJECT_ID, ...settings });
}

// --prod / --apply / --database=<id>; everything else passes through in
// rest (e.g. a snapshot filename). Unknown --flags crash rather than being
// silently ignored — a typoed --aply must not demote a run to dry-run.
export function parseFlags(argv: string[]): MigrationFlags {
  const flags: MigrationFlags = {
    prod: false,
    apply: false,
    database: undefined,
    rest: [],
  };
  for (const arg of argv) {
    if (arg === '--prod') flags.prod = true;
    else if (arg === '--apply') flags.apply = true;
    else if (arg.startsWith('--database=')) {
      const database = arg.slice('--database='.length);
      if (database === '') throw new Error('database id must not be empty');
      flags.database = database;
    }
    else if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`);
    else flags.rest.push(arg);
  }
  return flags;
}

// Target guard. Default target is the EMULATOR: without --prod gcloud is
// never consulted, so reaching production from that code path is
// impossible rather than merely guarded. --prod with the
// emulator env var set is a contradiction and crashes. confirmWrite makes
// prod runs interactive: the operator must type the project id.
export async function connect({
  prod,
  database,
  confirmWrite = false,
}: ConnectOptions): Promise<{ db: Firestore }> {
  if (database === '') throw new Error('database id must not be empty');
  if (target !== undefined) throw new Error('connect() called twice');
  if (prod) {
    if (process.env.FIRESTORE_EMULATOR_HOST) {
      throw new Error('--prod with FIRESTORE_EMULATOR_HOST set: ambiguous target, refusing');
    }
    // User credentials need a quota project for the Auth admin API
    // (identitytoolkit); firebase-admin reads this variable for every request.
    process.env.GOOGLE_CLOUD_QUOTA_PROJECT = PROJECT_ID;
    initializeApp({ projectId: PROJECT_ID, credential: gcloudCredential() });
    target = { prod: true, authClient: gcloudAuthClient() };
    console.log(`TARGET: PRODUCTION ${PROJECT_ID}${database !== undefined ? ` database=${database}` : ''}`);
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
    if (!/^(?:127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST)) {
      throw new Error('Firestore emulator host must be loopback (127.0.0.1 or localhost)');
    }
    initializeApp({ projectId: PROJECT_ID });
    target = { prod: false };
    console.log(`TARGET: emulator ${process.env.FIRESTORE_EMULATOR_HOST} (${PROJECT_ID})`);
  }
  return { db: openDatabase(database) };
}

// Batched writer with dry-run counting and 500-op rollover.
//
// update() is for mutating existing documents and refuses updatedAt: on
// books it drives the reading-list order, and no migration may touch it —
// the convention is enforced here, not remembered. set() is for documents
// the script owns outright (snapshot restores, new-entity upserts), where
// writing updatedAt is legitimate.
export function batcher(
  db: Firestore,
  { apply }: { apply: boolean },
): MigrationBatcher {
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
    async set(ref: DocumentReference, data: DocumentData, opts?: SetOptions) {
      if (opts) batch.set(ref, data, opts);
      else batch.set(ref, data);
      await flushIfFull();
    },
    async update(ref: DocumentReference, data: DocumentData) {
      if ('updatedAt' in data) {
        throw new Error(`migration update touches updatedAt on ${ref.path}`);
      }
      batch.update(ref, data);
      await flushIfFull();
    },
    async delete(ref: DocumentReference) {
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
export function encodeValue(value: DocumentData): EncodedDocument;
export function encodeValue(value: unknown): EncodedValue;
export function encodeValue(value: unknown): EncodedValue {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (typeof value !== 'object') {
    throw new Error(`snapshot codec: unhandled primitive ${typeof value}`);
  }
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
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`snapshot codec: unhandled type ${value.constructor?.name}`);
  }
  const record = value as Record<string, unknown>;
  if ('__type' in record) {
    throw new Error('snapshot codec: document field uses the reserved key __type');
  }
  return Object.fromEntries(
    Object.entries(record).map(([k, v]) => [k, encodeValue(v)])
  );
}

export function decodeValue(db: Firestore, value: EncodedDocument): DecodedDocument;
export function decodeValue(db: Firestore, value: EncodedValue): DecodedValue;
export function decodeValue(db: Firestore, value: EncodedValue): DecodedValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => decodeValue(db, v));
  if (!('__type' in value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, decodeValue(db, v)])
    );
  }
  const marker = value as EncodedMarker;
  switch (marker.__type) {
    case 'timestamp':
      return new Timestamp(marker.seconds, marker.nanoseconds);
    case 'ref':
      return db.doc(marker.path);
    case 'geopoint':
      return new GeoPoint(marker.latitude, marker.longitude);
    case 'bytes':
      return Buffer.from(marker.base64, 'base64');
    default:
      throw new Error(`snapshot codec: unknown __type ${(value as { __type: unknown }).__type}`);
  }
}
