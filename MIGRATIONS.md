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
| `migrate-purge-deleted-accounts.ts` | physical purge of ONE tombstoned account (SEC-006); the only removal path, never scheduled | yes |

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

1. **Functions** (`npm exec --yes --package firebase-tools@15.24.0 -- firebase deploy --only functions:<name>`) — trigger
   behavior must be correct before bulk writes land.
2. **Firestore rules/indexes and Storage rules** (`npm exec --yes --package firebase-tools@15.24.0 -- firebase deploy --only
   firestore,storage`). `storage.rules` is deny-all (the app does not use
   Cloud Storage; added 2026-08-26 for SEC-017) and should stay that way
   unless a feature starts using the bucket. The Firebase Auth project
   config is not deployable from this repo: email enumeration protection
   and the password policy (minimum 12 characters, no character-class
   rules, existing passwords not force-upgraded) were set 2026-08-26 for
   SEC-015 through the Identity Toolkit admin API
   (`PATCH admin/v2/projects/book-tracker-d8f24/config`) and must be
   re-applied by hand if the project is ever recreated.
3. **Hosting + profile renderer** (`npm run build`, commit the artifacts, `firebase deploy --only functions:publicweb,hosting` — never Hosting alone).

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
- **Account deletion is a soft delete** (SEC-006, 2026-08-29): the Auth
  trigger stamps `deletedAt` on `users/{uid}` and the account's profiles
  and removes nothing. Migrations and the audit must treat a tombstoned
  account as data to keep: never "repair" a tombstone away, never skip a
  tombstoned tree in a snapshot. Removal is `migrate-purge-deleted-accounts.ts`,
  one uid per run, after a snapshot, by an explicit operator decision.
- **Rules-shape mirror**: `rules-shape.ts` re-states the allowlists and
  byte caps of `firestore.rules` (books, authors, profiles, ownership
  records) so `db-audit.ts` can flag a stored document the rules would
  reject on its next client edit. It is agreement-tested against the
  emulator in `tests/firestore-rules.test.ts`; a cap moved in the rules
  must move there too, and the test fails until it does.
- **Legacy author fields mean an old client wrote last**: the current
  client deletes `author`/`authors` on every book write, so their presence
  is proof of a stale writer and re-runs rebuild `authorIds` from them.

## Backups and disaster recovery

Standing posture (all verified on, see console / `gcloud`):
PITR with a 7-day window, daily scheduled backups with 14-week retention,
and delete protection on `(default)`. `gcloud` on this machine must be run
with `--project book-tracker-d8f24 --account=lars.ankile@gmail.com` per
command: the workstation's default project is a different one, and a
restore without `--project` would create the recovered database there.

**PITR and backups restore into a NEW named database — never in-place, and
never repoint the app.** The app, its rules, and the gen1 trigger binding
all belong to `(default)`. Recovery is always copy-back. The commands below
select and stage a coherent source; they are not authorization to apply it
without the write-quiescence, inventory, trigger, deletion, and Toggl plan
required above:

```sh
gcloud firestore databases restore \
  --source-backup=<backup> --destination-database=recovered \
  --project book-tracker-d8f24 --account=lars.ankile@gmail.com
node db-snapshot.ts --prod --database=recovered   # dump the restored db
node db-restore.ts snapshots/<file>.json --prod --apply   # copy back into (default)
gcloud firestore databases delete --database=recovered --project book-tracker-d8f24 --account=lars.ankile@gmail.com
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
| 2026-08-24 | `migrate-enrich-goodreads.ts` | Goodreads gap-fill (pass 4, last resort): improved 36 books — covers for the Norwegian classics plus fiction/non-fiction for English non-fiction. Reads schema.org JSON-LD from `/book/isbn/<isbn>` (robots-permitted; `/search` is not). NOT wired into the app — no CORS, and the ToS disallow automated access — so it stays a hand-run backfill over the owner's own library, paced at 5s and cached in `gr-cache.json`. **Run it after pass 3**, or it fills fields Nasjonalbiblioteket should own. Combined result of passes 3+4: fiction unknown 102 -> 64, covers 141 -> 157, "nothing found" 14 -> 0; the remaining 64 unknowns are 52 books with no ISBN and 10 with an invalid one (see /isbns) |
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
| 2026-08-28 | (no script — round 3) | Red-team round 3 (refute-the-fixes, signed-in-stranger, completeness critic). Code `938a8b4`, deployed `functions:publicweb,functions:deleteUserDocument,functions:admin,hosting` at 01:13Z (revision `publicweb-00032-waw`, superseded tag removed) and verified through book.ankile.com: sitemap memo pinned in its own slot (5 min), scan `orderBy(createdAt).limit(1000)` (round 4 showed this made displacement *cheaper* — 1000 backdated markers — until `createdAt` was server-pinned on 2026-08-28), `concurrency: 16`, marker decode guarded, skips logged once per scan, `admin-overview` denials one counter doc per caller, `deleteUserDocument` deletes a marker only if its uid still matches, `firebase.json` functions ignore list, README (`login --reauth`, no console rollbacks on any gen-2 service, preview channels retired, detection). Infra: monitoring created (owner email channel, uptime checks `/profiles/lars` + `/sitemap.xml` through the CDN with content matchers, alert policies for both, `publicweb` 5xx, `PERMISSION_DENIED`, sitemap truncated/skip); eight retired compute-SA revisions deleted on `deletebookupdates`/`toggl-syncqueue`; `FUNCTIONS_CONFIG_EXPORT` v1 disabled (differed from v2; reversible); default bucket public-access prevention enforced; GitHub workflow token defaults read-only. New tracker entries SEC-037 – SEC-047; SEC-002 corrected (atomic-stop branch bypasses the queue quota entirely). |
| 2026-08-28 | (no script — round 4) | Red-team round 4 (refute round 3, toolchain/deploy pipeline, data model). Code `076868f`, deployed at 01:42Z with the pinned CLI (`npm exec --package firebase-tools@15.24.0 -- firebase deploy --only functions,hosting,firestore:rules --force`; `--force` was needed once because `deleteUserDocument` first gained a failure policy; it is not needed for routine deploys, it also auto-confirms function deletion and unsafe migrations, and it silently created a 1-day `firebase-functions-cleanup` image policy on `gcf-artifacts`), all eleven functions refreshed, revision `publicweb-00035-ses`, superseded tag removed, verified through book.ankile.com (200/200/200/404, sitemap lists `lars`, build parity, deployed rules hash == source). Changes: `profileDiscovery.createdAt == request.time` in rules with the client writing `serverTimestamp()` (listener uses `serverTimestamps: 'estimate'`) — the round-3 oldest-first sitemap scan is now safe against backdating; `deleteUserDocument` pages profiles (100/batch, one `getAll` per page) and retries (`failurePolicy: true`) — the previous single batch could not delete an account with ≥ ~250 profiles; `deletebookupdates` `maxInstances: 5` in source; `admin-overview` denials logged, not written; sitemap memo 1 h with a 20 s scan budget; hosting `predeploy` = `npm run test:artifacts` (deploy order is now build → commit → deploy), functions predeploy `npm ci`, functions ignore `**/.*`; runbook test asserts the CLI pin; artifacts test compares the committed profile shell. Infra: sitemap uptime check 15 min matching the `lars` `<loc>`; uptime alerts fire on one failing 10-min point; `PERMISSION_DENIED` policy covers gen1; 5xx policy excludes the designed 503 (separate daily-limited 503 policy); gen1 error policy; Eventarc undelivered-messages policy; PAP enforced on the four `gcf-*` source buckets; `serviceAccountKey.json` `chmod 600`. Tracker: SEC-048 – SEC-052; SEC-011/024/002 corrected. |
| 2026-08-28 | (no script — round 5) | Red-team round 5 (refute round 4, browser-side trust, runbook drift). Code `c60b614`: a stranger's malformed public profile no longer makes the viewer's browser write `firestore.decode_failed` under its own uid (`fetchPublicProfile` decodes foreign data outside the own-data wrapper; the server decoder now rejects a fractional `year` like the client); `X-Robots-Tag: noindex` on the JSON twin; functions upload ignore lists dotfiles explicitly so `functions/.npmrc` (`omit=optional`, `engine-strict`) reaches the cloud build again. Docs: every `gcloud` command carries `--project book-tracker-d8f24` (the workstation defaults to another project — the DR restore run verbatim would have created the recovered database there), a docs test enforces it; deploy sections say build → commit → deploy; preview channels removed from the runbook (`hosting:channel:deploy` adds the host to `authorizedDomains` and deploys production `publicweb`); `--force` no longer described as required; deployer-identity paragraph corrected (actAs on the App Engine default is also checked; the adminsdk key cannot deploy). Revisions: superseded untagged `publicweb`/`deletebookupdates` revisions deleted. Tracker: SEC-053 – SEC-060. |
| 2026-08-28 | (no script — round 6) | Red-team round 6 (refute round 5, Auth/session lifecycle, abuse economics). Code `cf1e1cd`, deployed 02:39–02:41Z with the pinned CLI (all functions + Hosting; superseded tag and revisions retired). One round-5 regression reverted and one older defect fixed: `functions/.npmrc` is excluded from uploads (its `omit=optional`, committed 2026-07-20, had replaced the buildpack's `omit=dev` and shipped eslint/typescript in the production image for five weeks — round 4's `**/.*` had excluded it by accident, round 5 re-included it; 297 packages audited vs 262), and a partial sitemap is now a degraded pinned value (held 5 min, never displaces a fresh complete one) instead of a 60 s transient that rescanned every minute. Auth: `client.permissions.disabledUserDeletion=true` set in Identity Toolkit (self-service `accounts:delete` closed; reversible), `savetoken` fails `failed-precondition` instead of merge-creating `users/{uid}` (a deleted account's ID token stays valid ≤ 1 h), sign-in form `autocomplete`, README "Abusive or compromised accounts" (disable → revoke → wait ≥ 1 h → delete). Docs test now also asserts `--account=` on every gcloud command. Tracker: SEC-061 – SEC-066; SEC-059 note corrected. |
| 2026-08-28 | (no script — round 6, economics) | The abuse-economics review priced every stranger-triggerable action with live Billing Catalog SKUs: worst case from one attacker ≈ $3,970/24 h (Hosting egress of the 93 KB profile JSON — uncapped, unmetered by any publicweb control; Firestore write floods through the rules; anonymous calls to the six `allUsers`-invokable gen-1 callables, billed before rejection; log ingest), 742× the 50 NOK budget, with the budget email arriving hours late. Same night, `72cb1e4`: `maxInstances` in source on every gen-1 function (callables 10, `admin-overview` 2, Auth triggers 10; asserted per export), six `spend:` threshold alerts (Hosting egress, Firestore reads/writes/storage, gen-1 executions, Logging ingest) on the owner channel, README "Abusive traffic and runaway spend" kill-switch runbook (hosting:disable → deny-all rules → drop `allUsers`; never unlink billing), corrected read/cost arithmetic in `publicWeb.ts`. Tracker: SEC-067 – SEC-074 (2 High); SEC-020/039/051/061 numbers corrected. |
| 2026-08-28 | (no script — round 7) | Red-team round 7 (refute round 6 + recost, attack-the-defences, privacy). Code `8d4a4bc`: `npm test` had been red on master since `51f5f8e` (the new gcloud docs test matched prose in a MIGRATIONS row) — filter narrowed to real command groups; `createUserDocument` gains `failurePolicy: true` (round 6 removed `savetoken`'s merge-create, so a dropped sign-up event would have blocked Toggl for that account forever); `functions/.npmrc` drops `omit=optional` so local and cloud trees match; `toggl-cleartoken` callable + Disconnect button (a user could not withdraw a stored Toggl credential — SEC-075); `referrerpolicy="no-referrer"` on cover images + `Referrer-Policy: no-referrer` Hosting header (private libraries were sending referrer + IP to Google/Amazon/Open Library/NB — SEC-076); visibility copy corrected; `auth/admin-restricted-operation` mapped; committed `firestore.rules.lockdown` + pinned kill-switch commands + bulk-delete warning in the README; cost comments corrected. Deploy needs `--force` once (new failure policy). Monitoring: egress threshold 200 MiB/10 min, reads 20k/10 min, backup-storage > 5 GB, deletes > 2000/10 min, gen-1 non-ok executions > 50/10 min (the log-match gen-1 policy matches nothing real); 18 policies. Workstation snapshots `chmod 600`. Tracker: SEC-075 – SEC-084. |
| 2026-08-28 | (no script — round 8) | Red-team round 8 (legitimate-user impact; the refute and data-integrity agents stalled and rerun as round 9). Code `e3abcf8`, deployed ~05:5xZ with the pinned CLI (all functions + Hosting; superseded tags/revisions retired): publicweb responses gzip-negotiated from the memo (live 11,073 B vs 92,990 B for `lars.json`, `Vary: Accept-Encoding`), `toggl-cleartoken` refuses while a timer is running, private-profile copy + delete confirmation state the ~10 min / ~1 h propagation, sign-up-race and password-policy messages reworded, `firestore.rules` comment fixed, `authFailure` map tidied. Rules test 51 is load-sensitive (fails alongside other suites, passes alone). Tracker: SEC-086 – SEC-089. |
| 2026-08-28 | (no script — step-back) | Red-team series stopped after round 8 by owner decision (scope had grown past the original SEC-019/020 item; queue stalled at step 6). SEC-019/020 re-verified end-to-end at `b3c1d5d`: rules owner-only, unauthenticated REST 403, `lars.json` gzip/noindex/no-`uid`, Hosting release `dfab432d872aae71` → `publicweb@fh-dfab432d872aae71` = sole revision `00051-siq`, full `npm test` green (261/2/56/8/88). One drift found: live ruleset was one comment-only line behind source (round 8 deployed functions + Hosting only) — `firestore:rules` redeployed 16:37Z, ruleset `77681f28…`, content SHA == source. Every open item parked under "Parked work" in the tracker; work resumes one item at a time. |
| 2026-08-28 | (no script — scoped audit) | Scoped red-team of SEC-019/020 only (three Opus agents: rules, publicweb/CDN, client/bundle; reports in gitignored `audit-sec019-redteam-2026-08-28-*.txt`): HOLDS on all three faces, nothing deployed or changed. New tracker entries SEC-090 (rejected/timed-out sitemap scan never memoised → full scan per miss under a persistent fault, Medium), SEC-091 (`gzip;q=0` served gzip, Low), SEC-092 (client read-path fall-through / username check / `credentials: 'omit'`, Low). Record corrections: owner uid already public via the `/admin` allow-list in the bundle; username existence leaks on the create path (not reads); rules no-oracle proof is emulator evidence. Currency pass: SEC-016 → Addressed, SEC-024 → In progress. Parked list re-ranked; next suggested piece is the SEC-090–092 follow-up, then SEC-001. |
| 2026-08-28 | (no script — SEC-090–092) | SEC-019/020 follow-up, code `320ccae`, deployed 17:37Z with the pinned CLI (`functions:publicweb,hosting,firestore:rules`; Hosting release `5c10313b2bd11019` → `publicweb-00054-hom`, old tag + revision retired; ruleset `73ac5e0b…` == source): a failed, hung (25 s deadline) or empty sitemap scan resolves as a memoised 503 (one scan per 5 min per instance under a fault, not one per request); `acceptsGzip()` honours q-values (origin correct; the Hosting edge still normalises `gzip;q=0` to gzip — outside the repo); client falls through to the projection when the own read fails, rejects a projection for another username, fetches with `credentials: 'omit'`, and skips the own read for usernames the own-profile listener has shown are not the viewer's. Tests: unit 265, artifacts 2, rules 56 (alone), pwa 8, functions 92. |
| 2026-08-28 | (no script — SEC-090–092 follow-up) | Scoped red-team of `320ccae` (three agents) held but found an owner-facing regression in the own-username skip (cache-only snapshots, `docs[0]`), a hard sitemap deadline discarding read batches, render outside the catch, timer not unref'd, order-dependent duplicate `gzip` members. Follow-up `e0721f1` deployed 19:24Z (`functions:publicweb,hosting`; Hosting release `b6db1ceb3ebe0be0` → `publicweb-00057-nex`, old tag + revision retired; version `1787944964058`; master pushed — origin ≡ prod again). Two verifying agents with mutation testing: every finding CLOSED, no regression, 6,174-header old-vs-new comparison never more permissive. Residuals SEC-093, out-of-scope SEC-094. Process lesson: `npm run test:artifacts` rebuilds `public/` in place pinned to the tracked version — run build → commit → test:artifacts, never build → test:artifacts → commit (it silently reverts the version string). Tests: functions 94, unit 266, rules 56 (alone), pwa 8, artifacts 4. |
| 2026-08-28 | (no script — SEC-001) | Queue step 6, code `fd4f0fd`, deployed 21:52Z with the pinned CLI (`functions:telemetry,functions:booksapi,firestore:rules,hosting`; Hosting release `0ea8615c68b95b2c` → `publicweb-00060-duj`, old tag `fh-b6db1ceb3ebe0be0` and revision `00057-nex` retired; ruleset `16b9fb4d…` == source; version `1787953831672`). `logEvents` has no client rule any more; signed-in clients report through the new gen-1 callable `telemetry-reportissue` (event allowlist, bounded fields, uid pinned, 20 per user per hour in `users/{uid}/functionQuotas/issueReports`, `telemetry.quota_exceeded` WARN on refusal); anonymous sign-in failures are no longer recorded; the admin feed caps ten rows per account within each budget over a 500-row scan; `consumeQuota` shared with `booksapi-lookupisbn` (redeployed, behaviour unchanged). Verified: unauthenticated callable 401, unauthenticated `logEvents` REST create 403, smoke 200/200/200/404 through book.ankile.com. Closes SEC-001, SEC-029, SEC-038. No data touched. |
| 2026-08-28 | (no script — SEC-001 follow-up) | Scoped red-team of `fd4f0fd` (three Opus agents; reports in gitignored `audit-sec001-redteam-2026-08-28-*.txt`): the fix holds, but the SEC-038 feed cap acted only inside a shared newest-500 scan (one account owned it in ~25 h; useless at ≥10 accounts), the truncation banner printed the budget constant, and `telemetry.quota_exceeded` fired per rejected call. Follow-up `2fd3803`: composite index `logEvents(uid ASC, createdAt DESC)` deployed first (`firestore:indexes`, READY after ~4 min), then `functions:admin,telemetry,booksapi,hosting` at 22:42Z (Hosting release `af72d1b2b4201a1c` → `publicweb-00063-xax`; old tag `fh-0ea8615c68b95b2c` + revision `00060-duj` retired; version `1787956525831`; rules unchanged). Admin feed is one capped query per account plus one for uid-null rows with real cap counts on the wire (`issueCaps`); quota refusals logged once per user per window; client payload module + tests; rules tests widened. Verified read-only: the three query shapes are served by the new index; unauthenticated callable 401, `logEvents` create 403, smoke 200/200/200/404; `admin-overview` returns `not-found` to unauthenticated callers by design. No data touched. |
| 2026-08-28 | (no script — SEC-001 round 2) | Second scoped red-team of the SEC-001 work (three Opus agents on `2fd3803`; reports in gitignored `audit-sec001-r2-2026-08-28-*.txt`): every round-1 finding closed; new: the feed had no absolute size bound (response grows with accounts), the per-account query had no test, one failed read failed the page, the page dereferenced `issueCaps` unguarded, comments/copy inaccuracies. Follow-up `2e61a79` deployed 23:09Z (`functions:admin,telemetry,booksapi,hosting`; Hosting release `06548d0f980363ed` → `publicweb-00066-qox`; old tag `fh-af72d1b2b4201a1c` + revision `00063-xax` retired; version `1787958464786`; rules `16b9fb4d…` and indexes unchanged): `FEED_LIMIT` 200 with shown/total, `allSettled` + `unreadAccounts` (logged `admin.issues.read_failed`), `admin-overview.test.cjs`, guarded page copy, three new rules tests (59/59), strict client/server event-list test + `logIssue` call-site pin. Verified as before: unauthenticated callable 401, `admin-overview` not-found by design, `logEvents` create 403, smoke 200/200/200/404. No data touched. |
| 2026-08-28 | (no script — SEC-001 round 3) | Third scoped red-team (three Opus agents on `2e61a79`; reports in gitignored `audit-sec001-r3-2026-08-28-*.txt`): every round-2 finding closed; new: newest-first 200-row cut re-coupled accounts (20 at-the-cap accounts erased an honest one), empty feed after a total read failure rendered as all clear, empty-feed overview test, serverTimestamp-blind quota rules test, single-row fixture. Follow-up `00b63dc` deployed 23:55Z (`functions,hosting` — all 13 functions; Hosting release `3a1ba550a2f71e76` → `publicweb-00069-rub`; superseded `publicweb-00066-qox`, `deletebookupdates-00011-vis`, `toggl-syncqueue-00012-hix` and tag `fh-06548d0f980363ed` retired; version `1787961138139`; rules `16b9fb4d…` and indexes unchanged): round-robin feed cut, `anonymousUnread`, unreadable-vs-all-clear, `Incomplete feed` list, `decodeStoredIssue` bounds `event`, real-row overview tests, **new emulator end-to-end suite `tests/telemetry-emulator.test.ts`** (compiled callable + overview against Firestore/Auth emulators: quota, contention, refusals, expiry, 25-account flood, invisible-row trades), rules suite `clearFirestore` per test + five coverage tests, AST-based client pins, page-guard test. Verified read-only as before (401/404-by-design/401/403, smoke 200/200/200/404). No live data touched — every test runs against emulators or mocks. |
| 2026-08-29 | (no script — SEC-001 round 4, sitting closed) | Fourth scoped red-team (three Opus agents on `00b63dc`; reports in gitignored `audit-sec001-r4-2026-08-28-*.txt`): every round-3 finding closed; regression→test table shows all 30 failures from rounds 1–3 pinned except the feed's failure branch and two untested rules classes (`adminAudit`, claim-conditioned grants); zero flake over three runs; namespace isolation proven. Follow-up `de07dc5` + `b8a8e42` deployed 2026-08-29 01:02Z (`functions,hosting`; release `98480abd6e5f646a` → `publicweb-00072-nuw`; superseded `publicweb-00069-rub`, `deletebookupdates-00012-car`, `toggl-syncqueue-00013-kom` and tag `fh-3a1ba550a2f71e76` retired; version `1787965204129`; rules `16b9fb4d…`/indexes unchanged): dropped-account count on the wire, `readFailed`/`feedNotes` as a tested pure module, structural `logIssue` pins, failure-branch/rank-fair/cleanup emulator tests, `adminAudit` + claims rules tests. Verified read-only as before. SEC-001 sitting closed. Note: commit `00b63dc` (23:55Z) accidentally swept an unrelated in-progress `docs/architecture/` effort plus a README edit into the security follow-up via `git add -A`; left in place, further edits to it remain uncommitted, all later commits use explicit paths. No live data touched at any point — every test runs against emulators or mocks. |
| 2026-08-29 | (no script — SEC-002) | Queue step 12, code `c971a5d`, deployed 04:21–04:23Z with the pinned CLI (`firestore:rules,functions:toggl,hosting`): ruleset `1a28d718…` == source; `toggl-syncqueue-00015-zid`, `publicweb-00085-mop` sole revisions after GC (three stale `fh-*` tags and `publicweb-00078/81/83` + `toggl-syncqueue-00014` from the same night's ISBN deploys removed); Hosting version `1787976915170`. Rules: the ordinary `togglQueue` create is gone, only the atomic offline-stop row remains and it is gated by the new server-owned counter `users/{uid}/functionQuotas/togglQueueRows` (60/hour); retry markers refused before a server-pinned `deferredUntil`. Trigger: over-quota rows are stamped `deferredUntil` once per window and given a 90-day expiry instead of being thrown for Eventarc to redeliver; fresh rows counted once in the claim transaction. No data migration: existing pending rows without the stamp are simply fresh to the new trigger; no rows, users or documents were touched. Smoke 200/200/200/200/404, probes 401×4 / 403×2, no WARNING+ trigger logs after deploy. Tests: functions 120, unit 279, rules+emulator 2+79, PWA 8, artifacts 4. |
| 2026-08-29 | (no script — SEC-002 follow-up, item closed) | Scoped review of `c971a5d` (three Opus agents; reports in gitignored `audit-sec002-redteam-2026-08-29-{rules,server,client}.txt`): every face HOLDS WITH FINDINGS. Follow-up `66c5eac` deployed 04:58–04:59Z (`firestore:rules,functions:toggl,hosting`): ruleset `2afa7824…` == source; `toggl-syncqueue-00016-gig` (now `concurrency: 1`) and `publicweb-00088-nin` sole revisions after GC; Hosting version `1787979480229`. Changes: correlated stop rows are never deferred (a deferred one wedged every timer in the app); `deferrals` counted, terminal after 24 consecutive windows; malformed rows and malformed quota documents are logged, not thrown (no client-triggerable Eventarc redelivery remains); `createdAt` capped at request.time + 300 s and the deferral expiry measured from min(createdAt, now); the deferral gate fronts every retry branch. No data migration; no rows, users or documents touched. Smoke 200/200/200/200/404, probes 401×5 / 403, no trigger warnings. Tests: functions 124, unit 279, rules+emulator 2+80, PWA 8, artifacts 4. SEC-002 closed. |
| 2026-08-29 | (no script — rules sitting) | Order item 4, code `54936ff`, deployed 05:42–05:44Z with the pinned CLI (`firestore:rules,functions:toggl,functions:deleteUserDocument,hosting`, then `firestore:indexes --force` to delete the dead `books(finished, updatedAt)` composite index): ruleset `68d51acf…` == source; `toggl-syncqueue-00017-xex`, `publicweb-00091-xay` sole revisions after GC; Hosting version `1787982090525`. Rules: profiles/markers need `email_verified` + an existing `users/{uid}`; one profile per account via the new `profileOwners/{uid}` record moved in every profile batch; profile delete takes its own marker; reserved usernames; `profiles.updatedAt == request.time`; books/authors allowlisted and byte-capped (progress/timer updates exempt); `queueId` no slash; dead retry clause removed. Functions: `savetoken` verified-only + 5/h quota (`functionQuotas/togglToken`); `deleteUserDocument` removes `profileOwners/{uid}`. No data migration and no prod writes: the owner's existing profile has no ownership record and is treated as legacy (next rename/delete creates it). Live document keys were inventoried read-only (221 books / 181 authors / 1 profile / 1 marker / 17 users) before choosing the allowlists. Smoke 200/200/200/200/404, anon REST creates 403×5, savetoken 401, no WARNING+ logs. Tests: rules+emulator 2+90 (budget probe: 37 spare conjuncts on the offline-stop batches), functions 126, unit 279, PWA 8, artifacts 4. |
| 2026-08-29 | (no script — rules sitting follow-ups) | Review of `54936ff` (three Opus faces; reports in gitignored `audit-rules-redteam-2026-08-29-{profiles,client,books}.txt`): profiles HOLDS WITH FINDINGS, client HOLDS WITH FINDINGS, books BROKEN as shipped. Follow-ups `0875896` (owner's record-less profile can be deleted and converges on its next update; db.ts profile batches pinned structurally; ISBN form cap; fewer document accesses in the marker rules) and `f9453a7` (legacy author fields out of the allowlist, progress-exempt fields typed, retirement map bounded, budget probe re-aimed at the books update rule across all three timer batches — local stop 40+, remote stop 40+, unknown clear 15), deployed together 06:53–06:54Z with the pinned CLI (`firestore:rules,functions:toggl,hosting`): ruleset `1b7810aa…` == source; `publicweb-00094-ver`, `toggl-syncqueue-00018-vub` sole revisions after GC; Hosting version `1787983984933`. No data migration, no prod writes (the owner's `profileOwners` record will be created by the Me page's next stats sync). Smoke 200/200/200/200/404, anon REST creates 403×4, savetoken 401, no ERROR+ logs. Tests: rules+emulator 2+91, functions 126, unit 283, PWA 8, artifacts 4. |
| 2026-08-29 | (no script — SEC-006 review follow-ups) | Three-face review of `06207ee` (worktrees; reports in gitignored `audit-sec006-redteam-2026-08-29-{trigger,rules,purge}.txt`): all HOLDS WITH FINDINGS, no BROKEN. Follow-up `e103d7c`, deployed 21:4xZ (`functions:deleteUserDocument,firestore:rules`; ruleset `1648bfc2` == source, 47705024, 66209 B; no Hosting/publicWeb change, no Cloud Run revision churn). Rules F1: the profiles delete rule now gates on `accountLive()` (a `get(users/{uid}).deletedAt == null`, factored out of `verifiedAccount()`), closing the users-first/profiles-second window where a residual identity could delete its own not-yet-tombstoned profile and free the reserved name — not `verifiedAccount()`, so an unverified live owner may still delete. Trigger F1: `deleteUserDocument` deletes uid-matched `profileDiscovery` markers again (a search-index pointer, not content — the profile stays tombstoned+kept), ending the sitemap-scan accumulation the soft-delete introduced; a freed username's marker (another account's) is left alone. Purge B1: `migrate-purge-deleted-accounts.ts` deletes each subcollection then the root document LAST, and treats a missing root as an idempotent re-run (finishing an interrupted purge, ending at 0 writes) instead of throwing. Purge B2: the refusal test compares against a real `goneBefore` baseline, not itself; added an idempotent-re-run assertion. F2: tracker residual corrected — the binding limit for a get()-based timer-batch gate is the 20-document-access ceiling, not the 1000-expression budget. Smoke through book.ankile.com 200/404/200/200/200, lars in sitemap, no WARNING+ logs. Tests: rules+emulator 2+94, functions 129, unit 283, PWA 8, artifacts 4. |
| 2026-08-30 | (no script — SEC-006 second look) | Post-review pass over `e103d7c`, re-read cold and mutation-tested: each fix reverted in place must turn its own test red. Functions (10 mutants: marker delete off, marker delete regardless of uid, user/profile always re-stamped, limit-only paging, the three Toggl refusals, publicWeb ignoring the tombstone, admin label) all KILLED by the intended test — note that four first-round mutants failed lint/compile rather than a test and were redone type-clean, since a mutant that does not build proves nothing. Rules (3 mutants): `accountLive()` off the delete rule KILLED, off `verifiedAccount()` KILLED, the profile's own `deletedAt` clause off **SURVIVED** — a tombstoned profile on a live account had no case; added it plus a positive control with the same fixture and no tombstone (now KILLED). Hygiene: README runbook, tracker residuals and the purge header described the first cut ("the marker stays"); corrected. `db-audit.ts` gained `profile-discovery.profile-tombstoned` (a marker on a tombstoned profile — the trigger's job half done — was invisible because the tombstone leaves `public` true). `migrate-purge-deleted-accounts.ts` now refuses while the uid still exists in Auth (`getAuth().getUser` must throw user-not-found; a hand-written tombstone on a working account was purgeable). New emulator coverage: a 101-profile account through the real trigger (cursor paging against Firestore, not the mock), the Auth guard in both orders, the audit finding before and its absence after a purge, an interrupted purge (orphan subcollections under a missing root cleaned on re-run: `tree: 2 documents`); the audit and purge mutants are KILLED by them. A pollution bug in the new test (31-char marker name left behind → sitemap skip on the next run in the same session) was caught by running the file twice in one emulator and fixed. No prod change: nothing in `functions/src`, `firestore.rules` or the client moved, so no deploy; no prod reads beyond the smoke. Tests: check clean, rules+emulator 2+95, functions 129, unit 283, PWA 8. |
