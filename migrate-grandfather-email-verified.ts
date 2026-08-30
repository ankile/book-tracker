// Grandfather existing accounts as email_verified.
//
// Email verification is about to become a requirement (the shared catalog
// gates reads and callables on the email_verified claim), but the app only
// started sending verification emails with this release, so nobody who
// signed up before it carries the claim. This script sets emailVerified on
// every existing account that has actually used the app — owns at least
// one book — and leaves the rest to verify like a new sign-up. It writes
// to Auth only, never to Firestore.
//
// Reversible: an apply records the flipped uids in a JSON file (default
// grandfathered-<timestamp>.json, gitignored) and --revert=<file> flips
// exactly those back. An account that verified itself in between is
// reverted too and has to use its link again; the run says so.
//
//   node migrate-grandfather-email-verified.ts                     # emulator dry-run
//   node migrate-grandfather-email-verified.ts --apply             # emulator apply
//   node migrate-grandfather-email-verified.ts --prod              # prod dry-run
//   node migrate-grandfather-email-verified.ts --prod --apply [--out=<file>]
//   node migrate-grandfather-email-verified.ts --revert=<file> [--prod] [--apply]
import { readFileSync, writeFileSync } from 'node:fs';
import { getAuth } from 'firebase-admin/auth';
import type { UserRecord } from 'firebase-admin/auth';
import { PROJECT_ID, connect, parseFlags } from './migrate-lib.ts';

const argv = process.argv.slice(2);
const valueOf = (name: string): string | undefined => {
  const arg = argv.find((candidate) => candidate.startsWith(`${name}=`));
  if (arg === undefined) return undefined;
  const value = arg.slice(name.length + 1);
  if (value === '') throw new Error(`${name}= needs a file name`);
  return value;
};
const revertFile = valueOf('--revert');
const outFile = valueOf('--out');
if (revertFile !== undefined && outFile !== undefined) {
  throw new Error('--out belongs to an apply; --revert reads its own file');
}
const flags = parseFlags(argv.filter((arg) => !arg.startsWith('--revert=') && !arg.startsWith('--out=')));
if (flags.rest.length > 0) throw new Error(`unexpected argument ${flags.rest[0]}`);
if (flags.database !== undefined) throw new Error('this script reads the (default) database only');

// migrate-lib guards the Firestore target. The Auth target gets the same
// guard here, because that is where this script writes.
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
if (flags.prod) {
  if (authHost !== undefined) {
    throw new Error('--prod with FIREBASE_AUTH_EMULATOR_HOST set: ambiguous target, refusing');
  }
} else if (!/^(?:127\.0\.0\.1|localhost):\d+$/.test(authHost ?? '')) {
  throw new Error('no loopback FIREBASE_AUTH_EMULATOR_HOST set — start the auth emulator, or pass --prod');
}

const { db } = await connect({ ...flags, confirmWrite: flags.apply });
const auth = getAuth();

async function everyAuthUser(): Promise<UserRecord[]> {
  const users: UserRecord[] = [];
  let pageToken: string | undefined;
  do {
    const page = await auth.listUsers(1000, pageToken);
    users.push(...page.users);
    pageToken = page.pageToken;
  } while (pageToken !== undefined);
  return users.sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
}

interface GrandfatherRecord {
  project: string;
  appliedAt: string;
  uids: string[];
}

function readRecord(file: string): GrandfatherRecord {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`${file} is not a JSON object`);
  const { project, appliedAt, uids } = parsed as Record<string, unknown>;
  if (project !== PROJECT_ID) throw new Error(`${file} is for ${String(project)}, expected ${PROJECT_ID}`);
  if (typeof appliedAt !== 'string') throw new Error(`${file} has no appliedAt`);
  if (!Array.isArray(uids) || !uids.every((uid) => typeof uid === 'string' && uid.length > 0)) {
    throw new Error(`${file} uids must be a list of non-empty strings`);
  }
  return { project, appliedAt, uids: uids as string[] };
}

if (revertFile !== undefined) {
  const tag = flags.apply ? 'REVERT' : 'DRY';
  const record = readRecord(revertFile);
  console.log(`reverting the run of ${record.appliedAt} (${record.uids.length} uids)`);
  let reverted = 0;
  let already = 0;
  for (const uid of record.uids) {
    const account = await auth.getUser(uid);
    if (!account.emailVerified) {
      already += 1;
      console.log(`ok ${uid} already unverified`);
      continue;
    }
    console.log(`${tag} ${uid} emailVerified -> false (if this account verified itself since, it must use its link again)`);
    if (flags.apply) await auth.updateUser(uid, { emailVerified: false });
    reverted += 1;
  }
  console.log(`${reverted} account(s) ${flags.apply ? 'reverted' : 'to revert'}, ${already} already unverified`);
} else {
  const tag = flags.apply ? 'VERIFY' : 'DRY';
  const flipped: string[] = [];
  let already = 0;
  let skipped = 0;
  for (const account of await everyAuthUser()) {
    const { uid } = account;
    if (account.email === undefined) throw new Error(`${uid} has no email address`);
    // A live Auth account whose document is tombstoned is drift (the
    // tombstone is only ever written by the deletion trigger); it must
    // not be granted anything until someone has looked at it.
    const document = await db.doc(`users/${uid}`).get();
    if (document.get('deletedAt') !== undefined) {
      throw new Error(`${uid} is live in Auth but users/${uid} is tombstoned; resolve the drift first`);
    }
    if (account.emailVerified) {
      already += 1;
      console.log(`ok ${uid} already verified`);
      continue;
    }
    const books = await db.collection('users').doc(uid).collection('books').limit(1).get();
    if (books.empty) {
      skipped += 1;
      console.log(`skip ${uid} no books`);
      continue;
    }
    console.log(`${tag} ${uid} emailVerified -> true`);
    if (flags.apply) await auth.updateUser(uid, { emailVerified: true });
    flipped.push(uid);
  }
  console.log(`${flipped.length} account(s) ${flags.apply ? 'grandfathered' : 'to grandfather'}, ${already} already verified, ${skipped} skipped (no books)`);
  if (flags.apply && flipped.length > 0) {
    const file = outFile ?? `grandfathered-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const record: GrandfatherRecord = { project: PROJECT_ID, appliedAt: new Date().toISOString(), uids: flipped };
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`wrote ${file} — keep it; --revert=${file} undoes exactly this run`);
  }
}
