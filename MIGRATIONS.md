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

Hosting and public profile rendering remain one coupled release artifact. Do
not deploy Hosting alone during a migration.

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
understood by older code. Never roll back only one member of a coupled Hosting
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
| `migrate-enrich-books.ts` | Fill gaps from the open catalog | Optional metadata maintenance |
| `migrate-enrich-google.ts` | Fill remaining gaps from the metered catalog | Optional metadata maintenance; requires approved private credential handling |
| `migrate-enrich-nb.ts` | Fill remaining gaps from the national catalog | Optional metadata maintenance |
| `migrate-enrich-goodreads.ts` | Manual last-resort historical enrichment | Exceptional manual use only; never schedule |
| `migrate-purge-deleted-accounts.ts` | Finish bounded cleanup for a deleted account | Maintenance tool; use only through the private deletion runbook |

The strict-TypeScript, timer-claim, progress-source, profile-publication, and
credential-storage rollouts are complete. They are historical context, not
steps in the current deployment procedure.

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
