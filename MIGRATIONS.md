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
| `migrate-lib.js` | shared target guard, batcher, snapshot codec | — |
| `db-snapshot.js` | full-database dump to `snapshots/<ISO>-<target>.json` | no |
| `db-restore.js` | load a dump into the emulator (or prod, disaster only) | yes |
| `db-audit.js` | read-only drift report, diff-friendly output | no |
| `migrate-*.js` | one script per migration, kept forever as history | yes |

All scripts share the same target rules, enforced in `migrate-lib.js`:

- **Default target is the emulator.** Without `--prod` the service-account
  key is never read and the script crashes unless `FIRESTORE_EMULATOR_HOST`
  is set — reaching production from the rehearsal code path is impossible,
  not merely guarded.
- `--prod` crashes if `FIRESTORE_EMULATOR_HOST` is set (contradiction),
  reads `./serviceAccountKey.json`, and asserts its `project_id`.
- Write scripts are **dry-run by default**; `--apply` is required to write,
  and `--prod --apply` additionally requires typing the project id.
- `--database=<id>` targets a named database (used for backup recovery).
- Unknown flags crash — a typoed `--aply` must not demote a run to dry-run.

## The migration loop

### 0. Prerequisites

- The migration script uses `migrate-lib.js` (`connect`, `batcher`) and is
  **idempotent**: every write is guarded on the defect/old shape being
  present, so a re-run after a clean pass performs 0 writes. Migrations must
  stay cheap to re-run — stale offline clients flush old-shape writes days
  later (see "Stale clients" below).
- `npm test` green (the unit suite covers the codec, the batcher guards,
  and the finished rule that audit + client share).

### 1. Baseline audit

```sh
node db-audit.js --prod > audit-pre.txt
```

### 2. Emulator rehearsal, with real triggers

```sh
npm --prefix functions run build
PATH="/opt/homebrew/opt/openjdk/bin:$PATH" \
  npm exec --yes --package firebase-tools@15.24.0 -- \
  firebase emulators:start --only firestore,functions
# in another shell:
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
node db-snapshot.js --prod                      # fresh dump (or reuse a recent one)
node db-restore.js snapshots/<file>.json --apply
node migrate-<name>.js                          # dry-run: review every line
node migrate-<name>.js --apply                  # triggers fire for real here
node migrate-<name>.js --apply                  # MUST print 0 writes
node db-audit.js > audit-emulator-post.txt
diff audit-pre.txt audit-emulator-post.txt      # exactly the intended lines, nothing else
```

The functions emulator runs the real compiled triggers (gen1 Firestore
triggers work in the emulator; the eur3 gen1 restriction is deploy-time
only), so trigger–migration interaction is rehearsed for real, not assumed.
Inspect anything suspicious in the emulator UI at http://127.0.0.1:4000.

### 3. Deploy code changes, in this order

1. **Functions** (`firebase deploy --only functions:<name>`) — trigger
   behavior must be correct before bulk writes land.
2. **Firestore rules/indexes** (`firebase deploy --only firestore`).
3. **Hosting** (`npm run build` + `firebase deploy --only hosting`).

Rules before hosting is load-bearing: the client writes in atomic
`writeBatch`es, so if new client code touches a not-yet-allowed collection,
the rules rejection loses the WHOLE batch — including the book write inside
it. Hosting serves `index.html` with `no-cache`, so navigations pick up new
client code promptly, but assume days of overlap with stale cached clients
(offline PWA).

### 4. Production run

```sh
node db-snapshot.js --prod                      # snapshot IMMEDIATELY before writing
node migrate-<name>.js --prod                   # dry-run: review every line
node migrate-<name>.js --prod --apply           # typed confirmation
node db-audit.js --prod > audit-post.txt
diff audit-pre.txt audit-post.txt               # exactly the intended changes
node migrate-<name>.js --prod --apply           # MUST print 0 writes
```

### 5. A few days later

```sh
node db-audit.js --prod | diff audit-post.txt -
node migrate-<name>.js --prod                   # dry-run; re-apply if stragglers
```

Stale clients: this is an offline-first PWA with fire-and-forget writes. A
phone that was offline during the migration flushes old-shape writes when it
reconnects, and a cached old app version keeps writing the old shape until
its next navigation. That is why migrations are idempotent and cheap to
re-run, and why the follow-up audit exists.

## Script conventions

- **Traversal**: migrations and the audit iterate with `.get()` — orphaned
  docs under deleted parents are not data to migrate. `db-snapshot.js`
  deliberately inverts this (`listCollections()`/`listDocuments()`) because
  a backup must capture those orphans; don't "fix" it.
- **Batching**: always through `batcher()` — 500-op rollover, dry-run
  counting, and it **crashes if an `update()` payload touches `updatedAt`**
  (on books it drives the reading-list order; no migration may touch it).
  `batcher.set()` allows `updatedAt` — it is for documents the script owns
  outright (restores, new-entity upserts).
- **Snapshot codec**: Timestamp/ref/GeoPoint/bytes round-trip via `__type`
  markers; the encoder crashes on unknown types and on documents using the
  reserved `__type` key. Crash-don't-corrupt.
- **No defensive programming**: unexpected shapes crash the script mid-run;
  batched writes make partial progress harmless and the guards make re-runs
  free. Fix the surprise, re-run.
- Migration scripts are committed and kept — they are the schema history.

## Backups and disaster recovery

Standing posture (all verified on, see console / `gcloud`):
PITR with a 7-day window, daily scheduled backups with 14-week retention,
and delete protection on `(default)`. `gcloud` on this machine must be run
with `--account=lars.ankile@gmail.com` per command.

**PITR and backups restore into a NEW named database — never in-place, and
never repoint the app.** The app, its rules, and the gen1 trigger binding
all belong to `(default)`. Recovery is always copy-back:

```sh
gcloud firestore databases restore \
  --source-backup=<backup> --destination-database=recovered \
  --account=lars.ankile@gmail.com
node db-snapshot.js --prod --database=recovered   # dump the restored db
node db-restore.js snapshots/<file>.json --prod --apply   # copy back into (default)
gcloud firestore databases delete --database=recovered ...
```

Notes on `db-restore.js --prod` (disaster recovery only):

- Full-overwrite `set()`: restores every doc in the dump as-is.
- **Never deletes** — documents *created* after the snapshot (e.g. by a bad
  migration) survive a restore and need manual cleanup (the audit diff will
  show them as unexpected paths).
- Skips `users/*/togglQueue/*` — a restored `pending` queue item would
  replay a real Toggl API call.
- Triggers fire during restore; the hardened trigger set is idempotent.

Lighter PITR path (no scratch database): the Admin SDK can read the live
database as of any point in the PITR window via read-time reads — good
enough to recover individual fields without a full restore.

## Triggers and book content

No Firestore trigger touches book *content*: the client computes every
book invariant (finished, aggregates) in the same `writeBatch` as the
mutation, and `migrate-normalize-books.js` re-runs repair anything a stale
client leaves behind. The transitional `bookIsFinished` backstop was
deleted 2026-08-11. Standing constraint for any future trigger: eur3
rejects newly *created* gen1 Firestore triggers, so it must be gen2
(lowercase name, `database: "(default)"` — see triggers.test.cjs).

## Migration history

| Date | Script | What it did |
|---|---|---|
| 2025-06 | `migrate-add-owner.js` | backfilled `owner` refs on books/updates |
| 2026-08-11 | `migrate-normalize-books.js` | backfilled `isbn: ''` on 6 legacy books; carries the full normalize policy table for re-runs |
| 2026-08-11 | `migrate-authors.js` | authors as first-class entities: split 220 books' author strings into `users/{uid}/authors` docs + `authors` arrays (459 ops); audit went to 0 findings |
