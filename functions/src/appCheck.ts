import type {https} from "firebase-functions/v1";
import {logger} from "firebase-functions";

// SEC-014 monitor phase. Every callable records whether the caller attached
// a valid App Check token, so the enforcement flip (`enforceAppCheck: true`
// plus Firestore service enforcement) happens on evidence — days of
// `token: "present"` from the genuine clients — instead of hope. One short
// line per invocation: the rate is bounded by the same instance caps as the
// handler itself, and the line carries no user data. Remove the call sites
// when enforcement lands; a "missing" after that would be a rejected
// request, visible in the platform metrics instead.
export function logAppCheckPresence(
  name: string,
  context: https.CallableContext,
): void {
  logger.info("appcheck.monitor", {
    fn: name,
    token: context.app === undefined ? "missing" : "present",
  });
}
