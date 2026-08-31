import type {https} from "firebase-functions/v1";
import {logger} from "firebase-functions";

// SEC-014. Monitor phase (2026-08-30 04:59Z) logged whether each caller
// attached a valid App Check token so the enforcement flip could happen on
// evidence — every genuine-client line read `token: "present"`. Enforcement
// landed the same day: every callable now declares `enforceAppCheck: true`
// (source-pinned in tests/appcheck-client.test.ts), so the SDK refuses an
// unattested call before the handler runs and this line can only ever say
// `present`. It stays as the per-invocation confirmation that the verified
// path was taken (its own pin keeps it first in every handler); a refused
// call shows up as the SDK's `Failed to validate AppCheck token` warning
// and the platform's 401 count, not here. One short line per invocation,
// no user data.
export function logAppCheckPresence(
  name: string,
  context: https.CallableContext,
): void {
  logger.info("appcheck.monitor", {
    fn: name,
    token: context.app === undefined ? "missing" : "present",
  });
}
