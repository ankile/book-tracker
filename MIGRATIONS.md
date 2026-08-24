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
npm --prefix functions run build
PATH="/opt/homebrew/opt/openjdk/bin:$PATH" \
  npm exec --yes --package firebase-tools@15.24.0 -- \
  firebase emulators:start --only firestore,functions
# in another shell:
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
node db-snapshot.ts --prod                      # fresh dump (or reuse a recent one)
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
Inspect anything suspicious in the emulator UI at http://127.0.0.1:4000.

### 2b. Rehearse the real client against the migrated data

When a migration changes what the client reads or writes, run the actual
client against the migrated emulator data before deploying anything. Start
the emulators with `--only firestore,functions,auth`, then create an auth
user with your own prod uid so the snapshot's data is yours:

```sh
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 node --input-type=module -e "
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
initializeApp({ projectId: 'book-tracker-d8f24' });
await getAuth().createUser({ uid: '<your-prod-uid>', email: 'me@test.local', password: 'test1234' });"
VITE_EMULATOR=1 npm run dev
```

`VITE_EMULATOR` flips the DEV-gated hooks in `src/lib/firebase/db.ts` and
`auth.ts` to the local emulators. Exercise every read and write path the
migration touches, then re-run the migration dry-run: the writes the fresh
client just made must be invisible to it (0 ops against new-shape docs).

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

- **Traversal**: migrations and the audit iterate with `.get()` — orphaned
  docs under deleted parents are not data to migrate. `db-snapshot.ts`
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
all belong to `(default)`. Recovery is always copy-back:

```sh
gcloud firestore databases restore \
  --source-backup=<backup> --destination-database=recovered \
  --account=lars.ankile@gmail.com
node db-snapshot.ts --prod --database=recovered   # dump the restored db
node db-restore.ts snapshots/<file>.json --prod --apply   # copy back into (default)
gcloud firestore databases delete --database=recovered ...
```

Notes on `db-restore.ts --prod` (disaster recovery only):

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

Posture change with `migrate-author-ids.ts`: the legacy `author` string on
book docs used to double as an informal rollback affordance; it is gone
from docs once that migration applies. Rollback is now explicitly: redeploy
the previous hosting build, then recover fields from the immediately-prior
snapshot or PITR. The affordances above fully replace it.

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
