# Direct time tracking integration release

Book Tracker stores one account preference: Neither, Toggl Track, or Threeggle. The preference applies to subsequent reading timers. Threeggle uses the existing timer connection tokens from its Settings page. Tokens remain in the separate secrets database, bound to the active connection revision. No browser-supplied service URL is accepted.

## Coordinated release

1. Deploy Threeggle PR #2 first. Configure a stable `TIME_TRACKING_SERVICE_ID`; do not change it on normal releases. Confirm `/api/time-tracking/v1` reports all seven actions and `readiness: ready` for the intended account. Existing `/api/timer` clients remain supported.
2. Deploy Book Tracker's additive Rules, indexes, Functions, v1/v2 client readers, and audit readers. Keep `configuration/timeTracking` absent or `{timerWriteVersion: 1, threeggleEnabled: false}`. Configure Functions `THREEGGLE_API_URL` with the deployed HTTPS site endpoint ending in `/api/time-tracking/v1`. Follow the existing deployment guide for the app and matching public-profile shell artifacts.
3. Require participating devices to synchronize pending work and reload the new app/PWA. Old strict readers cannot display v2 timer records. Elapsed time alone does not prove an offline device has updated.
4. After both PRs are approved and deployed, set the server-owned configuration to `{timerWriteVersion: 2, threeggleEnabled: true}`. Connect a timer token and active Reading project through Dashboard → Settings → Time tracking. Verify online start/stop, a completed offline interval, and recovery with dedicated test entries.
5. To suspend new Threeggle work, set `threeggleEnabled: false`. Keep v2 readers and workers deployed. Existing stops, durable queue replay, receipt reads, and same-identity credential repair remain available. Do not roll back to a client that cannot read v2 data.

Neither merging nor deployment is performed by the implementation PRs. Keep both active worktrees until approval and merge, then remove merged branches/worktrees using the normal cleanup process.

## Data and recovery

`users/{uid}.timeTracking` stores the provider, revision and remote identity/project. `timerLifecycle/current` remains the sole account-wide timer claim. `timeTrackingQueue/{operationId}` retains original intents, the first prepared request, retry state and reviewed-successor links. `timerOperations/{operationId}` provides immutable acceptance evidence for every v2 operation, including local-only timers. `timeTrackingResults/{operationId}` stores private remote snapshots and reviewed corrections. These records have no TTL in the first release and are removed by account deletion.

The browser's separate IndexedDB timer outbox persists before submitting an atomic Firestore batch or callable. Reconciliation runs from the authenticated app layout, including direct Settings loads, on reconnect and every five minutes. It uses a per-account Web Lock, waits for pending Firestore writes, and checks durable acknowledgements. A rejected revision stays visible with its original interval; it is never redirected to the newly selected app. Sign-out with unresolved device work offers cancellation or explicit discard and warns about a potentially running remote timer.

The queue trigger keeps Eventarc delivery retryable while a row is pending or leased, so a deferred operation does not depend on an open browser. Worker leases and stored retry times prevent early or concurrent provider requests. Terminal and resolved rows end delivery.

Connection changes require an idle claim and resolved legacy/v2 queues. Credentials are staged before activating a revision, and the previous token is deleted only after the revision transaction commits. Repair preserves the account/project/revision. A terminal failure can be acknowledged after checking the remote outcome. A reviewed non-applied completed export gets one linked successor with a new request ID; transport retries retain the old ID and exact prepared body. Uncertain Toggl creates are never blindly recreated.

Legacy terminal create acknowledgements retain the original queue record and a server-owned `legacyResolution`; correlated stop recovery records that resolution while clearing its matching claim. Client writes, workers and sweeps cannot remove or rearm an acknowledgement.

Online remote stops wait for the worker's confirmed interval before suggesting reading minutes. A device-only interval or a remote operation still pending after 15 seconds uses a clearly marked estimate. Leaving the page cancels that page's confirmation listeners without cancelling the saved operation. Failure and reviewed-successor states direct the reader to recovery instead of presenting a final duration.

V2 online Toggl stops use the targeted `PATCH /stop` endpoint. A 409 reads the already-completed entry without changing it. Delayed offline stops read the target first, retain an existing completion, and otherwise update only the recorded stop timestamp. They do not send the saved description, project, start, or duration. Toggl's API has no conditional timestamp update, so a simultaneous external stop during that offline read/update cannot be made atomic by the consumer. See [Toggl's endpoint contract](https://engineering.toggl.com/docs/track/api/time_entries/). Threeggle provides the stronger atomic targeted-stop guarantee through its transaction and receipts.

Reviewed Threeggle targeted stops require the same service/account but do not require the old configured project to remain active. The producer validates the repaired target. New completed exports still require an active project, including any explicitly reviewed replacement project.

## Local verification

Ordinary Functions tests use an in-process Threeggle stub and a Toggl stub. Setting an endpoint without explicitly selecting isolated mode fails before any request. A real local round trip uses a fresh anonymous Convex backend and:

- Threeggle API/site ports 3320/3321; frontend 5274; no Toggl bridge credential.
- Firebase Auth 9099, Firestore 8080 and Functions 5001 (or a loopback proxy to a different local Functions port).
- Book Tracker `VITE_EMULATOR=1` and Functions `THREEGGLE_LOCAL_MODE=isolated`, `THREEGGLE_API_URL=http://127.0.0.1:3321/api/time-tracking/v1`.
- Disposable test accounts, projects and books only. Load the actual default-database Rules into the emulator; the CLI's multi-database configuration may otherwise warn that it is using permissive rules. Playwright global setup loads the repository Rules explicitly.
- For manual browser testing, the local App Check proxy may inject the same unsigned emulator-only attestation used by Playwright. It must bind only to loopback and forward only to the local Functions port. It is not a production authentication configuration.

Run `npm run validate` from a committed source/build state for the clean-artifact checks. New coverage includes the shared protocol, transport containment, real Firestore transactions, v2 Rules, offline browser start/stop/reload, and multi-tab acknowledgement reconciliation. See the implementation status document for the exact current validation evidence.

## Operational limits

Threeggle allows 31-day completed intervals and at most 256 raw overlap candidates, returning a retained typed rejection for oversized or over-budget intervals. No interval is split or shortened silently. Service clock skew returns retryable `clock_ahead` without a receipt. Book Tracker bounds connection requests, context reads, recovery sweeps, queue rows and provider attempts separately. Retry-limit, credential and conflict states are visible in Settings.

Timer diagnostics contain only provider, operation ID, bounded error code, attempt count and entry keys. Remote titles, token values, original/frozen descriptions and conflict snapshots stay out of issue logs and administrator summaries. The server-only failure event cannot be submitted through the client telemetry allowlist.
