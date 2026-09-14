# Integration implementation and validation

The implementation is in Book Tracker PR #53 and Threeggle PR #2. Both are ready for implementation review; neither is merged or deployed. The active worktrees are retained until approval and merge.

Implemented:

- Threeggle versioned API, timer-token authorization, durable positive/negative receipts, separate budgets and bounded overlap checks.
- Book Tracker v1/v2 readers, persistent provider choice, connection revisions and staged credentials, guarded legacy recovery, v2 worker and reviewed successors.
- Account-scoped IndexedDB outbox, immutable acceptance records, reconnect barrier, cross-tab reconciliation, rejected-interval recovery and explicit sign-out discard.
- Additive Rules/indexes, account cleanup, privacy-safe issue reporting, audit readers, updated architecture diagrams and coordinated release instructions.

Validation performed in the worktrees on 2026-09-13 (Pacific time):

| Area | Evidence |
|---|---|
| Threeggle | 295 Vitest tests, 15 Python adapter tests, lint and production build passed. |
| Book Tracker test suite | Type checks passed with no diagnostics; 475 unit tests, two two-test migration suites, 129 combined Rules/backend tests, 9 PWA tests, 223 Functions tests and the catalog emulator test passed. The combined suite includes 8 v2 Rules tests and 12 v2 backend transaction tests, including background retry without an open browser. Functions lint also passed. |
| Browser suite | All 6 Playwright tests passed with repository Rules explicitly loaded. The three timer cases cover Neither and Toggl offline start/stop/reload, cross-tab acknowledgements, rejected-revision recovery across direct Settings navigation/reload, and sign-out cancellation/discard followed by re-login. |
| Production checks | Build, 4 generated-artifact checks and the bundle check passed. Total compressed JavaScript is 368.1 KiB against the documented 370 KiB budget; the largest-chunk limit remains 170 KiB. Both dependency audits reported zero vulnerabilities. |
| Both real backends | Dedicated local test passed against Firestore and Convex: start/stop, original receipt lookup, completed-interval replay, and overlap rejection. |
| Manual local UIs | Threeggle login, Reading project and timer connection; Book Tracker project discovery/activation; matching remote start/stop; external-switch decline and accept; missing-credential failure and repair; local-only timer across reload; Toggl stub start/stop; provider switch refused while active. |
| Architecture | Updated diagrams rendered and the 11-route / five-diagram verification passed. |

All provider activity used synthetic accounts. Threeggle ran on isolated ports 3320/3321 with frontend 5274 and no Toggl bridge. Book Tracker used Auth/Firestore/Functions emulators and frontend 5173; the Toggl transport was stubbed. Actual Firestore Rules were loaded for manual testing. Production accounts and timers were not used.

## Release validation

All checks in Book Tracker's `npm run validate` gate passed: `npm test`, `npm run test:e2e`, `npm run build`, `npm run test:artifacts`, `npm run test:bundle`, `npm audit --omit=dev`, and `npm --prefix functions audit`. The browser suite and subsequent gates were rerun after correcting its sign-out/re-login synchronization. Application source and generated artifacts were committed before artifact verification.

Both implementation branches are pushed with implementation and validation evidence in the paired PRs. Earlier model reviews covered the plans; implementation review and release approval are still required.

The release procedure is in [time-tracking-release.md](time-tracking-release.md). The Threeggle API is deployed first; Book Tracker readers ship with writers disabled; participating devices synchronize and reload before the server-owned controls enable v2 timers and Threeggle.
