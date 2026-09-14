# Integration implementation and validation

The implementation is in Book Tracker PR #53 and Threeggle PR #2. Both are ready for implementation review; neither is merged or deployed. The active worktrees are retained until approval and merge.

Implemented:

- Threeggle versioned API, timer-token authorization, durable positive/negative receipts, separate budgets and bounded overlap checks.
- Book Tracker v1/v2 readers, persistent provider choice, connection revisions and staged credentials, guarded legacy recovery, v2 worker and reviewed successors.
- Account-scoped IndexedDB outbox, immutable acceptance records, reconnect barrier, cross-tab reconciliation, rejected-interval recovery and explicit sign-out discard.
- Additive Rules/indexes, account cleanup, privacy-safe issue reporting, audit readers, updated architecture diagrams and coordinated release instructions.

Validation performed in the worktrees on 2026-09-13 and repeated for the Book Tracker review fixes on 2026-09-14 (Pacific time):

| Area | Evidence |
|---|---|
| Threeggle | 295 Vitest tests, 15 Python adapter tests, lint and production build passed. |
| Book Tracker test suite | Type checks passed with no diagnostics; 475 unit tests, two two-test migration suites, 135 combined Rules/backend tests, 9 PWA tests, 223 Functions tests and the catalog emulator test passed. The combined suite includes 8 v2 Rules tests and 18 v2 backend transaction tests, including background retry without an open browser, Toggl external edits/completion and targeted Threeggle recovery after the original project disappears. Functions lint also passed. |
| Browser suite | All 9 Playwright tests passed with repository Rules explicitly loaded. Coverage includes Neither and Toggl offline start/stop/reload, cross-tab acknowledgements, rejected-revision recovery across direct Settings navigation/reload, sign-out cancellation/discard followed by re-login, and confirmed reading durations after Threeggle external stop/start edits and Toggl targeted stop. |
| Production checks | Build, 4 generated-artifact checks and the bundle check passed against the unchanged 370 KiB total and 170 KiB largest-chunk limits. Both dependency audits reported zero vulnerabilities. |
| Both real backends | Dedicated local test passed against Firestore and Convex: start/stop, original receipt lookup, completed-interval replay, and overlap rejection. |
| Manual local UIs | Threeggle login, Reading project and timer connection; Book Tracker project discovery/activation; matching remote start/stop; external-switch decline and accept; missing-credential failure and repair; local-only timer across reload; Toggl stub start/stop; provider switch refused while active. |
| Architecture | Updated diagrams rendered and the 11-route / five-diagram verification passed. |

All provider activity used synthetic accounts. Threeggle ran on isolated ports 3320/3321 with frontend 5274 and no Toggl bridge. Book Tracker used Auth/Firestore/Functions emulators and frontend 5173; the Toggl transport was stubbed. Actual Firestore Rules were loaded for manual testing. Production accounts and timers were not used.

## Release validation

All checks in Book Tracker's `npm run validate` gate passed: the checks comprising `npm test`, `npm run test:e2e`, `npm run build`, `npm run test:artifacts`, `npm run test:bundle`, `npm audit --omit=dev`, and `npm --prefix functions audit`. On September 14, the first full test command stopped at a Functions lint shadowing error after its earlier suites passed; after renaming the variables, Functions lint/build/tests and every remaining gate passed. Application source and generated artifacts were committed before artifact verification.

## Implementation review fixes — September 14

The [first Astra implementation review](https://github.com/ankile/book-tracker/pull/53#pullrequestreview-5201185411) identified three consumer issues. Commit `42cd09d` addresses all three:

- Online Toggl stops use the targeted PATCH endpoint and read an already-completed target after a conflict. Offline stops read the target first and update only its stop timestamp, preserving existing title/project/start edits and completed entries. Toggl does not offer a conditional timestamp update, so an external stop racing the offline read/update remains a provider limitation documented in the release runbook.
- Reviewed Threeggle targeted-stop successors no longer require the original configured project to remain active; the producer validates the repaired target. New interval exports retain project validation.
- Online Add Reading waits for a confirmed provider interval. Pending/offline durations are explicitly labelled as device estimates. Regression tests cover external completion, edited start times and completed Toggl targets.

The September 14 manual test used both running local apps and real isolated Firestore/Convex backends: a reading timer was renamed and moved 30 minutes earlier in Threeggle, then switched to another activity. Stopping the original timer from Book Tracker opened Add Reading with 30 confirmed minutes, preserved the edited title and left the new activity running. The synthetic activity was then stopped in Threeggle; all consumer queue rows were synced and the claim was idle.

The [producer implementation review](https://github.com/ankile/threeggle/pull/2#pullrequestreview-5201189968) found no producer issues; its code is unchanged in this pass.

## Recovered-start review fix

The [fresh Astra review](https://github.com/ankile/book-tracker/pull/53#pullrequestreview-5202250272) confirmed the three earlier fixes and found one further consumer issue: replaying a committed Threeggle start could restore a running timer from an old receipt after external completion or deletion. The [paired producer review](https://github.com/ankile/threeggle/pull/2#pullrequestreview-5202251693) found no actionable producer issues.

Every successful Threeggle start now reads its recorded entry before promoting the local timer, including after credential repair resets the retry counter. A running entry uses its current start time. A completed entry releases the matching timer claim and retains the confirmed final interval. A missing entry releases the claim with a terminal `entry_not_found` recovery item. Failed or mismatched lookups cannot promote the timer. The original receipt and current observation are stored separately; replay retains the original operation ID and request.

Six added emulator regressions cover lost-response recovery after completion, deletion or start/title/project edits, plus authorization failure, throttling and a mismatched lookup target. All 32 focused backend/Rules tests, 475 unit tests, 223 Functions tests, Functions lint/build and Node TypeScript checks passed. The real isolated Firestore/Convex test also passed with the added entry lookup. Local disk exhaustion required clearing regenerable package caches and restarting the isolated Convex backend before that test could run. Application UI and producer code are unchanged; the prior browser/build/audit evidence above still applies to those unchanged files. Review and release approval are still required.

The release procedure is in [time-tracking-release.md](time-tracking-release.md). The Threeggle API is deployed first; Book Tracker readers ship with writers disabled; participating devices synchronize and reload before the server-owned controls enable v2 timers and Threeggle.
