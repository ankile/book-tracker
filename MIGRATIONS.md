# Database migration playbook

This is the public-safe procedure for repository migration tools. It records
what each script is for and whether its rollout has already finished. Project
identifiers, account identities, credentials, production observations,
incident commands, and exact operational limits belong in private operator
runbooks.

Migration scripts default to local emulators. `--prod` selects the deployed
target but does not enable writes. `--apply` enables writes. A production apply
requires both flags and an interactive confirmation.

## Safety rules

- Never make a production migration part of a routine deployment.
- Read the script header and review its diff before running it.
- Use locked dependencies and the repository's pinned Node version.
- Rehearse the exact revision against emulators first.
- Capture a fresh snapshot before a production write.
- Run the audit before and after the migration.
- Run the production dry-run immediately before the apply.
- Apply an idempotent migration twice. The second pass must report no writes.
- Stop if the dry-run, snapshot, apply, or audit output differs from the
  reviewed expectation.
- Use the private runbook for scheduling, access, verification, rollback, and
  incident response.

## Repository tools

| Tool | Purpose |
|---|---|
| `db-audit.ts` | Read-only consistency and invariant checks |
| `db-snapshot.ts` | Read-only JSON snapshot before a migration |
| `db-restore.ts` | Last-resort restore aid, not a routine rollback command |
| `migrate-lib.ts` | Shared target selection, confirmation, and connection helpers |
| `migrate-cross-user-works.ts` | Create the shared author, work, and edition catalog and link personal books |
| `migrate-*.ts` | Data-shape migrations and bounded maintenance tasks |

## Standard migration loop

### 1. Prepare and validate

Start from the exact revision intended for release:

```bash
nvm use
npm ci
npm --prefix functions ci
npm run validate
```

Review the migration source, its tests, relevant Rules, backend decoders, and
client decoders together. If the data-shape change affects architecture, data
flows, routes, access, or integrations, update and regenerate the maps before
the release.

### 2. Establish a baseline

Run the audit against the local target first:

```bash
node db-audit.ts
```

For production work, use the read-only production form only after following
the private access runbook:

```bash
node db-audit.ts --prod
node db-snapshot.ts --prod
```

Keep snapshots out of Git. They may contain personal or credential-adjacent
data even when the migration itself does not touch those fields.

### 3. Rehearse against emulators

Start Authentication, Firestore, and Functions together:

```bash
npm --prefix functions run serve
```

In another terminal, run the migration dry-run, apply it twice, and audit the
result. Replace `<migration>` with the reviewed script name.

```bash
node <migration>.ts
node <migration>.ts --apply
node <migration>.ts --apply
node db-audit.ts
```

The second apply must be a no-op. Run relevant rules, Functions, unit, and
browser tests against the migrated emulator state.

### 4. Deploy compatible code

Some migrations require additive Rules, tolerant readers, or dual-write code
before data changes. Others require new data before stricter code can ship.
There is no universal deploy order for a schema change.

The migration's source, tests, and private release runbook must state the
compatibility sequence. If they do not, stop and add that sequence before
touching production. Do not reuse a completed rollout sequence from an older
migration.

The client site and the public profile renderer remain one coupled release
artifact. Do not deploy the site alone during a migration.

### 5. Run the production migration

After the compatible code is live and verified:

```bash
node <migration>.ts --prod
node db-snapshot.ts --prod
node <migration>.ts --prod --apply
node <migration>.ts --prod --apply
node db-audit.ts --prod
```

Compare each step with the reviewed dry-run. Keep the operator log and
snapshot in approved private storage, not in the repository.

### 6. Tighten and clean up

Only after the compatibility window in the migration-specific private runbook:

- remove temporary dual-read or dual-write behavior;
- tighten Rules and decoders;
- remove obsolete fields or indexes through a separate reviewed migration;
- rerun the complete validation suite and production audit;
- mark the migration completed in the status ledger below.

## Rollback policy

Prefer compatibility and fix-forward releases. A Firestore snapshot is a
targeted recovery aid, not a transactional rollback. `db-restore.ts` is
non-atomic and does not delete documents that are absent from the snapshot.
Do not use it for an ordinary release reversal.

If a migration partially applies, stop new writes through the private incident
procedure and determine whether the idempotent migration can safely resume.
Use a purpose-built repair migration when data written by newer code cannot be
understood by older code. Never roll back only one member of a coupled site
and renderer release.

## Script conventions

Migration scripts in this repository follow these rules:

- No flags means emulator dry-run.
- `--apply` means emulator write.
- `--prod` means production dry-run.
- `--prod --apply` means production write after typed confirmation.
- Unknown flags fail rather than being ignored.
- Production mode refuses an emulator connection.
- Emulator mode refuses to connect without an emulator host.
- Dry-runs print planned changes without writing.
- Write mode logs the applied result selected inside each transaction.
- Scripts that call external catalogs cache responses in ignored local files.

Database-specific options and extra flags are documented in the relevant
script header. Do not infer them from another migration.

## Migration status

The status table prevents completed one-time work from being mistaken for
current deployment instructions.

| Script or group | Purpose | Status |
|---|---|---|
| `migrate-add-owner.ts` | Add ownership metadata to legacy records | Completed historical rollout |
| `migrate-authors.ts` | Introduce normalized author documents | Completed historical rollout |
| `migrate-author-ids.ts` | Replace legacy author fields with author references | Completed historical rollout |
| `migrate-placeholder-authors.ts` | Repair placeholder author records | Completed historical rollout |
| `migrate-person-names.ts` | Normalize person names | Completed historical rollout |
| `migrate-enrich-given-names.ts` | Fill missing given-name metadata | Completed historical rollout |
| `migrate-normalize-books.ts` | Normalize legacy book fields | Completed historical rollout |
| `migrate-profile-owners.ts` | Add profile ownership records | Completed historical rollout |
| `migrate-timer-claims.ts` | Add server-owned timer claim state | Completed historical rollout. Do not rerun during deployment. |
| `migrate-reading-progress-sources.ts` | Add progress-write provenance | Completed historical rollout. The proposed waiting period was superseded and the rollout completed in the same release window. |
| `migrate-toggl-tokens.ts` | Move legacy integration credentials | Completed historical rollout. Reuse requires a separate credential-rotation review. |
| `migrate-cross-user-works.ts` | Move author identity into the shared catalog and add Work/Edition links | Completed historical rollout (2026-09-01: apply matched the reviewed dry run, second apply 0, audit clean apart from one reviewed-group author the planner did not mint — repaired separately). Idempotent; a rerun links only books that gained unlinked author references since. |
| `migrate-finished-at.ts` | Stamp `finishedAt` on books finished before the field existed, from their progress history | Completed historical rollout (2026-09-01: 198 stamped, second apply 0, audit clean). Idempotent; a rerun stamps only a finished book that somehow lost its stamp. |
| `migrate-book-editions.ts` | Put every linked personal book on an edition of its work, minting one per reader per book identity from the book's own fields | Completed historical rollout (2026-09-02: dry-run and emulator rehearsal on the day's snapshot matched the apply — 46 editions created, 47 books linked, nothing for review — second apply 0, audit back at its known baselines). Idempotent; a rerun joins what it minted and plans nothing for a book that carries an edition. See [Book editions backfill](#book-editions-backfill). |
| `migrate-catalog-creators.ts` | Stamp `createdBy` on every work, edition and catalog author that has none, from the earliest personal book standing on it | Pending. Idempotent; a record that carries a creator is left alone. See [Catalog creators backfill](#catalog-creators-backfill). |
| `migrate-enrich-books.ts` | Fill gaps from the open catalog | Optional metadata maintenance |
| `migrate-enrich-google.ts` | Fill remaining gaps from the metered catalog | Optional metadata maintenance; requires approved private credential handling |
| `migrate-enrich-nb.ts` | Fill remaining gaps from the national catalog | Optional metadata maintenance |
| `migrate-enrich-goodreads.ts` | Manual last-resort historical enrichment | Exceptional manual use only; never schedule |
| `migrate-purge-deleted-accounts.ts` | Finish bounded cleanup for a deleted account | Maintenance tool; use only through the private deletion runbook |

The strict-TypeScript, timer-claim, progress-source, profile-publication, and
credential-storage rollouts are complete. They are historical context, not
steps in the current deployment procedure.

## Shared catalog rollout

The shared-catalog migration creates canonical author, Work, Edition, and
lookup records, rewrites resolvable personal-book author references to the
shared catalog, and adds explicit catalog links. It never changes personal
progress, sessions, or the user's chosen page count. Ambiguous records remain
unlinked and retain the legacy rows needed for review.

Matching is conservative: a normalized edition identifier is strongest;
otherwise the complete normalized title-and-author identity must agree. A
reviewed JSON manifest may join exact personal-book paths when an operator has
resolved a translation or spelling difference. Every reviewed group must
provide positional `authorNames` and `authorKinds`. The decoder keeps each
name/kind pair together while normalizing, sorting, and deduplicating, and
rejects omitted kinds or conflicting classifications. The reviewed kind is
authoritative: an author the heuristics would treat as a placeholder
("Various Authors") is minted when the manifest classifies it as an entity,
and only a reviewed `placeholder` drops the name.

The release is not additive at the Rules layer — the personal author
collection loses its write rules and every book write must reference the
shared author catalog — and the client is a separate deploy artifact from
Rules and the backend. The order below is Rules and backend, then the
migration, then the client:

1. deploy Rules, indexes and the backend together, before the migration
   runs. The new Rules are a superset of the stored book shape: they
   allowlist the four catalog link fields the migration adds, which the
   previous Rules reject on a book's next edit — run the migration first and
   every migrated book is frozen for its owner until the deploy lands. The
   composite indexes must exist before search or a curation merge run, and
   the new callables and projection triggers are simply unused until the
   client ships. The cost of this order is stated in step 2;
2. run the standard snapshot, dry-run, apply-twice, and audit loop with the
   exact reviewed manifest. Pass `--expect-overlap-groups=N` with the number
   the reviewed dry-run printed, so a data change between review and apply
   is a refusal rather than a different write. The migration writes through
   the Admin SDK, so Rules do not constrain it. Do not use the app between
   the snapshot and step 3: the migration is only atomic against data
   nothing else is writing. A browser tab still holding the pre-catalog
   bundle is degraded from step 1 onward, not intact: it reads its retained
   per-user author documents and can still record reading progress, but an
   add or edit that writes a per-user author is refused until it reloads.
   Editing is effectively down for un-reloaded tabs during this window;
3. deploy the client with `npm run pages:deploy`. Rules and Functions went
   out in step 1, so nothing else ships here; the service worker installs the
   new bundle on the next navigation. Tell users to reload if a save was
   refused;
4. re-run the dry run; apply again only if step 2's window produced new
   personal-author references (the apply is idempotent and prints them as
   REVIEW lines otherwise), then audit;
5. verify catalog suggestions, personal-book edits, sharing convergence, Work
   reader summaries, and restricted catalog curation.

The two deploy commands are `firebase deploy --only
firestore:rules,firestore:indexes,functions` for step 1 and `npm run
pages:deploy` for step 3. They are never one command: the client is served
from a different platform than Rules and the backend. The functions deploy
needs `--force` (the projection triggers declare `retry: true`), and a
newly created gen2 trigger service has no `run.invoker` binding for
`functions-runtime@` until one is granted by hand — see
`functions/src/runtime.ts`; until then Eventarc's deliveries are refused
and retried.

### Operator run sheet

One operator session runs the whole rollout start to finish in one sitting.
There is no scheduling concern: the owner is the only active user and does
not use the app during the run. The only goal is data integrity — if any
step's output differs from the reviewed dry run recorded in the operator
log, stop; the snapshot and PITR are the rollback, and nothing below
deletes anything.

```bash
# 0. from merged master, full validation
nvm use && npm ci && npm --prefix functions ci && npm run validate

# 1. baseline (read-only) + snapshot
node db-audit.ts --prod
node db-snapshot.ts --prod

# 2. Rules + indexes + backend, before any data moves
firebase deploy --only firestore:rules,firestore:indexes,functions

# 3. catalog migration: dry run must match the reviewed numbers exactly,
#    then apply twice — the second apply must report no writes
npx tsx migrate-cross-user-works.ts reviewed-cross-user-works.json --expect-overlap-groups=<N> --prod
npx tsx migrate-cross-user-works.ts reviewed-cross-user-works.json --expect-overlap-groups=<N> --prod --apply
npx tsx migrate-cross-user-works.ts reviewed-cross-user-works.json --expect-overlap-groups=<N> --prod --apply

# 4. audit, then ship the client and purge the edge cache
node db-audit.ts --prod
npm run pages:deploy && npm run pages:purge

# 5. verify by hand: add-book search suggestion, edit an existing book,
#    a work's reader page, the sharing toggle, the /admin catalog console
```

`<N>` and the expected dry-run counts are production observations and live
in the operator log, not here. The reviewed manifest is
`reviewed-cross-user-works.json`, tracked in this repository: it is part of
the reviewed change (which books form a group and under which author), not
rehearsal evidence.

Sharing became on-by-default on 2026-09-01 (owner decision): consent is a
live account without an opt-out (`users/{uid}/settings/bookSharing.enabled
== false`), independent of profiles. The reader projections for accounts
that never had a setting are created by re-running the same migration
after that deploy — `sharedWorkOwners` rows are the one thing it adds for
an already-linked book, and it never deletes — and the one pre-existing
setting was rewritten to the new shape by hand.

Legacy per-user author documents and the read-only
`users/{userId}/authors` compatibility block stay exactly as they are after
the rollout. No purge script exists and none is scheduled: retained data is
moved or removed only on an explicit owner request (owner decision
2026-08-31).

The migration never deletes a document. Legacy per-user author records are
retained once no book references them (they are unreachable for the new
client and counted by `db-audit.ts`), a book that still references a
retired-as-deleted author is a REVIEW line rather than a rewrite, and
tombstoned accounts are skipped entirely so the private deletion runbook
stays the only path that touches them.

The migration header documents its flags. Production rehearsal evidence
(dry-run output, counts, `<N>`) stays in the operator log, not in Git.
## Book editions backfill

Every personal book linked to a work stands on an edition of that work
(owner decision 2026-09-01). The catalog build minted editions for ISBNs
only, so a work seeded by ISBN-less books had none and an ISBN-less book on
a work another reader's ISBN seeded had no edition of its own.
`migrate-book-editions.ts` (planner: `book-edition-backfill.ts`) mints one
edition per reader per distinct book identity (title, publisher, ISBN under
one account — a reread shares one) from the book's own fields, with the
owner as `createdBy`, and links the books to it. An ISBN already indexed to
the work is joined instead; one indexed elsewhere, a merged or missing work,
a tombstoned owner and an untitled book are printed as REVIEW lines and left
for the console.

The change is additive and needs no Rules change: `createdBy` on editions and
authors is a new optional field the backend, the scan and the audit accept,
and the edition ids follow the formula the admin link path uses, so a later
relink from the console lands on the backfilled document. Order:

1. deploy the backend (`catalog.addedition`, creator stamps, admin minting
   on links) and then the client with `npm run pages:deploy`, so new links
   made from now on carry an edition;
2. run the standard dry-run, snapshot, apply-twice, audit loop. The audit
   class `catalog.book.linked-without-edition` counts what is left; after the
   apply it is the REVIEW lines only.

## Catalog creators backfill

Every work, edition and catalog author carries `createdBy` (owner decision
2026-09-02): the reader whose book brought the record in, the operator for a
record created in the console. The catalog build stamped none.
`migrate-catalog-creators.ts` (planner: `catalog-creator-backfill.ts`)
attributes each creator-less record to the owner of the earliest-created
personal book standing on it — for a work the books linked to it directly or
through a merged alias, for an edition the books linked to it, for an author
the books on the works naming it directly or through a merged alias — and
prints a REVIEW line for a record nothing stands on. Additive, one
`update` per record, no Rules change; the audit reports a missing creator
as `catalog.<kind>.missing.createdBy`, so after the apply that class is the
REVIEW lines only. Order: deploy the backend (console creations stamp the
operator) and the client (creators shown as emails), then the standard
dry-run, snapshot, apply-twice, audit loop.

## finishedAt rollout (completed 2026-09-01)

Books carry an explicit `finishedAt` (a timestamp exactly when `finished`
is true, null otherwise). Before the field existed, the finished list
rendered `updatedAt` as the finish date, which moves on every metadata
edit. The client now stamps `finishedAt` in the same batch that flips
`finished`; `migrate-finished-at.ts` backfills every book finished before
the field existed from its own progress history (newest forward-progress
row, else newest row, else the book's `createdAt`; never `updatedAt`).

The Rules enforce the invariant from the first deploy rather than tolerating
an unstamped finished book, so the order is Rules, then the backfill, then
the client, in one sitting. Between the Rules deploy and the end of the
backfill an old client cannot edit a finished book (the Rules refuse the
missing stamp) and cannot finish one until the new client is live; the
owner is the only user and does not use the app during the run.

```bash
# 0. from the reviewed revision, full validation
nvm use && npm ci && npm --prefix functions ci && npm run validate

# 1. baseline (read-only) + snapshot: the rollback is this snapshot and PITR
node db-audit.ts --prod            # book.finished-without-finishedAt = every finished book
node db-snapshot.ts --prod

# 2. Rules only (nothing in Functions changes)
firebase deploy --only firestore:rules

# 3. backfill: dry run, then apply twice — the second apply must stamp 0
#    books. Compare the YEARS lines with the books-by-year table on /me.
node migrate-finished-at.ts --prod
node migrate-finished-at.ts --prod --apply
node migrate-finished-at.ts --prod --apply

# 4. audit: zero finishedAt findings
node db-audit.ts --prod

# 5. ship the client and purge the edge cache
npm run pages:deploy && npm run pages:purge
```

The migration writes one field per finished book and nothing else. Nothing
is deleted; `updatedAt`, `createdAt`, and the update rows are untouched.
Undoing it is deleting the one field, and `db-restore.ts` from the step-1
snapshot restores the exact prior documents.

## Documentation maintenance

When a migration changes system responsibilities, data flows, access, routes,
or integrations, update the relevant files under `docs/architecture/`, render
new SVG and PNG artifacts, and run:

```bash
node docs/architecture/verify.ts
```

When a migration completes, update this status ledger in the same commit that
removes temporary compatibility code. Never paste production logs, account
identifiers, secret names, security findings, or emergency commands into this
public file.
