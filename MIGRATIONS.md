# Database migration playbook

How to change the shape of data in the `(default)` Firestore database of
`book-tracker-d8f24` without losing anything. Every rule in here was either
proven by rehearsal or written down after nearly learning it the hard way —
follow the loop in order, don't skip steps because a migration "is tiny".
(The first real migration under this playbook WAS tiny — six one-field
backfills — and still went through the whole loop; that run is the template.)

## The toolbox (repo root)

| Script | What it does | Writes? |
|---|---|---|
| `migrate-lib.ts` | shared target guard, batcher, snapshot codec | — |
| `db-snapshot.ts` | full-database dump to `snapshots/<ISO>-<target>.json` | no |
| `db-restore.ts` | load a dump into the emulator (or prod, disaster only) | yes |
| `db-audit.ts` | read-only drift report, diff-friendly output | no |
| `migrate-*.ts` | one script per migration, kept forever as history | yes |

All scripts share the same target rules, enforced in `migrate-lib.ts`:

- **Default target is the emulator.** Without `--prod` the service-account
  key is never read and the script crashes unless `FIRESTORE_EMULATOR_HOST`
  is set — reaching production from the rehearsal code path is impossible,
  not merely guarded.
- `--prod` crashes if `FIRESTORE_EMULATOR_HOST` is set (contradiction),
  reads `./serviceAccountKey.json`, and asserts its `project_id`.
- Write scripts are **dry-run by default**; `--apply` is required to write,
  and `--prod --apply` additionally requires typing the project id.
  `db-restore.ts --prod` selects production but still writes nothing. It checks
  local restore inputs and service-account project identity; it does not verify
  production connectivity or permissions. Its opening and closing banners print
  `NOTHING WRITTEN` and the exact `--prod --apply` command needed to perform the
  restore.
- `--database=<id>` targets a named database (used for backup recovery).
- Unknown flags crash — a typoed `--aply` must not demote a run to dry-run.

## The migration loop

### 0. Prerequisites

- The migration script uses `migrate-lib.ts` (`connect`, `batcher`) and is
  **idempotent**: every write is guarded on the defect/old shape being
  present, so a re-run after a clean pass performs 0 writes. Migrations must
  stay cheap to re-run — stale offline clients flush old-shape writes days
  later (see "Stale clients" below).
- `npm test` green (the unit suite covers the codec, the batcher guards,
  and the finished rule that audit + client share).

### 1. Baseline audit

```sh
node db-audit.ts --prod > audit-pre.txt
```

### 2. Emulator rehearsal, with real triggers

```sh
PATH="/opt/homebrew/opt/openjdk/bin:$PATH" \
  npm --prefix functions run serve
# in another shell:
node db-snapshot.ts --prod                      # fresh dump (or reuse a recent one)
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
node db-restore.ts snapshots/<file>.json --apply
node migrate-<name>.ts                          # dry-run: review every line
node migrate-<name>.ts --apply                  # triggers fire for real here
node migrate-<name>.ts --apply                  # MUST print 0 writes
node db-audit.ts > audit-emulator-post.txt
diff audit-pre.txt audit-emulator-post.txt      # exactly the intended lines, nothing else
```

The functions emulator runs the real compiled triggers (gen1 Firestore
triggers work in the emulator; the eur3 gen1 restriction is deploy-time
only), so trigger–migration interaction is rehearsed for real, not assumed.
The `serve` command stages the checked-in dummy `.secret.emulator`; never put
real credentials in that fixture or bypass `serve` with a raw Firebase command.
Toggl HTTP calls are replaced with deterministic responses whenever
`FUNCTIONS_EMULATOR=true`, so production tokens restored in a snapshot never
leave the machine. Queue and timer documents still follow their real server
lifecycle in the emulated Firestore database. The metered Google Books proxy
returns a local miss instead of consuming the production key.
Inspect anything suspicious in the emulator UI at http://127.0.0.1:4000.

### 2b. Rehearse the real client against the migrated data

When a migration changes what the client reads or writes, run the actual
client against the migrated emulator data before deploying anything. Run
`npm --prefix functions run serve` to start Authentication, Firestore, and
Functions together, then create an auth user with your own prod uid so the
snapshot's data is yours:

```sh
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 node --input-type=module -e "
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
initializeApp({ projectId: 'book-tracker-d8f24' });
await getAuth().createUser({ uid: '<your-prod-uid>', email: 'me@test.local', password: 'test1234' });"
VITE_EMULATOR=1 npm run dev
```

`VITE_EMULATOR` flips the DEV-gated hooks in `src/lib/firebase/db.ts`,
`auth.ts`, and `functions.ts` to the local emulators. Exercise every read and
write path the migration touches, then re-run the migration dry-run: the writes
the fresh client just made must be invisible to it (0 ops against new-shape docs).

### 3. Deploy code changes, in this order

1. **Functions** (`firebase deploy --only functions:<name>`) — trigger
   behavior must be correct before bulk writes land.
2. **Firestore rules/indexes and Storage rules** (`firebase deploy --only
   firestore,storage`). `storage.rules` is deny-all (the app does not use
   Cloud Storage; added 2026-08-26 for SEC-017) and should stay that way
   unless a feature starts using the bucket. The Firebase Auth project
   config is not deployable from this repo: email enumeration protection
   and the password policy (minimum 12 characters, no character-class
   rules, existing passwords not force-upgraded) were set 2026-08-26 for
   SEC-015 through the Identity Toolkit admin API
   (`PATCH admin/v2/projects/book-tracker-d8f24/config`) and must be
   re-applied by hand if the project is ever recreated.
3. **Hosting** (`npm run build` + `firebase deploy --only hosting`).

Rules before hosting is load-bearing: the client writes in atomic
`writeBatch`es, so if new client code touches a not-yet-allowed collection,
the rules rejection loses the WHOLE batch — including the book write inside
it. Hosting serves `index.html` with `no-cache`, so navigations pick up new
client code promptly, but assume days of overlap with stale cached clients
(offline PWA).

The timer-lifecycle schema is an exception to this general order. For the
strict-TypeScript release, follow the [timer-claim rollout](#timer-claim-rollout)
and then the [reading-progress-source rollout](#reading-progress-source-rollout)
below. Timer claims are migrated before Hosting; progress ownership is
backfilled only after the compatible client has replaced stale clients.

The public-profile renderer is another explicit exception to a standalone
Hosting deployment. `npm run build` copies the generated `public/index.html`
to `functions/assets/profile-shell.html`, including its hashed asset
references. After profile search indexing exists, deploy the renderer and
Hosting from that same build with:

```bash
npm run build
npm exec --yes --package firebase-tools@15.24.0 -- \
  firebase deploy --only functions:publicweb,hosting
```

Deploy the additive `profileDiscovery` Firestore rules before exposing the UI
that writes markers. Do not deploy Hosting alone: old and new `publicweb`
revisions are safe only with the Hosting release whose shell they embed.

#### Timer-claim rollout

The `migrate-timer-claims.ts` rollout is deliberately stricter than the usual
order because the lifecycle document serializes every timer start:

1. Deploy the timer-correlation rules first. They keep metadata edits working
   but reject every legacy client timer mutation that lacks the lifecycle
   write.
2. Immediately deploy the claim-aware Toggl Functions. Calls for an unmigrated
   user fail closed because `timerLifecycle/current` is missing. Let old
   in-flight start invocations drain before continuing; they use the prior
   all-books transaction and the migration will capture their final state.
3. Dry-run `migrate-timer-claims.ts --prod`, then take the production snapshot.
   Apply the migration twice; the second apply must report zero users. Run the
   audit and require zero `timer-lifecycle.*` findings before moving on. A
   malformed timer, malformed existing lifecycle document, conflicting claim,
   or multiple active books aborts the migration for a human decision.
4. Deploy Hosting last. Cached old clients remain unable to write an
   uncorrelated timer, while unrelated book edits still work.

The migration writes a persistent `users/<uid>/timerLifecycle/current`
document. Idle state is explicit, and every clear records the exact prior
claim. That identity makes a stale offline clear reject if the same book has
started a newer timer. Do not delete idle lifecycle documents.

#### Reading-progress-source rollout

The new client tolerates a missing `currentPageUpdateId`, so deploy it before
backfilling that field. This order matters: once a book has a source key, a
cached old client can submit an offline reading batch that omits the key and is
rejected as a whole. A rejected batch loses the reading update rather than only
its provenance.

1. After the timer rollout deploys Hosting, reload or close every open
   client before backfilling: any still-running old bundle, online or
   offline, writes the old shape. An old online tab rejects its next reading
   batch immediately after the backfill; an offline client rejects when its
   queued batch reconnects. A rejected batch costs at most that one reading
   update and heals on reload. This app has a single operator-user
   (decided 2026-08-26), so there is no multi-user overlap window — reload
   your own clients and proceed the same day. Record the window actually
   observed in the rollout log.

   Session edit/delete rewind is deliberately disabled on un-backfilled books
   during this window. If the establishing session changes or disappears, its
   page remains as a safe baseline. A final
   `book.progress-source-null-baseline` can therefore be a window artifact,
   not missing legacy history; investigate it rather than accepting it in
   bulk.
2. Dry-run `migrate-reading-progress-sources.ts --prod` and review every line,
   then take a fresh production snapshot immediately before writing.
3. Apply the migration twice; the second apply must report zero books. It
   assigns the newest deterministic reading or page-correction row whose
   endpoint matches `currentPage`, without touching `updatedAt`. Transactions
   re-read each book and its updates so concurrent progress wins. An invalid
   existing source aborts for a human decision.
4. Run the audit. Investigate every
   `book.progress-source-null-baseline`: it means nonzero `currentPage` has no
   establishing history row. Record each accepted legacy baseline in the
   rollout log. All other `book.progress-source-*` findings must be zero.

Keep the migration cheap and idempotent, re-run it with the follow-up audit for
stragglers, and do not remove it from the repository.

#### Strict-TypeScript release record and rollback boundary

Merging this change does not deploy it: this repository has no GitHub Actions
or other merge-to-Firebase automation. Merge with a merge commit so the whole
conversion has one revert boundary. Before the first production command,
record these together in the rollout log:

- the merge SHA and the exact pre-release production SHA; create and push an
  annotated tag at the latter;
- the current Firebase Hosting release ID and timestamp from the console;
- the deployed Functions set/revisions and Firestore rules release;
- the operator and start time. Append each stage's audit output and both fresh
  migration snapshot filenames, timestamps, and checksums when they are
  created.

The timer migration and Hosting deployment are release gates, not a single
all-at-once deploy. Use this rollback matrix:

1. **Merge only:** revert the merge commit. No Firebase state changed.
2. **New rules only:** deploy `firestore:rules` from the pre-release tag.
   Do not deploy `--only firestore`: retain the additive indexes and TTL
   policies in the current `firestore.indexes.json`.
3. **After new Functions are deployed:** fix forward with the current schema.
   Rollback is unsupported once those Functions can process traffic. The new
   queue worker can retain an `outcome-unknown` row after an ambiguous remote
   Toggl create, and the pre-release stack cannot safely interpret or reconcile
   it. A newly created user can also enter a transitional timer lifecycle before
   the bulk migration. Waiting for invocations to drain does not resolve either
   case.
4. **After timer migration, before new Hosting:** fix forward with the current
   schema. Rollback is unsupported with the repository's current artifacts:
   there is no enforced gate that can freeze callable timer activity, drain
   Eventarc while retaining its queue worker, or inventory and reconcile the
   Firestore queue against remote Toggl state. A rollback would first require
   those tested controls plus a purpose-built repair migration; a clean audit
   alone can race with a new client call or invocation.
5. **After new Hosting has ever been exposed:** do **not** roll back Hosting,
   Functions, or rules to the pre-release contract. An already-running or
   offline cached new bundle can outlive a Hosting rollback, while old and new
   clients require incompatible atomic Firestore writes. Keep the current
   schema contract and fix forward. A current-schema maintenance UI can reduce
   new sessions while investigating, but is not a write freeze because cached
   clients outlive it. This remains true after the progress backfill.

Never roll back Functions alone after timer migration: old queue handling can
complete a remote Toggl stop without clearing the correlated Firestore claim.
Never roll back Hosting alone after the progress backfill: old reading batches
omit `currentPageUpdateId` and are rejected atomically by the new rules.

PITR and managed backups are the coherent full-database recovery sources. A
local snapshot is only a targeted recovery aid unless an enforced write freeze
exists: `db-snapshot.ts` reads documents concurrently without a shared read
time. These mechanisms are disaster recovery rather than an application
rollback, and none can undo a remote Toggl API call. Do not use `db-restore.ts`
for an ordinary release rollback: its live copy-back is non-atomic,
intentionally skips Toggl queue rows, and does not delete documents created
after the snapshot.

The repository does not currently provide enforced write quiescence or
side-effect-trigger suspension, so full-database copy-back is not a ready-to-run
release procedure. If actual data loss requires it, first build and test an
incident-specific gate for clients, callables, and triggers; then inventory the
live and recovery databases explicitly, reconcile Toggl separately, and
approve the exact copy-back/deletion plan before applying it.

### 4. Production run

```sh
node db-snapshot.ts --prod                      # snapshot IMMEDIATELY before writing
node migrate-<name>.ts --prod                   # dry-run: review every line
node migrate-<name>.ts --prod --apply           # typed confirmation
node db-audit.ts --prod > audit-post.txt
diff audit-pre.txt audit-post.txt               # exactly the intended changes
node migrate-<name>.ts --prod --apply           # MUST print 0 writes
```

### 5. A few days later

```sh
node db-audit.ts --prod | diff audit-post.txt -
node migrate-<name>.ts --prod                   # dry-run; re-apply if stragglers
```

Stale clients: this is an offline-first PWA with fire-and-forget writes. A
phone that was offline during the migration flushes old-shape writes when it
reconnects, and a cached old app version keeps writing the old shape until
its next navigation. That is why migrations are idempotent and cheap to
re-run, and why the follow-up audit exists.

## Script conventions

- **Traversal**: most book migrations iterate existing user documents with
  `.get()` — orphaned book docs under deleted parents are report-only, not data
  to migrate. Timer claims and reading-progress ownership are exceptions:
  `migrate-timer-claims.ts`, `migrate-reading-progress-sources.ts`, and the
  audit use `listDocuments()` because a missing user parent may still have live
  book/timer subcollections whose state must remain internally consistent.
  `db-snapshot.ts` also deliberately uses
  `listCollections()`/`listDocuments()` because a backup must capture every
  orphan; don't "fix" it.
- **Batching**: always through `batcher()` — 500-op rollover, dry-run
  counting, and it **crashes if an `update()` payload touches `updatedAt`**
  (on books it drives the reading-list order; no migration may touch it).
  `batcher.set()` allows `updatedAt` — it is for documents the script owns
  outright (restores, new-entity upserts). The timer-claim and reading-progress
  migrations are documented exceptions. Timer claims must commit each legacy
  book patch and lifecycle claim atomically. Reading-progress migration must
  re-read each book and its updates in one transaction so the logged and stored
  source reflects concurrent progress rather than a stale dry-run candidate.
- **Snapshot codec**: Timestamp/ref/GeoPoint/bytes round-trip via `__type`
  markers; the encoder crashes on unknown types and on documents using the
  reserved `__type` key. Crash-don't-corrupt.
- **No defensive programming**: unexpected shapes crash the script mid-run;
  batched writes make partial progress harmless and the guards make re-runs
  free. Fix the surprise, re-run.
- Migration scripts are committed and kept — they are the schema history.
  They may crash on import once `src/lib/utils/` moves past the vocabulary
  they were written against; that is correct — re-running them against a
  newer schema would be wrong, and loud beats silent.
- **Audit-changing migrations**: when a migration ships together with new
  `db-audit.ts` invariants, the baseline audit runs the NEW audit — the
  pre file then shows exactly the defect classes the migration will clear,
  and the pre/post diff is the intended-change signature.
- **Author ids are opaque after creation** (as of `migrate-author-ids.ts`):
  deterministic `authorIdFor(name)` at mint time only; rename edits
  `name`/`nameLower` in place. No script or audit may assert
  `id === authorIdFor(name)` on an author doc. One sanctioned exception:
  legacy `authors` arrays on book docs, which only pre-rename old clients
  produce, may be asserted during that migration's re-runs.
- **Legacy author fields mean an old client wrote last**: the current
  client deletes `author`/`authors` on every book write, so their presence
  is proof of a stale writer and re-runs rebuild `authorIds` from them.

## Backups and disaster recovery

Standing posture (all verified on, see console / `gcloud`):
PITR with a 7-day window, daily scheduled backups with 14-week retention,
and delete protection on `(default)`. `gcloud` on this machine must be run
with `--account=lars.ankile@gmail.com` per command.

**PITR and backups restore into a NEW named database — never in-place, and
never repoint the app.** The app, its rules, and the gen1 trigger binding
all belong to `(default)`. Recovery is always copy-back. The commands below
select and stage a coherent source; they are not authorization to apply it
without the write-quiescence, inventory, trigger, deletion, and Toggl plan
required above:

```sh
gcloud firestore databases restore \
  --source-backup=<backup> --destination-database=recovered \
  --account=lars.ankile@gmail.com
node db-snapshot.ts --prod --database=recovered   # dump the restored db
node db-restore.ts snapshots/<file>.json --prod --apply   # copy back into (default)
gcloud firestore databases delete --database=recovered ...
```

Notes on `db-restore.ts --prod` (disaster recovery only):

- `node db-restore.ts snapshots/<file>.json --prod` is a **dry run**. It
  checks the local snapshot and service-account project identity, plans the
  restore without a Firestore RPC, and prints `NOTHING WRITTEN` at startup and
  completion. Only `--prod --apply`, followed by typing `book-tracker-d8f24`,
  enables the copy-back writes.

- Full-overwrite `set()`: restores every doc in the dump as-is.
- **Never deletes** — documents *created* after the snapshot (e.g. by a bad
  migration) survive a restore and need explicit inventory and cleanup. The
  audit checks schema invariants, not a complete path inventory.
- Skips `users/*/togglQueue/*` — a restored `pending` queue item would
  replay a real Toggl API call.
- Triggers fire during restore; the hardened trigger set is idempotent.

Lighter PITR path (no scratch database): the Admin SDK can read the live
database as of any point in the PITR window via read-time reads — good
enough to recover individual fields without a full restore.

Posture change with `migrate-author-ids.ts`: the legacy `author` string on
book docs used to double as an informal recovery affordance; it is gone from
docs once that migration applies. Recover lost fields from the
immediately-prior snapshot or PITR under the write-quiesced disaster-recovery
procedure above. Do not treat a Hosting rollback as data recovery.

## Triggers and book content

No Firestore trigger touches book *content*: the client computes every
book invariant (finished, aggregates) in the same `writeBatch` as the
mutation, and `migrate-normalize-books.ts` re-runs repair anything a stale
client leaves behind. The transitional `bookIsFinished` backstop was
deleted 2026-08-11. Standing constraint for any future trigger: eur3
rejects newly *created* gen1 Firestore triggers, so it must be gen2
(lowercase name, `database: "(default)"` — see triggers.test.cjs).

## Migration history

| Date | Script | What it did |
|---|---|---|
| 2025-06 | `migrate-add-owner.ts` | backfilled `owner` refs on books/updates |
| 2026-08-11 | `migrate-normalize-books.ts` | backfilled `isbn: ''` on 6 legacy books; carries the full normalize policy table for re-runs |
| 2026-08-11 | `migrate-authors.ts` | authors as first-class entities: split 220 books' author strings into `users/{uid}/authors` docs + `authors` arrays (459 ops); audit went to 0 findings |
| 2026-08-11 | `migrate-placeholder-authors.ts` | placeholder attributions ("Various Authors") are display text, not entities: stripped 1 book's array, deleted 1 author doc |
| 2026-08-11 | `migrate-author-ids.ts` | books reference authors by id only: rebuilt authorIds on 220 books, deleted legacy author/authors fields, backfilled explicit kind on 185 author docs (Harvard Business Review pinned entity), re-minted "Various Authors" as a kind-placeholder doc (406 ops); author ids opaque from here on; audit 625 findings -> 0 |
| 2026-08-11 | `migrate-person-names.ts` | explicit person name parts: backfilled givenName/familyName on 184 person docs via the last-token split (a prefill — wrong splits are corrected in the /authors edit form); sortName concept removed; audit 184 findings -> 0 |
| 2026-08-12 | `migrate-enrich-given-names.ts` | hand-curated given names for 20 surname-only authors on the owner account (looked up from their books' covers), and "Stortinget" fixed to kind entity; content enrichment, not schema |
| 2026-08-24 | `migrate-enrich-books.ts` | ISBN-derived metadata: backfilled coverUrl/publisher/publishedDate/subjects/fiction on all 220 books from Open Library (139 enriched, 120 with covers; 81 defaults-only — 52 no ISBN, 19 unknown to OL, 10 invalid, all REPORTed); normalizes stored ISBNs to ISBN-13; audit 1100 findings -> 0. Lookups cached in `ol-cache.json` (gitignored), so the prod apply ran with 0 live fetches. OL soft-blocks bursty IPs — the script trickles at 1 req/30s with escalating backoff |
| 2026-08-24 | `migrate-enrich-google.ts` | Google Books gap-fill over pass 1: improved 88 books (fiction unknown 159 -> 102, covers 120 -> 141, subjects 123 -> 138); gap-fill only, an existing Open Library value always wins. Its BISAC categories are what classify fiction/non-fiction — the remaining 102 unknowns are 52 books with no ISBN plus 50 whose volumes carry no categories. Key comes from the FUNCTIONS_CONFIG_EXPORT secret via `GOOGLE_BOOKS_KEY`; lookups cached in `gb-cache.json` (gitignored) |
| 2026-08-24 | `migrate-enrich-nb.ts` | Nasjonalbiblioteket gap-fill (pass 3): improved 17 books, the Norwegian editions the first two passes had never heard of. MODS genres ("Romaner", "Skuespill", the explicit "notfiction" marker) are the fiction signal; cover scans are verified with a HEAD request before storing, since in-copyright ones 403. Free, no key; lookups cached in `nb-cache.json` (gitignored) |
| 2026-08-26 | `migrate-reading-progress-sources.ts` | progress-ownership backfill, run same-day as the timer rollout: the default 7-day overlap window was dropped by owner decision 2026-08-26 (single-user app; operator reloads own clients; residual risk = one rejected reading batch from any un-reloaded old tab, heals on reload). Dry-run 219 books, snapshot `snapshots/2026-08-26T21-17-26.862Z-prod.json` (3883 docs), apply 219, second apply 0. Audit: 10 `book.progress-source-null-baseline`, each investigated and accepted as legacy — all 10 have zero `updates` docs (pages set 2020–2026-04 before update history; several finished books plus test entries "sdgsd" and "The great legend" 4000/5000); all other `book.progress-source-*` findings 0 |
| 2026-08-26 | `migrate-timer-claims.ts` | timer-claim rollout completed the strict-TS release: release SHA `6fb5cf8` (merge of `9e9ec28` + auth-hotfix `582fb9a`, which the 08-25 Hosting deploy had silently reverted); rules were already live and hash-identical to source (`4ce640de…`, released 2026-08-26T00:30Z); deployed all Functions (claim-aware toggl, new `toggl-clearstopping`, admin/booksapi), then after a drain window: dry-run (17 users, all idle), snapshot `snapshots/2026-08-26T19-41-11.908Z-prod.json` (3866 docs), apply (17 migrated), second apply 0, audit `timer-lifecycle.*` findings 0; then `functions:publicweb,hosting` from the same validated build (live version `1787772834321` matches). Remaining audit findings: 219 `book.missing.currentPageUpdateId` — expected; **progress-source backfill due no earlier than 2026-09-02** (7-day overlap window started 2026-08-26). Operator: lars.ankile@gmail.com via Claude |
| 2026-08-26 | (no script — Auth config) | SEC-015a: enabled `emailPrivacyConfig.enableImprovedEmailPrivacy` and a `passwordPolicyConfig` (ENFORCE, `minPasswordLength` 12, `forceUpgradeOnSignin` false) via the Identity Toolkit admin API. Live probes after the change: unknown-email and wrong-password sign-ins both return `INVALID_LOGIN_CREDENTIALS`; password reset for an unknown address returns 200; a 5-character sign-up is refused with `PASSWORD_DOES_NOT_MEET_REQUIREMENTS`; sign-up for an existing address still returns `EMAIL_EXISTS` (Firebase limitation, not covered by enumeration protection). Register form gained a 12-character hint + `minlength`. Operator: lars.ankile@gmail.com via Claude |
| 2026-08-26 | (no script — profiles read path) | SEC-019/020: public profile documents are no longer client-readable. `publicweb` gained `/profiles/<username>.json` (same visibility and cache headers as the HTML page, no `uid` on the wire, ~93 KB vs the 676 KB raw document) and a per-instance 60 s read cache (`cachedRepository`) so Firestore reads are bounded even when the CDN is bypassed; the SPA route reads the JSON for public profiles and Firestore only for the viewer's own profile; `firestore.rules` `profiles/{username}` get is now owner-only. Deploy order was load-bearing: `functions:publicweb,hosting` first (new client + endpoint live, verified `x-cache: HIT` and no `uid`), then `firestore:rules` (anonymous REST read → 403). Also same day: deleted the stale `pre-strict-typescript-20260825` Hosting preview channel and trimmed Auth `authorizedDomains` to the four real hosts (SEC-021); removed the unused 2020 `FIREBASE_TOKEN` GitHub Actions secret and enabled secret scanning + push protection on the repo (SEC-023). Operator: lars.ankile@gmail.com via Claude |
| 2026-08-27 | (no script — publicweb load test) | SEC-020 third pass: a live flood (800 unique names at concurrency 10 against the origin host) confirmed the miss budget (302 × 404, then 503s within 8 s, reset after the window) but showed the retained 404s evicting the real profile from the 100-entry memo, so a public profile 503'd for the rest of the window. `createTtlCache` now retains only 200s (pending, rejected, and 404 loads never take a slot) and serves a retained profile ≤ 300 s old stale while the budget is exhausted. Retest on the new revision: profile served fresh, then stale, across two floods; unknown names 503. Real public→private flip of `profiles/lars` (restored after): origin 404 at +63 s, CDN at +288 s. Operator: lars.ankile@gmail.com via Claude |
| 2026-08-27 | (no script — Google Account) | SEC-023 closed: owner removed the Firebase CLI third-party grant from the Google Account, revoking the 2020 `login:ci` refresh token (its GitHub secret was deleted 2026-08-26). Side effect: the cached CLI login on the workstation is invalid; run `firebase login` before the next functions/hosting deploy. Operator: lars.ankile@gmail.com |
| 2026-08-27 | (no script — IAM) | SEC-022: functions no longer run as the project-Editor default service accounts. Created `publicweb-runtime@` (roles/datastore.viewer) and `functions-runtime@` (roles/datastore.user, roles/firebaseauth.viewer for the admin user listing, roles/eventarc.eventReceiver, roles/run.invoker on the `deletebookupdates` and `toggl-syncqueue` services only, roles/secretmanager.secretAccessor on `FUNCTIONS_CONFIG_EXPORT`); every function names its identity in source (`functions/src/runtime.ts`, pinned by `triggers.test.cjs`); the two Eventarc-driven gen2 services are `ALLOW_INTERNAL_ONLY`. Deployed all functions, verified publicweb/admin/booksapi/triggers live, then removed roles/editor from `440931185227-compute@developer` and `book-tracker-d8f24@appspot` and the appspot accessor binding on the secret (project-level IAM policy backup only: gitignored `iam-policy-backup-2026-08-27.json` — the removed secret-level and Cloud Run service-level bindings are recorded in this row, not in the file; the deployer needs `iam.serviceAccountUser` on the two runtime SAs — project Owner has it).  Review follow-up the same day: `deletebookupdates` redeployed with `retry: true`; removed the compute default SA's leftover project-level `roles/run.invoker` + `roles/eventarc.eventReceiver` (it now holds no project roles); `firebase-adminsdk-6akbb@`'s project-level `roles/iam.serviceAccountTokenCreator` replaced by the same role on itself only, so the on-disk Admin SDK key can no longer impersonate the runtime accounts. Operator: lars.ankile@gmail.com via Claude |
| 2026-08-27 | (no script — Hosting re-pin) | SEC-022 follow-up, found by the post-close red-team: `firebase.json` rewrites `/profiles/**` and `/sitemap.xml` with `pinTag`, so `book.ankile.com` was still served by `publicweb-00017-jaj` (pinned at the 06:18Z Hosting deploy, running as the compute default SA) after the SEC-022 functions deploys created 00021/00022 on `publicweb-runtime@`. When `roles/editor` was removed at 18:40:12Z that pinned revision lost Firestore access: last 200 through it 18:22:54Z, first 500 19:22:44Z (Googlebot, `/sitemap.xml`), 86 × 500 in total, all on retired revisions, until `npm run build && firebase deploy --only hosting` (which also tags a new revision, 00023, on `publicweb-runtime@`) at 22:26Z restored 200/404 on `book.ankile.com`. The SEC-022 verification had been run against the `*.run.app` origin, which always serves the latest revision — the path real users take was never checked. Cleanup: the nine stale `fh-*` tags removed from the service traffic block and the eleven retired compute-SA revisions (00001–00020) deleted, so only revisions 00021–00023 on `publicweb-runtime@` exist. README now states the re-pin rule and the through-Hosting smoke check. Bundle content was unchanged (no client commits since the 06:18Z deploy). |
| 2026-08-27 | (no script — rebuild + redeploy) | Post-close red-team follow-ups (three fresh Opus agents; findings in the security tracker under SEC-019/021/022/023 and new SEC-032/033/034). The emergency Hosting re-pin had shipped a build from regenerated tracked artifacts without a commit: rebuilt at `e9f38a9`, committed `59bc77d`, then `firebase deploy --only functions:publicweb,hosting,firestore:rules` at 22:30Z — live `version.json` and entry-chunk hashes equal the commit, and the deployed ruleset (`cf98526b…`, content SHA `bd522bd7…`) now equals `firestore.rules` (it had been one comment-only commit behind — `12b6181`, 06:19Z — since the 06:02Z rules release). Superseded `fh-*` tag removed again; only `publicweb` revisions 00021–00023 and 00026, all on `publicweb-runtime@`, exist. Emulator red-team confirmed the owner-only `profiles`/`profileDiscovery` rules (18/18) and no XSS in the profile renderer. Owner action left: enable GitHub non-provider secret patterns + validity checks (API PATCH is a no-op). |
| 2026-08-27 | (no script — publicweb bounds) | Red-team round 2 (three more fresh Opus agents, after the round-1 fixes). Live state verified clean: prod byte-exact with the repo, IAM unchanged by the deploys (no `SetIamPolicy` after 18:50Z), CDN path correct under a real flood (503 never cached, warm profile never evicted). Code fixes deployed with `firebase deploy --only functions:publicweb,hosting` at 23:5xZ (revision `publicweb-00029-pok`, `publicweb-runtime@`; superseded tag removed): sitemap scan capped at 5000 markers with 25-way batched profile reads instead of an unbounded `Promise.all` (a few hundred stranger-created ceiling-sized profiles would have OOMed the 256 MiB instance on one `/sitemap.xml` fetch); a public profile that fails decode is now a memoised 404 on both routes instead of an unmemoised 500 (one repeated URL could drain the whole miss budget); retained-pool memory comment restated from the rules ceiling; identity test asserts the only raw-HTTP surface is `publicweb` on the read-only tier; README: never roll Hosting back through the console (old releases point at deleted tags). New tracker entries SEC-035 (client-chosen `updatedAt` → sitemap `lastmod`) and SEC-036 (orphaned discovery marker); SEC-020 (4) retained-pool eviction by attacker-owned profiles recorded, root fix = SEC-032 per-uid cap. Verified through book.ankile.com: 200/200/200/404, version + chunk parity with the commit. |
| 2026-08-24 | `migrate-enrich-goodreads.ts` | Goodreads gap-fill (pass 4, last resort): improved 36 books — covers for the Norwegian classics plus fiction/non-fiction for English non-fiction. Reads schema.org JSON-LD from `/book/isbn/<isbn>` (robots-permitted; `/search` is not). NOT wired into the app — no CORS, and the ToS disallow automated access — so it stays a hand-run backfill over the owner's own library, paced at 5s and cached in `gr-cache.json`. **Run it after pass 3**, or it fills fields Nasjonalbiblioteket should own. Combined result of passes 3+4: fiction unknown 102 -> 64, covers 141 -> 157, "nothing found" 14 -> 0; the remaining 64 unknowns are 52 books with no ISBN and 10 with an invalid one (see /isbns) |
