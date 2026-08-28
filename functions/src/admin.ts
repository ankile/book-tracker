import * as functions from "firebase-functions/v1";
import {logger} from "firebase-functions";
import {getAuth, UserRecord} from "firebase-admin/auth";
import {AggregateField, getFirestore, Timestamp} from "firebase-admin/firestore";
import {ADMIN_MAX_INSTANCES, FUNCTIONS_RUNTIME_SERVICE_ACCOUNT} from "./runtime";
import {decodeEmptyCallableRequest} from "./decoders";
import {
  ANONYMOUS_ISSUE_LIMIT,
  assembleIssueFeed,
  FEED_LIMIT,
  IssueGroup,
  IssueIdentity,
  ISSUES_PER_UID,
} from "./adminIssues";

const db = getFirestore();

const invalidArgument = (message: string): never => {
  throw new functions.https.HttpsError("invalid-argument", message);
};

// The operator's immutable Firebase Auth UID. Deliberately not the email:
// signups are open and unverified, so an email address is a claimable
// string — if the operator account were ever deleted (or the project
// restored) anyone could re-register the address and inherit an email
// gate. A UID is never reissued.
const ADMIN_UID = "1Cf0CaNfgnVSvTrF5dYjzRd9Xri2";

const ISSUE_WINDOW_DAYS = 14;
const AUDIT_RETENTION_DAYS = 365;

// The issue feed is one query per account plus one for rows whose uid is
// null, each capped by Firestore itself (ISSUES_PER_UID /
// ANONYMOUS_ISSUE_LIMIT + 1 to detect the cap). There is deliberately no
// shared newest-N scan: a single account at the callable's
// 20-reports-an-hour quota would own a 500-row scan within a day and age
// every other account's rows out of it, and once ten accounts flood, a
// per-account cap applied after a shared scan stops doing anything at all
// (SEC-038 red-team, 2026-08-28). With a query per account, the most any
// account can contribute is its cap, and no account's volume affects what
// is read for another; FEED_LIMIT then bounds the response as a whole.
// What this feed does not see: rows of a uid that exists in neither Auth
// nor users/ (a fully purged account — today deleted accounts survive in
// the union through their orphaned subcollections; if account deletion
// ever becomes recursive, the feed needs another uid source, see SEC-096),
// and rows with no uid field at all (see assembleIssueFeed). There is no
// event allowlist on the read side any more: every logEvents row for an
// account is feed material, which is the contract logging.ts states.
// One failed per-account read no longer fails the page: the group is
// dropped, logged, and counted on the wire as unreadAccounts.
// The caps themselves live in adminIssues.ts (a plain module, so tests can
// pin them without loading the callable exports).

// Successful views append an audit row (only the operator can produce
// one). Denials go to Cloud Logging instead of Firestore: any signed-in
// account can call this endpoint (sign-up is open), so a Firestore write
// per denial — a row, or even a per-caller counter — is billed storage and
// a write hotspot that a stranger controls, and it can bury the rows that
// matter. Logging keeps the uid and email for forensics and costs only
// log ingest (~1 KB per call, billed past 50 GiB/month — bounded by the
// instance cap); a denial flood trips the admin.denied alert.
async function audit(
  type: "view" | "denied",
  caller: {uid: string; email: string | null},
): Promise<void> {
  if (type === "denied") {
    functions.logger.warn("admin.denied", {uid: caller.uid, email: caller.email});
    return;
  }
  const now = Timestamp.now();
  await db.collection("adminAudit").add({
    type,
    uid: caller.uid,
    email: caller.email,
    at: now,
    expiresAt: Timestamp.fromMillis(
      now.toMillis() + AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ),
  });
}

// Decides on context.auth only, which the callables runtime populates from
// a server-verified ID token; requires the operator UID plus a verified
// email as defense in depth; and runs before any privileged read, so no
// cross-user data is touched for a non-admin.
//
// Unauthenticated callers are rejected without logging anything. They carry
// no uid and no email, so a denial record would hold no forensic signal.
// Authenticated denials are the ones worth keeping: those name a real
// account that went looking.
//
// Note that rejecting with "not-found" does NOT hide the endpoint's
// existence — a callable answers a malformed token with a structured 401
// and an OPTIONS preflight with a 204, both of which a nonexistent function
// never does. Treat this as an authorization boundary, not a secret one.
async function requireAdmin(
  context: functions.https.CallableContext,
): Promise<void> {
  const caller = context.auth;
  if (!caller) {
    throw new functions.https.HttpsError("not-found", "Not found.");
  }
  const identity = {uid: caller.uid, email: caller.token.email ?? null};
  if (caller.uid === ADMIN_UID && caller.token.email_verified === true) {
    await audit("view", identity);
    return;
  }
  await audit("denied", identity);
  throw new functions.https.HttpsError("not-found", "Not found.");
}

// Every admin endpoint is built through this wrapper so the gate is
// inherited by construction. Declaring a callable directly in this file
// would compile and deploy perfectly well while being wide open — the
// wrapper is what makes forgetting the check impossible rather than
// merely unlikely.
function adminCallable(
  handler: () => Promise<unknown>,
): functions.HttpsFunction {
  return functions
    .region("europe-west1")
    .runWith({serviceAccount: FUNCTIONS_RUNTIME_SERVICE_ACCOUNT, maxInstances: ADMIN_MAX_INSTANCES})
    .https.onCall(async (data: unknown, context) => {
      await requireAdmin(context);
      decodeEmptyCallableRequest(data, invalidArgument);
      return handler();
    });
}

// Auth metadata timestamps are RFC-2822 strings while Firestore hands back
// Timestamps; comparing mixed formats as strings orders wrongly, so every
// time becomes epoch millis. null (never recorded) stays distinct from 0.
function millis(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function timestampMillis(value: unknown): number | null {
  return value instanceof Timestamp ? value.toMillis() : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// All aggregation runs inside Firestore — a user's updates subcollection
// can hold thousands of docs and must not be streamed here. The sources
// mirror the Me page exactly so the numbers match the product: pagesRead/
// timeRead sum the books' own aggregate fields, and reading sessions come
// from owner == user && type == 'reading' on the updates collection group.
async function domainStats(uid: string) {
  const books = db.collection(`users/${uid}/books`);
  const sessions = db.collectionGroup("updates")
    .where("owner", "==", db.doc(`users/${uid}`))
    .where("type", "==", "reading");
  // One aggregate per query: combining count + two sums in a single
  // aggregate requires a composite (pagesRead, timeRead) index, while
  // single-field aggregates run on the automatic indexes.
  const [bookAgg, pagesAgg, timeAgg, finishedAgg, sessionAgg, lastEdit, lastRead] =
    await Promise.all([
      books.count().get(),
      books.aggregate({pagesRead: AggregateField.sum("pagesRead")}).get(),
      books.aggregate({timeRead: AggregateField.sum("timeRead")}).get(),
      books.where("finished", "==", true).count().get(),
      sessions.count().get(),
      books.orderBy("updatedAt", "desc").limit(1).get(),
      sessions.orderBy("createdAt", "desc").limit(1).get(),
    ]);
  // "Last read" is the newest reading session, not the newest book write.
  // A book's updatedAt also moves when the title is edited or a page
  // correction is filed, and it deliberately does not move when a local
  // timer runs — so using it here dated reading activity for users who had
  // never logged a single session.
  const readAt = timestampMillis(lastRead.docs[0]?.get("createdAt"));
  const editAt = timestampMillis(lastEdit.docs[0]?.get("updatedAt"));
  return {
    books: bookAgg.data().count,
    pagesRead: pagesAgg.data().pagesRead,
    timeRead: timeAgg.data().timeRead,
    finishedBooks: finishedAgg.data().count,
    readingSessions: sessionAgg.data().count,
    lastReadAt: readAt,
    lastEditAt: editAt,
  };
}

// One capped, newest-first read for a single account (or for uid-null
// rows). limit + 1 so the assembler can report the cap honestly.
async function readIssuesFor(
  uid: string | null,
  limit: number,
  cutoff: Timestamp,
): Promise<IssueGroup> {
  const snap = await db.collection("logEvents")
    .where("uid", "==", uid)
    .where("createdAt", ">=", cutoff)
    .orderBy("createdAt", "desc")
    .limit(limit + 1)
    .get();
  return {
    uid,
    documents: snap.docs.map((doc) => ({
      id: doc.id,
      value: doc.data(),
      fallbackAt: doc.createTime?.toMillis() ?? cutoff.toMillis(),
    })),
  };
}

exports.overview = adminCallable(async () => {
  // listUsers returns one capped page; stopping there would silently
  // truncate the table and undercount every total, so follow pageToken
  // until the API stops handing one back.
  const authUsers: UserRecord[] = [];
  let pageToken: string | undefined;
  do {
    const page = await getAuth().listUsers(1000, pageToken);
    authUsers.push(...page.users);
    pageToken = page.pageToken;
  } while (pageToken);

  // Render off the union of auth users and profile docs: the
  // createUserDocument/deleteUserDocument triggers keep them in sync but
  // are not transactional with the auth record, so an orphan on either
  // side must surface as an anomaly instead of vanishing from the table.
  // listDocuments() rather than get() because deleting a user document
  // leaves its books subcollection behind, and only listDocuments()
  // reports those phantom parents — a get() would show nothing at all
  // while the orphaned reading data sat in the database unnoticed.
  const profiles = await db.collection("users").get();
  const profileIds = (await db.collection("users").listDocuments())
    .map((ref) => ref.id);
  const authByUid = new Map(authUsers.map((user) => [user.uid, user]));
  const profileByUid = new Map(profiles.docs.map((snap) => [snap.id, snap]));
  const uids = [...new Set([...authByUid.keys(), ...profileIds])];

  const users = await Promise.all(uids.map(async (uid) => {
    const authUser = authByUid.get(uid);
    const stats = await domainStats(uid);
    const lastSignInAt = millis(authUser?.metadata.lastSignInTime);
    const lastRefreshAt = millis(authUser?.metadata.lastRefreshTime);
    const activity = [stats.lastReadAt, stats.lastEditAt, lastSignInAt, lastRefreshAt]
      .filter((t): t is number => t !== null);
    return {
      uid,
      email: authUser?.email ??
        optionalString(profileByUid.get(uid)?.get("email")) ?? null,
      emailVerified: authUser?.emailVerified ?? null,
      signedUpAt: millis(authUser?.metadata.creationTime),
      lastSignInAt,
      lastActiveAt: activity.length > 0 ? Math.max(...activity) : null,
      anomaly: !authUser ?
        (profileByUid.has(uid) ? "auth user deleted" : "orphaned data") :
        !profileByUid.has(uid) ? "profile doc missing" : null,
      ...stats,
    };
  }));
  users.sort((a, b) => (b.lastActiveAt ?? -1) - (a.lastActiveAt ?? -1));

  // Distinguishes "this uid has no auth record" from "this account exists
  // but has no email address" — collapsing both into "(deleted user)"
  // stated something false about live accounts.
  const identities = new Map<string, IssueIdentity>(uids.map((uid) => {
    const authUser = authByUid.get(uid);
    if (!authUser) return [uid, {email: "(deleted user)", verified: false}];
    const profileEmail = optionalString(profileByUid.get(uid)?.get("email"));
    return [uid, {email: authUser.email ?? profileEmail ?? uid, verified: true}];
  }));

  const cutoff =
    Timestamp.fromMillis(Date.now() - ISSUE_WINDOW_DAYS * 24 * 3600 * 1000);
  const reads = await Promise.allSettled([
    ...uids.map((uid) => readIssuesFor(uid, ISSUES_PER_UID, cutoff)),
    readIssuesFor(null, ANONYMOUS_ISSUE_LIMIT, cutoff),
  ]);
  const groups: IssueGroup[] = [];
  let unreadAccounts = 0;
  reads.forEach((read, index) => {
    if (read.status === "fulfilled") {
      groups.push(read.value);
      return;
    }
    unreadAccounts += 1;
    logger.error("admin.issues.read_failed", {
      uid: index < uids.length ? uids[index] : null,
      message: read.reason instanceof Error ? read.reason.message : String(read.reason),
    });
  });
  const feed = assembleIssueFeed(
    groups,
    ISSUES_PER_UID,
    ANONYMOUS_ISSUE_LIMIT,
    FEED_LIMIT,
    identities,
  );

  return {
    users,
    issues: feed.rows,
    issueWindowDays: ISSUE_WINDOW_DAYS,
    issueCaps: {
      perAccount: ISSUES_PER_UID,
      cappedAccounts: feed.cappedAccounts,
      anonymous: ANONYMOUS_ISSUE_LIMIT,
      anonymousCapped: feed.anonymousCapped,
      shown: feed.rows.length,
      total: feed.total,
      unreadAccounts,
    },
  };
});
