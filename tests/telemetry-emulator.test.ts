import './setup.ts';

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test, { after, type TestContext } from 'node:test';
import type {
  FieldPath,
  OrderByDirection,
  Query,
  WhereFilterOp,
} from 'firebase-admin/firestore';

// End-to-end against the Firestore + Auth emulators: the compiled callables
// run unmodified, with a real transaction, real queries and real Auth
// records. setup.ts points the Admin SDK at the emulator hosts that
// emulators:exec exports and at a credentials file that does not exist, so
// nothing here can reach a live project.
const functionsRequire = createRequire(new URL('../functions/package.json', import.meta.url));
const { getFirestore, Timestamp } = functionsRequire('firebase-admin/firestore') as {
  getFirestore: () => import('firebase-admin/firestore').Firestore;
  Timestamp: typeof import('firebase-admin/firestore').Timestamp;
};
const { getAuth } = functionsRequire('firebase-admin/auth') as {
  getAuth: () => import('firebase-admin/auth').Auth;
};
const { logger } = functionsRequire('firebase-functions') as {
  logger: { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
};

interface CallableContext {
  auth?: { uid: string; token: Record<string, unknown> };
}
interface IssueRow {
  id: string;
  at: number;
  uid: string | null;
  event: string;
  message: string;
  email: string;
  malformed: boolean;
}
interface Overview {
  users: { uid: string; email: string | null }[];
  issues: IssueRow[];
  issueCaps: {
    perAccount: number;
    cappedAccounts: number;
    anonymous: number;
    anonymousCapped: boolean;
    shown: number;
    total: number;
    groupsWithRows: number;
    groupsShown: number;
    unreadAccounts: number;
    anonymousUnread: boolean;
  };
}
const deployed = functionsRequire('./lib') as {
  telemetry: {
    reportissue: { run: (data: unknown, context: CallableContext) => Promise<{ recorded: true }> };
  };
  admin: {
    overview: { run: (data: unknown, context: CallableContext) => Promise<Overview> };
  };
};
const { ANONYMOUS_ISSUE_LIMIT, FEED_LIMIT, ISSUES_PER_UID } = functionsRequire('./lib/adminIssues') as {
  ANONYMOUS_ISSUE_LIMIT: number;
  FEED_LIMIT: number;
  ISSUES_PER_UID: number;
};

const db = getFirestore();
const auth = getAuth();
const run = `tel-${Date.now()}`;
const ADMIN_UID = '1Cf0CaNfgnVSvTrF5dYjzRd9Xri2';
const asUser = (uid: string): CallableContext => ({ auth: { uid, token: {} } });
const report = {
  level: 'error',
  event: 'firestore.listener_failed',
  message: "Couldn't load books",
  code: 'permission-denied',
};
const createdAuthUsers: string[] = [];
const createdIssueIds: string[] = [];
// Every successful overview call appends an adminAudit row; remember what
// was there before so the run's rows can be removed afterwards.
const auditBefore = new Set((await db.collection('adminAudit').listDocuments()).map((ref) => ref.id));

async function rowsFor(uid: string | null) {
  return (await db.collection('logEvents').where('uid', '==', uid).get()).docs.filter((d) =>
    d.id.startsWith(run) || d.get('message')?.includes?.(run) || uid?.startsWith(run),
  );
}

async function quota(uid: string) {
  return (await db.doc(`users/${uid}/functionQuotas/issueReports`).get()).data();
}

function captureWarnings(t: { mock: { method: (o: object, m: string, f: (...a: unknown[]) => void) => void } }) {
  const warnings: unknown[][] = [];
  t.mock.method(logger, 'warn', (...args: unknown[]) => {
    warnings.push(args);
  });
  return warnings;
}

after(async () => {
  for (const uid of createdAuthUsers) await auth.deleteUser(uid).catch(() => undefined);
  const batchIds = [...createdIssueIds];
  while (batchIds.length > 0) {
    const batch = db.batch();
    for (const id of batchIds.splice(0, 400)) batch.delete(db.doc(`logEvents/${id}`));
    await batch.commit();
  }
  for (const uid of createdAuthUsers) await db.recursiveDelete(db.doc(`users/${uid}`));
  for (const ref of await db.collection('adminAudit').listDocuments()) {
    if (!auditBefore.has(ref.id)) await ref.delete();
  }
  const mine = await db.collection('logEvents').where('message', '>=', run).where('message', '<', run + '\uf8ff').get();
  for (const d of mine.docs) await d.ref.delete();
});

test('the callable stores exactly twenty rows an hour, pins the uid, and warns once', async (t) => {
  const uid = `${run}-seq`;
  createdAuthUsers.push(uid);
  const warnings = captureWarnings(t);
  for (let index = 0; index < 20; index += 1) {
    assert.deepEqual(await deployed.telemetry.reportissue.run({ ...report, message: `${run} ${index}` }, asUser(uid)), {
      recorded: true,
    });
  }
  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(
      deployed.telemetry.reportissue.run({ ...report, message: `${run} refused` }, asUser(uid)),
      (error: { code?: string }) => error.code === 'resource-exhausted',
    );
  }
  const rows = (await db.collection('logEvents').where('uid', '==', uid).get()).docs;
  createdIssueIds.push(...rows.map((d) => d.id));
  assert.equal(rows.length, 20);
  for (const row of rows) {
    const data = row.data();
    assert.deepEqual(Object.keys(data).sort(), ['code', 'createdAt', 'detail', 'event', 'expiresAt', 'level', 'message', 'uid']);
    assert.equal(data.uid, uid);
    assert.equal(data.detail, null);
    assert.ok(data.createdAt instanceof Timestamp);
    assert.equal(data.expiresAt.toMillis() - data.createdAt.toMillis(), 90 * 24 * 3600 * 1000);
  }
  assert.equal((await quota(uid))?.count, 21);
  assert.deepEqual(warnings, [['telemetry.quota_exceeded', { uid, event: 'firestore.listener_failed' }]]);
});

test('concurrent reports contend on the real transaction and never exceed the quota', async (t) => {
  const uid = `${run}-race`;
  createdAuthUsers.push(uid);
  const warnings = captureWarnings(t);
  const outcomes = await Promise.all(
    Array.from({ length: 30 }, (_, index) =>
      deployed.telemetry.reportissue
        .run({ ...report, message: `${run} race ${index}` }, asUser(uid))
        .then(
          () => 'granted',
          // .run() surfaces handler errors raw: an HttpsError carries a string
          // code; a Firestore ABORTED after retry exhaustion carries gRPC 10.
          (error: { code?: string | number }) => (typeof error.code === 'string' ? error.code : `grpc-${error.code}`),
        ),
    ),
  );
  const granted = outcomes.filter((o) => o === 'granted').length;
  const refused = outcomes.filter((o) => o === 'resource-exhausted').length;
  const other = outcomes.filter((o) => o !== 'granted' && o !== 'resource-exhausted');
  const rows = (await db.collection('logEvents').where('uid', '==', uid).get()).docs;
  createdIssueIds.push(...rows.map((d) => d.id));
  // Every granted call stored exactly one row and the counter agrees with
  // the rows; nothing was granted past the limit; retry exhaustion under
  // contention (if any) fails closed without a row.
  assert.ok(granted <= 20, `granted ${granted}`);
  assert.equal(rows.length, granted);
  assert.equal((await quota(uid))?.count, granted + (refused > 0 ? 1 : 0));
  if (refused > 0) assert.equal(granted, 20);
  assert.ok(warnings.length <= 1);
  assert.equal(warnings.length, refused > 0 ? 1 : 0);
  // Retry exhaustion is the only other outcome, and it fails closed.
  for (const code of other) assert.equal(code, 'grpc-10', `unexpected outcome ${code}`);
  // A burst in which contention killed most calls before the limit was
  // reached proves nothing about the limit; say so in the TAP output
  // rather than passing silently.
  t.diagnostic(`race: granted ${granted}, refused ${refused}, aborted ${other.length}`);
  assert.ok(granted === 20 || other.length > 0, 'contention degenerated without reaching the limit');
});

test('a refused, malformed or anonymous report touches neither the counter nor the collection', async () => {
  const uid = `${run}-shape`;
  for (const broken of [
    { ...report, event: 'auth.sign_in_failed' },
    { ...report, event: 'toggl.sync_failed' },
    { ...report, uid: 'someone-else' },
    { ...report, detail: { email: 'a@example.test' } },
    { ...report, message: '' },
    { ...report, code: '' },
    'firestore.listener_failed',
  ]) {
    await assert.rejects(deployed.telemetry.reportissue.run(broken, asUser(uid)), (error: { code?: string }) => error.code === 'invalid-argument');
  }
  await assert.rejects(deployed.telemetry.reportissue.run(report, {}), (error: { code?: string }) => error.code === 'unauthenticated');
  await assert.rejects(deployed.telemetry.reportissue.run(broken(), {}), (error: { code?: string }) => error.code === 'unauthenticated');
  assert.equal(await quota(uid), undefined);
  assert.equal((await db.collection('logEvents').where('uid', '==', uid).get()).size, 0);
  assert.equal((await db.collection('logEvents').where('uid', '==', 'someone-else').get()).size, 0);
  function broken() {
    return { ...report, event: 'auth.sign_in_failed' };
  }
});

test('an expired window restarts at one and a stale first-refusal marker does not warn again', async (t) => {
  const uid = `${run}-window`;
  createdAuthUsers.push(uid);
  const warnings = captureWarnings(t);
  await db.doc(`users/${uid}/functionQuotas/issueReports`).set({
    windowStartedAt: Timestamp.fromMillis(Date.now() - 61 * 60 * 1000),
    count: 21,
  });
  await deployed.telemetry.reportissue.run({ ...report, message: `${run} after expiry` }, asUser(uid));
  assert.equal((await quota(uid))?.count, 1);
  await db.doc(`users/${uid}/functionQuotas/issueReports`).set({ windowStartedAt: Timestamp.now(), count: 21 });
  await assert.rejects(
    deployed.telemetry.reportissue.run({ ...report, message: `${run} stale` }, asUser(uid)),
    (error: { code?: string }) => error.code === 'resource-exhausted',
  );
  assert.equal((await quota(uid))?.count, 21);
  assert.deepEqual(warnings, []);
  const rows = await db.collection('logEvents').where('uid', '==', uid).get();
  createdIssueIds.push(...rows.docs.map((d) => d.id));
});

test('the overview reads every account separately and a flood cannot hide an honest account', async (t) => {
  const honest = `${run}-honest`;
  const quiet = `${run}-quiet`;
  const purged = `${run}-purged`;
  const flooders = Array.from({ length: 25 }, (_, index) => `${run}-flood-${index}`);
  for (const uid of [honest, quiet, ...flooders]) {
    await auth.createUser({ uid, email: `${uid}@example.test`, emailVerified: true });
    createdAuthUsers.push(uid);
  }
  const now = Date.now();
  const write = async (id: string, data: Record<string, unknown>) => {
    await db.doc(`logEvents/${id}`).set(data);
    createdIssueIds.push(id);
  };
  const row = (uid: string | null, at: number, message: string, extra: Record<string, unknown> = {}) => ({
    level: 'error',
    event: 'firestore.listener_failed',
    message: `${run} ${message}`,
    code: null,
    uid,
    detail: null,
    createdAt: Timestamp.fromMillis(at),
    expiresAt: Timestamp.fromMillis(at + 90 * 24 * 3600 * 1000),
    ...extra,
  });
  // The honest account's rows are all older than every flood row.
  for (let index = 0; index < 10; index += 1) await write(`${honest}-${index}`, row(honest, now - 3_600_000 - index * 1000, `honest ${index}`));
  for (const flooder of flooders) {
    for (let index = 0; index < 11; index += 1) await write(`${flooder}-${index}`, row(flooder, now - index * 1000, `flood ${index}`));
  }
  // Historical anonymous rows, one in the pre-SEC-029 shape.
  for (let index = 0; index < 30; index += 1) {
    await write(`${run}-anon-${index}`, row(null, now - 1_800_000 - index * 1000, `anon ${index}`, { event: 'auth.sign_in_failed', level: 'warn' }));
  }
  await write(`${run}-anon-legacy`, row(null, now - 1_700_000, 'legacy anon', { event: 'auth.sign_up_failed', detail: { email: 'typed@example.test' } }));
  // Rows the feed cannot see, by documented design: no uid field at all,
  // and a uid that exists in neither Auth nor users/.
  const { uid: _dropped, ...uidless } = row(null, now, 'uidless');
  await write(`${run}-uidless`, uidless);
  await write(`${run}-purged`, row(purged, now, 'purged'));
  // A malformed row that still names its account counts against it.
  await write(`${honest}-malformed`, { ...row(honest, now - 3_500_000, 'malformed honest'), level: 'attacker-level' });
  // Old rows outside the 14-day window are not read.
  await write(`${honest}-ancient`, row(honest, now - 20 * 24 * 3600 * 1000, 'ancient'));

  const errors: unknown[][] = [];
  t.mock.method(logger, 'error', (...args: unknown[]) => {
    errors.push(args);
  });
  const overview = await deployed.admin.overview.run({}, { auth: { uid: ADMIN_UID, token: { email_verified: true } } });

  const mine = overview.issues.filter((issue) => issue.message.includes(run) || issue.malformed);
  const honestRows = mine.filter((issue) => issue.uid === honest);
  const byFlooder = new Map<string, number>();
  for (const issue of mine) if (issue.uid?.includes('-flood-')) byFlooder.set(issue.uid, (byFlooder.get(issue.uid) ?? 0) + 1);

  // Honest rows survive the flood, newest first; the malformed row took one
  // of the account's ten slots (it is newest) and renders as malformed.
  // The bound is what round-robin guarantees — floor(FEED_LIMIT / groups)
  // rows per group — minus the malformed slot, derived from the wire rather
  // than a constant, so extra groups left by other tests cannot flip it.
  const guaranteed = Math.floor(FEED_LIMIT / overview.issueCaps.groupsWithRows) - 1;
  assert.ok(guaranteed >= 1, `too many groups for the scenario: ${overview.issueCaps.groupsWithRows}`);
  assert.ok(honestRows.length >= guaranteed, `honest rows shown: ${honestRows.length}, guaranteed ${guaranteed}`);
  assert.ok(honestRows.length <= ISSUES_PER_UID - 1);
  assert.equal(honestRows[0].message, `${run} honest 0`);
  const malformed = overview.issues.filter((issue) => issue.malformed);
  assert.ok(malformed.length >= 1);
  assert.ok(malformed.every((issue) => issue.uid === null && issue.email === '(malformed issue)'));
  assert.equal(overview.issues.filter((issue) => issue.message.includes('ancient')).length, 0);
  // Every flooder is present and none exceeds its cap.
  assert.equal(byFlooder.size, 25);
  assert.ok(Math.max(...byFlooder.values()) <= ISSUES_PER_UID);
  // Caps reported honestly: 25 flooders over the cap (11 > 10), the honest
  // account too (10 + malformed = 11), plus whichever earlier callable
  // tests in this file left twenty rows behind (their quota docs keep them
  // in the uid union as phantom parents — the documented coupling).
  assert.ok(overview.issueCaps.cappedAccounts >= 26, `capped: ${overview.issueCaps.cappedAccounts}`);
  assert.equal(overview.issueCaps.anonymousCapped, true);
  assert.equal(overview.issueCaps.perAccount, ISSUES_PER_UID);
  assert.equal(overview.issueCaps.anonymous, ANONYMOUS_ISSUE_LIMIT);
  assert.equal(overview.issueCaps.shown, Math.min(FEED_LIMIT, overview.issueCaps.total));
  assert.equal(overview.issues.length, overview.issueCaps.shown);
  assert.equal(overview.issueCaps.unreadAccounts, 0);
  assert.equal(overview.issueCaps.anonymousUnread, false);
  // Well under two hundred groups: every account with rows is shown.
  assert.ok(overview.issueCaps.groupsWithRows >= 27);
  assert.equal(overview.issueCaps.groupsShown, overview.issueCaps.groupsWithRows);
  assert.deepEqual(errors, []);
  // Anonymous rows are read under their own cap and the legacy shape decodes.
  const anonymous = overview.issues.filter((issue) => issue.uid === null && !issue.malformed);
  assert.ok(anonymous.length <= ANONYMOUS_ISSUE_LIMIT);
  assert.ok(anonymous.every((issue) => issue.email === '(anonymous)'));
  assert.ok(!JSON.stringify(overview).includes('typed@example.test'));
  // Invisible by design: uid-less and purged rows.
  assert.equal(overview.issues.filter((issue) => issue.message.includes('uidless') || issue.message.includes('purged')).length, 0);
  // Display order and identity.
  for (let index = 1; index < overview.issues.length; index += 1) assert.ok(overview.issues[index - 1].at >= overview.issues[index].at);
  assert.ok(overview.users.some((user) => user.uid === quiet));
  assert.equal(honestRows[0].email, `${honest}@example.test`);
});

// The only Firestore call the overview makes that can fail per account is
// the logEvents query readIssuesFor builds. Only the query whose uid
// `fails` names is made to reject; everything else is the real emulator and
// the real compiled callable — the way a missing composite index or an IAM
// change fails in production.
function failLogEventsReadsFor(
  t: TestContext,
  fails: (uid: string | null | undefined) => boolean,
): void {
  const original = db.collection.bind(db);
  const wrap = <T extends Query>(target: T, uid: string | null | undefined): T =>
    new Proxy(target, {
      get(_target, prop): unknown {
        if (prop === 'where') {
          return (field: string | FieldPath, op: WhereFilterOp, value: unknown) =>
            wrap(
              target.where(field, op, value),
              field === 'uid' && (typeof value === 'string' || value === null) ? value : uid,
            );
        }
        if (prop === 'orderBy') {
          return (field: string | FieldPath, direction?: OrderByDirection) =>
            wrap(target.orderBy(field, direction), uid);
        }
        if (prop === 'limit') return (limit: number) => wrap(target.limit(limit), uid);
        if (prop === 'get') {
          return async () => {
            if (fails(uid)) throw new Error(`simulated read failure for ${String(uid)}`);
            return target.get();
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  t.mock.method(db, 'collection', ((path: string) => {
    const real = original(path);
    return path === 'logEvents' ? wrap(real, undefined) : real;
  }));
}

const issueRow = (uid: string | null, at: number, message: string) => ({
  level: 'error',
  event: 'firestore.listener_failed',
  message: `${run} ${message}`,
  code: null,
  uid,
  detail: null,
  createdAt: Timestamp.fromMillis(at),
  expiresAt: Timestamp.fromMillis(at + 90 * 24 * 3600 * 1000),
});

async function seedTwoAccounts(tag: string) {
  const good = `${run}-${tag}-good`;
  const broken = `${run}-${tag}-broken`;
  for (const uid of [good, broken]) {
    await auth.createUser({ uid, email: `${uid}@example.test`, emailVerified: true });
    createdAuthUsers.push(uid);
  }
  const now = Date.now();
  for (const uid of [good, broken]) {
    for (let index = 0; index < 3; index += 1) {
      const id = `${uid}-${index}`;
      createdIssueIds.push(id);
      await db.doc(`logEvents/${id}`).set(issueRow(uid, now - index * 1000, `${uid} ${index}`));
    }
  }
  const anonId = `${run}-${tag}-anon`;
  createdIssueIds.push(anonId);
  await db.doc(`logEvents/${anonId}`).set(issueRow(null, now - 10_000, 'anon'));
  return { good, broken };
}

test('one unreadable account is dropped, counted and logged, and never fails the page', async (t) => {
  const { good, broken } = await seedTwoAccounts('drop');
  const errors: unknown[][] = [];
  t.mock.method(logger, 'error', (...args: unknown[]) => {
    errors.push(args);
  });
  failLogEventsReadsFor(t, (uid) => uid === broken);

  const overview = await deployed.admin.overview.run({}, { auth: { uid: ADMIN_UID, token: { email_verified: true } } });

  assert.equal(overview.issues.filter((i) => i.uid === good).length, 3);
  assert.equal(overview.issues.filter((i) => i.uid === broken).length, 0);
  assert.equal(overview.issueCaps.unreadAccounts, 1);
  assert.equal(overview.issueCaps.anonymousUnread, false);
  assert.ok(overview.issues.some((i) => i.uid === null && !i.malformed && i.message.includes(`${run} anon`)));
  const mine = errors.filter((e) => (e[1] as { uid?: string })?.uid === broken);
  assert.equal(mine.length, 1);
  assert.equal(mine[0][0], 'admin.issues.read_failed');
});

test('a failed uid-null read sets anonymousUnread and no account count', async (t) => {
  const { good } = await seedTwoAccounts('anon');
  const errors: unknown[][] = [];
  t.mock.method(logger, 'error', (...args: unknown[]) => {
    errors.push(args);
  });
  failLogEventsReadsFor(t, (uid) => uid === null);

  const overview = await deployed.admin.overview.run({}, { auth: { uid: ADMIN_UID, token: { email_verified: true } } });

  assert.equal(overview.issueCaps.anonymousUnread, true);
  assert.equal(overview.issueCaps.unreadAccounts, 0);
  assert.equal(overview.issues.filter((i) => i.uid === null && !i.malformed).length, 0);
  assert.equal(overview.issues.filter((i) => i.uid === good).length, 3);
  const mine = errors.filter((e) => (e[1] as { uid?: string | null })?.uid === null);
  assert.equal(mine.length, 1);
  assert.equal(mine[0][0], 'admin.issues.read_failed');
});

test('the cut is rank-fair: no account is more than one row ahead of another', async () => {
  const flooders = Array.from({ length: 30 }, (_, i) => `${run}-f${String(i).padStart(2, '0')}`);
  const honest = `${run}-zhonest`;
  for (const uid of [...flooders, honest]) {
    await auth.createUser({ uid, email: `${uid}@example.test`, emailVerified: true });
    createdAuthUsers.push(uid);
  }
  const now = Date.now();
  const write = async (id: string, uid: string, at: number, message: string) => {
    createdIssueIds.push(id);
    await db.doc(`logEvents/${id}`).set(issueRow(uid, at, message));
  };
  // Every flooder row is newer than every honest row, and each account has
  // exactly the per-account cap, so nothing reports them as capped — the
  // round-3 blinding scenario with the cap-detection signal switched off.
  for (const f of flooders) for (let i = 0; i < 10; i += 1) await write(`${f}-${i}`, f, now - i * 1000, `${f} ${i}`);
  for (let i = 0; i < 10; i += 1) await write(`${honest}-${i}`, honest, now - 3_600_000 - i * 1000, `honest ${i}`);

  const overview = await deployed.admin.overview.run({}, { auth: { uid: ADMIN_UID, token: { email_verified: true } } });
  const shares = new Map<string, number>();
  for (const issue of overview.issues) {
    if (typeof issue.uid === 'string' && issue.uid.startsWith(run)) shares.set(issue.uid, (shares.get(issue.uid) ?? 0) + 1);
  }
  const honestShare = shares.get(honest) ?? 0;
  const floodShares = flooders.map((f) => shares.get(f) ?? 0);
  assert.ok(honestShare > 0, `the honest account was erased: ${honestShare}`);
  assert.ok(Math.max(...floodShares) - honestShare <= 1, `unfair cut: flooders ${Math.max(...floodShares)} vs honest ${honestShare}`);
  assert.equal(overview.issueCaps.groupsShown, overview.issueCaps.groupsWithRows);
});

test('the overview refuses everyone but the operator without reading anything', async () => {
  for (const context of [{}, asUser(`${run}-stranger`), { auth: { uid: ADMIN_UID, token: { email_verified: false } } }]) {
    await assert.rejects(deployed.admin.overview.run({}, context), (error: { code?: string }) => error.code === 'not-found');
  }
});
