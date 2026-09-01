# The shared catalog

Personal books stay personal. The catalog is a separate, server-owned set of
bibliographic documents that personal books point at, so two accounts reading
the same book can be shown as reading the same Work. Bibliographic data is
public whoever contributed it; who read what is not.

## Collections

| Collection | Document id | Contents |
|---|---|---|
| `catalogAuthors` | `author_` + 24 hex of `sha256("author\0" + nameKey)` | `canonicalName`, `alternateNames`, `nameKeys` (normalized names), `sortName`, `kind` (`person`/`entity`/`placeholder`), `status`, `mergedInto?`, `mergedFrom`, `createdAt`, `updatedAt` |
| `works` | random (`work-<uuid>`) or migration-deterministic | `canonicalTitle`, `alternateTitles`, `titleKeys`, `authorIds`, `coverUrl`, `subjects`, `fiction`, `status`, `mergedInto?`, `mergedFrom`, `createdBy?`, `createdAt`, `updatedAt` |
| `editions` | random (`edition-<uuid>`) or migration-deterministic | `workId`, `isbn13`, `title`, `publisher`, `publishedDate`, `language`, `translatorNames`, `format`, `suggestedPageCount`, `coverUrl`, `externalIds`, `createdAt`, `updatedAt` |
| `isbnIndex` | the ISBN-13 | `workId`, `editionId` |
| `externalIdIndex` | `sha256(provider + "\0" + externalId)` | `workId`, `editionId`, `provider`, `externalId` |
| `workTitleIndex` | `sha256(workId + "\0" + titleKey)` | `workId`, `title`, `titleKey`, `status` |
| `sharedWorkOwners` | `sha256(workId + "\0" + uid)` | `workId`, `uid`, `updatedAt` |

`titleKeys` and `nameKeys` come from the normalizers in
`src/lib/utils/catalog.ts`, which the backend and the migration share;
`test-fixtures/catalog-normalization.json` and `test-fixtures/catalog-ids.json`
pin the normalized text and the derived ids for both packages.

A personal book carries four link fields — `workId`, `editionId`,
`matchMethod` (`isbn`, `external-id`, `catalog-choice`, `migration`, `admin`)
and `linkedAt` — which are null together when the book is unlinked. Rules
require the linked work to be `active` and the edition to belong to it.

## Status and redirects

A work is `active`, `merged` or `hidden`. `hidden` is the admin soft delete:
search skips it and the reader page answers not-found. `merged` means the
document is an alias: `mergedInto` names the survivor, which lists the
absorbed ids in `mergedFrom` (at most 29). Authors use `active` and `merged`
only. A `workTitleIndex` row copies its work's status; only `active` rows are
queried.

Redirects are one hop. Resolving an alias whose target is itself merged, or
that points at itself, throws rather than following a chain, in the callables,
in the admin transaction and in `db-audit.ts`. A merge flattens chains so one
hop always suffices, and an alias document is never deleted: something may
still name it.

Catalog documents carry canonical ids: `mergeAuthors` rewrites the works that
name an absorbed author in the same transaction, and `catalog.create` and the
admin work operations resolve a merged author id before writing (a client or
form that loaded its author list before the merge). Personal books are never
rewritten by a merge — a merge would otherwise scale with an author's
readership and reach into tombstoned accounts — so a book keeps whatever
author or work id it was saved with, the Rules accept the alias, and every
reader (the client's in-memory author map, the callables, the admin scan,
`db-audit.ts`) resolves it in one hop at read time.

## Who creates what

- **Verified accounts.** `catalog.search` looks a book up by ISBN, external id
  or title. When nothing matches, `catalog.create` writes the Work, the
  Edition and their index rows in one transaction, stamping the work with
  `createdBy`; `catalog.ensureauthors` resolves or mints the shared authors a
  personal book references and refuses a name that matches more than one
  active author until an admin merges them. Both are bounded by the
  structural caps in `functions/src/catalogLimits.ts`. There is no consent or
  provenance gate: every account's books may seed the catalog.
- **The migration.** `migrate-cross-user-works.ts` builds the catalog from the
  personal books that already exist and links them. Its ids are deterministic
  so a re-run creates nothing new. It never deletes: legacy per-user author
  documents are retained, and tombstoned accounts are skipped entirely.
- **Admins.** Curation after the fact, never a precondition for creation.

## Sharing

Sharing is on by default (owner decision 2026-09-01): every live account's
linked books feed the reader list of their works unless the account opted
out. `users/{uid}/settings/bookSharing` (`enabled`, `timeZone`) records the
opt-out and the reader's time zone; an absent document means on, with day
boundaries taken in UTC until the client stores a zone (it does so on the
first visit to /me). One predicate on each side judges it —
`functions/src/sharingConsent.ts` for the backend, `sharing-consent.ts` for
the migration and the audit — from the account document and the setting
alone.

Who a reader is shown as is a separate question. The public profile the
account owns (`profileOwners/{uid}` → `profiles/{username}`, public and not
tombstoned) names them and links their card; otherwise the card says "A
reader". A private, renamed or deleted profile changes the name, never the
listing.

Consent governs exactly two things: the `sharedWorkOwners` rows and the
reader list they feed. It does not gate catalog creation, search, linking a
personal book, or the Work page's bibliographic half. Opting out — or the
account being tombstoned — deletes the projection rows on the next trigger
run.

Three Firestore triggers keep the projection true: a book whose `workId`
changes, a changed `bookSharing` setting, and a tombstoned account
document. Each re-derives the row from consent plus "does this account
still have a book linked to this work", and deletes it when either half
fails. The reader callable re-checks consent live, so the projection is a
candidate index, never the authority.

## Reader metrics

`/books/[workId]` shows one row per sharing reader's attempt at the work:
reading or finished, page count, first-progress, first-read and finished day
keys in that reader's time zone, calendar days, active days, tracked minutes,
session count, qualified pages per hour, percent per hour and tracking
coverage. Speed figures need enough qualified sessions and are otherwise null,
and no edition-level identifier is disclosed. The page is bounded: readers are
paged with a cursor, editions and re-reads per reader are capped, and a reader
whose data is malformed or too large is skipped rather than failing the page.

## Admin tools

`/admin` is the catalog console, and it is live: the operator's browser
listens to the catalog collections and to every personal book (the rules grant
those reads to the operator's UID alone, `isOperator`) and runs the scan
locally, so index mismatches, duplicate names, suspected duplicate works and
anomalous books appear as the data changes and cost only the documents that
change. The scan and the identity normalizers live in `shared/`
(`catalogScan.ts`, `catalogIdentity.ts`), imported by the app and copied into
`functions/src/shared` by the functions build, so the keys the browser matches
are the keys the server wrote. Changes go through two callables: a preview
that plans one operation, and an apply that re-plans it inside a transaction
and refuses if the state moved under the preview. The operations are
`upsertAuthor`, `mergeAuthors`, `createWork`, `linkBooks`, `mergeWorks`,
`editWork`, `upsertEdition` and `repointIsbn`. Every apply is idempotent by
operation id and writes an `adminAudit` record.

`/admin/users` is the accounts and issues page: the Auth user list,
per-account reading aggregates and the issue log, which only the Admin SDK
can read. It is one callable, run when the page is opened and never
prefetched.

## Migration

`migrate-cross-user-works.ts` (planner: `cross-user-work-migration.ts`) creates
the catalog and links personal books; `db-audit.ts` reports drift before and
after.
The rollout order, flags and retention policy are in
[MIGRATIONS.md](../MIGRATIONS.md#shared-catalog-rollout).
