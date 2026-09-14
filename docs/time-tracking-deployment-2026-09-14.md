# Direct time tracking production release

Book Tracker [PR #53](https://github.com/ankile/book-tracker/pull/53) and Threeggle [PR #2](https://github.com/ankile/threeggle/pull/2) were merged and deployed on September 14, 2026, with the owner's approval.

| Component | Released version |
|---|---|
| Book Tracker source | Merge `fb6c6535f31ca555a73b96baafbe3d408fa61cc3`, including reviewed head `422327e` |
| Threeggle source | Merge `ff675a1`, including reviewed head `0defef9` |
| Threeggle backend | Production Convex deployment, with the new API, schema and indexes |
| Threeggle frontend | Cloudflare Worker version `eeb4b443-1b70-4c79-a1ba-58976d1a5559` |
| Book Tracker frontend | Cloudflare Pages deployment `f9515cd7`, including the worker and service worker |
| Book Tracker backend | All Firebase Functions, matching public-profile shell, Firestore Rules and indexes, Storage Rules, and retired Hosting redirects |

The producer deployed first. Its stable service identity is configured, and the consumer points to the production HTTPS API. The explicit reader-only controls document was initialized before the consumer rollout. After deployment verification, controls were changed to `timerWriteVersion: 2` and `threeggleEnabled: true`. The owner will hard-reload all participating apps before using timers. Existing account provider preferences were preserved.

The new queue service's Eventarc runtime identity has the required per-service invoker binding. All Firestore indexes reached `READY`. The Cloudflare zone cache was purged. The shell-based purge command encountered a transport error; the authenticated API retry succeeded.

## Verification

- The pre-merge test suites, 12 browser tests, builds, bundle limits and audits passed. The four generated-artifact checks were repeated successfully immediately before deployment. Deployment prechecks passed, including Functions lint/build and Convex schema validation.
- The production Threeggle API returned the configured service identity, the intended account identity, all seven actions and `readiness: ready`. The temporary intended-account verification token was revoked.
- A separate synthetic Threeggle account passed live start, targeted stop and original-operation replay. Its Toggl bridge was not connected.
- A dedicated Firestore queue operation deferred delivery and then reached `synced` through Eventarc with one provider attempt and no browser clients or sweep invocation. The confirmed interval matched the submitted minute. An initial fixture mistakenly included a deletion marker; the live account guard correctly refused it. Correcting that fixture allowed normal delivery.
- The canonical Book Tracker app and Dashboard returned 200. The served service worker and version file matched the release byte for byte. The public profile returned 200 and referenced the same application entry assets. Retired Firebase Hosting returned the expected 301 redirect.
- The signed-in production UI displayed the existing Toggl preference and the newly enabled Threeggle option.
- Dedicated temporary Toggl entries verified an already-completed stop returns 409 without extending its duration, and a stop-only PUT returns 200 while retaining title, project and start and applying the requested end. The test entries were deleted. The existing running timer was unchanged.

## Verification limit

The live Toggl partial-PUT probe used a completed test entry because the owner's timer was running. The complete browser-offline-to-running-Toggl-stop sequence remains covered by automated tests rather than this live probe. A future dedicated live check should exercise that exact sequence when it can run without interrupting personal tracking. The provider's read/update race remains documented in the [release runbook](time-tracking-release.md).

Do not roll back to readers that cannot handle v2 timers. To suspend new Threeggle work, disable `threeggleEnabled` and retain the deployed readers, stops and recovery workers.
