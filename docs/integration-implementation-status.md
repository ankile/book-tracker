# Integration implementation and validation

The implementation is in Book Tracker PR #53 and Threeggle PR #2. Both remain drafts for review; neither is merged or deployed. The active worktrees are retained until approval and merge.

Implemented:

- Threeggle versioned API, timer-token authorization, durable positive/negative receipts, separate budgets and bounded overlap checks.
- Book Tracker v1/v2 readers, persistent provider choice, connection revisions and staged credentials, guarded legacy recovery, v2 worker and reviewed successors.
- Account-scoped IndexedDB outbox, immutable acceptance records, reconnect barrier, cross-tab reconciliation, rejected-interval recovery and explicit sign-out discard.
- Additive Rules/indexes, account cleanup, privacy-safe issue reporting, audit readers, updated architecture diagrams and coordinated release instructions.

Validation performed in the worktrees on 2026-09-13 (Pacific time):

| Area | Evidence |
|---|---|
| Threeggle | 295 Vitest tests, 15 Python adapter tests, lint and production build passed. |
| Book Tracker targeted checks | 475 unit tests, 223 Functions tests, 8 v2 Rules tests and 11 v2 backend transaction tests passed; the prior legacy/v2 Rules run reached 123/124, with its outdated deletion assertion corrected and the complete 20-test backend subset then passing. Full clean validation is pending below. |
| Browser recovery | Three timer browser tests passed: Neither and Toggl offline start/stop/reload with durable acknowledgements, plus rejected-revision reload and sign-out retention/discard. |
| Both real backends | Dedicated local test passed against Firestore and Convex: start/stop, original receipt lookup, completed-interval replay, and overlap rejection. |
| Manual local UIs | Threeggle login, Reading project and timer connection; Book Tracker project discovery/activation; matching remote start/stop; external-switch decline and accept; missing-credential failure and repair; local-only timer across reload; Toggl stub start/stop; provider switch refused while active. |
| Architecture | Updated diagrams rendered and the 11-route / five-diagram verification passed. |

All provider activity used synthetic accounts. Threeggle ran on isolated ports 3320/3321 with frontend 5274 and no Toggl bridge. Book Tracker used Auth/Firestore/Functions emulators and frontend 5173; the Toggl transport was stubbed. Actual Firestore Rules were loaded for manual testing. Production accounts and timers were not used.

## Final gate

- [ ] Complete Book Tracker `npm run validate` from committed source and generated artifacts.
- [ ] Push both implementation branches and replace the planning-only PR descriptions with implementation and validation evidence.

The release procedure is in [time-tracking-release.md](time-tracking-release.md). The Threeggle API is deployed first; Book Tracker readers ship with writers disabled; participating devices synchronize and reload before the server-owned controls enable v2 timers and Threeggle.
