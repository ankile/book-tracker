import * as functions from "firebase-functions/v1";
import {logger} from "firebase-functions";
import {getFirestore} from "firebase-admin/firestore";
import {decodeIssueReport} from "./decoders";
import {logIssue} from "./logging";
import {consumeQuota} from "./quota";
import {requireLiveUser, requireVerifiedUid} from "./callerGuards";
import {CALLABLE_MAX_INSTANCES, FUNCTIONS_RUNTIME_SERVICE_ACCOUNT} from "./runtime";
import {logAppCheckPresence} from "./appCheck";

const db = getFirestore();

// A client that is genuinely broken reports once per failed listener or
// write, so a handful of rows an hour is the honest ceiling; the cap exists
// so one account cannot fill the collection (billed storage, mirrored by
// PITR and 98 backup copies) on demand (SEC-038 — the admin feed is
// additionally capped per account at read time, see admin.ts). Excess is
// dropped, not queued: telemetry about a failure is not worth a retry
// storm. Over-quota calls still cost an invocation and one quota read
// each; the instance cap in runtime.ts bounds the rate, and the WARN line
// below fires once per user per window rather than once per rejected
// call, so a flood cannot turn log ingest into the bill.
const REPORTS_PER_WINDOW = 20;
const REPORT_WINDOW_MS = 60 * 60 * 1000;

const invalidArgument = (message: string): never => {
  throw new functions.https.HttpsError("invalid-argument", message);
};

// Replaces the client's direct logEvents write (SEC-001): anonymous rows
// are gone entirely — the only thing a signed-out client could report was
// its own failed sign-in, and that path was an unauthenticated write
// endpoint anyone could flood — and signed-in rows are now shaped,
// allowlisted and counted server-side before the Admin SDK stores them.
exports.reportissue = functions
  .runWith({
    serviceAccount: FUNCTIONS_RUNTIME_SERVICE_ACCOUNT,
    maxInstances: CALLABLE_MAX_INSTANCES,
    enforceAppCheck: true,
  })
  .region("europe-west1")
  .https.onCall(async (data: unknown, context): Promise<{recorded: true}> => {
    logAppCheckPresence("telemetry.reportissue", context);
    const uid = requireVerifiedUid(context);
    const issue = decodeIssueReport(data, invalidArgument);
    await requireLiveUser(uid);
    const decision = await consumeQuota(
      db,
      `users/${uid}/functionQuotas/issueReports`,
      REPORTS_PER_WINDOW,
      REPORT_WINDOW_MS,
    );
    if (!decision.granted) {
      if (decision.firstRefusal) {
        logger.warn("telemetry.quota_exceeded", {uid, event: issue.event});
      }
      throw new functions.https.HttpsError(
        "resource-exhausted",
        "Issue report limit reached. Try again later.",
      );
    }
    await logIssue({
      level: issue.level,
      event: issue.event,
      message: issue.message,
      code: issue.code ?? undefined,
      uid,
    });
    return {recorded: true};
  });
