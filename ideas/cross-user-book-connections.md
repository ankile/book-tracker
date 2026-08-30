# Cross-user book connections

Status: implemented and release-validated on `codex/cross-user-book-connections`; not deployed. The original work design was reviewed against the repository by Codex, Claude Code, Claude Fable, and independent security/privacy and integrity/migration audit agents on 2026-08-29/30. The shared-author revision incorporates every actionable audit finding; both independent re-audits are clean.

## Goal

Connect different users' reading records when they refer to the same work. This should support two product experiences:

1. While adding or editing a book, suggest an existing catalog work and edition when there is a plausible match.
2. On a work page, show opted-in readers and comparable summaries of when and how they read it.

The shared connection must not replace a user's own book record. Each user keeps control of their title, ISBN, page count, progress, and reading history.

## Non-goals for the first version

- Building a general-purpose bibliographic database.
- Treating a valid ISBN as the identity of a work. An ISBN identifies an edition.
- Forcing users to accept catalog metadata or another reader's page count.
- Blocking duplicate user records. A user may add a work again for a reread.
- Exposing private libraries or raw session documents to other clients.
- Requiring an online catalog call when every selected author already exists in the cached shared catalog. Creating a genuinely new shared author does require the author callable to succeed.
- Modeling the contents of anthologies, omnibuses, or box sets. The collection may be a catalog work, but it will not link to each contained work in the first version.

## Current constraints

- Personal books live at `users/{uid}/books/{bookId}` and Firestore Rules allow only the owner to read them.
- Reading events live below each personal book in its `updates` subcollection.
- A personal book already stores user-owned `title`, `isbn`, and `pageCount` fields. It also stores aggregate `pagesRead` and `timeRead` values.
- Legacy authors are normalized only within a user account. The migration must consolidate those IDs before the shared catalog becomes the live source.
- The client writes through Firestore's offline queue. A new shared-catalog feature must preserve that behavior.
- Public profiles expose aggregate reading statistics, not the titles and dates of individual books.
- Cached clients overwrite profile documents as a whole. New sharing consent must not be stored as a field that an old client can silently remove or recreate.
- Sign-up is open. Requiring authentication does not make a globally listable catalog private.
- The production database currently has 221 personal book records. Eighteen works have already been identified as cross-user overlaps.

## Main design decision

Use four layers of identity:

```text
Catalog author
  A shared person, entity, or placeholder referenced by works and personal books.

Work
  The intellectual work, such as The Unbearable Lightness of Being.

Edition
  A published version of that work, usually identified by ISBN.

Personal book
  One user's tracked reading record, with their chosen page count and sessions.
```

The catalog answers which work and edition a record refers to. The personal book remains authoritative for tracking.

## Proposed data model

### `catalogAuthors/{authorId}`

```ts
interface CatalogAuthor {
  canonicalName: string;
  alternateNames: string[];
  nameKeys: string[];
  sortName: string;
  kind: 'person' | 'entity' | 'placeholder';
  status: 'active' | 'merged';
  mergedInto?: string;
  mergedFrom: string[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

Authors are one verified-account-readable, server-owned catalog. Both works and personal books reference these IDs. There is no live per-user author shadow. A bounded `catalog-ensureauthors` callable resolves exact normalized names and aliases, returns existing canonical IDs, and creates only missing rows. Ordinary users cannot rename or merge authors. Admin merges compress redirects and rewrite every affected work and personal book in the same previewed operation.

The author callable meters normalized names rather than calls: at most 60 requested names per account, with a 500-per-hour global breaker charged only for names that are actually missing. Creation transactionally refuses to take the shared catalog above its 500-row operating capacity. Exact names already in the catalog cannot consume the global creation breaker.

The product does not treat the fact that a user reads a particular author as sensitive. This permits shared autocomplete and migration of author identity from every resolvable library. It does not relax the separate consent requirement for publishing a work or exposing reading dates and speed.

### `works/{workId}`

```ts
interface Work {
  canonicalTitle: string;
  alternateTitles: string[];
  titleKeys: string[];
  authorIds: string[];
  coverUrl: string;
  subjects: string[];
  fiction: boolean | null;
  visibility: 'internal' | 'searchable';
  status: 'active' | 'merged';
  mergedInto?: string;
  mergedFrom?: string[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

`alternateTitles` includes translated titles and known title variants. `titleKeys` holds normalized canonical and alternate titles produced by one deterministic normalizer. `authorIds` always resolve through `catalogAuthors`; a work never stores canonical author names as independent strings.

Work-level inherited metadata includes the canonical title, authors, fallback cover, subjects or tags, and fiction/non-fiction classification. These describe the intellectual work and provide defaults when a user selects a match.

`visibility` separates internal curation from user-facing discovery. An internal work may connect private records and appear to administrators. A linked owner sees only their personal book fields and a neutral link marker until promotion. Catalog search never returns the internal work. A searchable work may appear in suggestions. A user who explicitly creates or selects a shared catalog work accepts that bibliographic disclosure. An administrator may promote an internal work after external verification and the consent rule defined below.

The merge redirect is required from the beginning. Matching will eventually create duplicate works, and old personal-book links must keep resolving after a repair. A canonical work records its old IDs in `mergedFrom`. Reader queries include those IDs so books linked before a merge do not disappear.

Compress redirects during every merge. If work B already absorbed A and then merges into C, both A and B point directly to C. C records both IDs in `mergedFrom`. A merged work must always point to an active work, so redirect depth is exactly one. Reject a merge whose canonical ID plus aliases would exceed Firestore's 30-value `in` limit. This gives each canonical work at most 29 merged IDs.

### `workTitleIndex/{indexId}`

```ts
interface WorkTitleIndexEntry {
  workId: string;
  title: string;
  titleKey: string;
  visibility: 'internal' | 'searchable';
}
```

Store one server-owned row for each canonical or alternate title. The search callable can run a bounded range query on `titleKey` for prefix suggestions. Clients cannot read or list this index. Work creation, alias edits, and merges update it transactionally with the catalog change.

### `editions/{editionId}`

```ts
interface Edition {
  workId: string;
  isbn13: string | null;
  title: string;
  publisher: string;
  publishedDate: string;
  language: string;
  translatorNames: string[];
  format: 'full' | 'abridged' | 'revised' | 'unknown';
  suggestedPageCount: number | null;
  coverUrl: string;
  externalIds: Record<string, string>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

An edition's page count is a suggestion. It never overwrites a personal book after linking. The edition also owns its edition-specific title and cover, plus publisher, date, language, translators, format, ISBN, and external identifiers. Language, translators, and abridged or revised status explain legitimate differences between editions and help prevent bad comparisons. Authors, subjects, and fiction classification inherit from the work rather than being duplicated on each edition.

Editions are top-level documents rather than work subcollections. Moving an edition changes its `workId` without changing `editionId`, so personal books do not acquire dangling edition links during a work merge or correction. The invariant is that the edition's resolved `workId` equals the personal book's resolved `workId`.

### `isbnIndex/{isbn13}`

```ts
interface IsbnIndexEntry {
  workId: string;
  editionId: string;
}
```

Using the normalized ISBN-13 as the document ID makes exact ISBN lookup cheap and enforces one catalog mapping per ISBN through a transaction. An administrator must be able to repoint a bad or reused ISBN mapping. A repoint transaction clears the old edition's `isbn13`, sets the new edition's ISBN, and changes the index together. Work merges repoint affected editions while preserving their IDs.

### Additions to `users/{uid}/books/{bookId}`

```ts
interface CatalogLink {
  workId: string | null;
  editionId: string | null;
  matchMethod: 'isbn' | 'external-id' | 'catalog-choice' | 'migration' | 'admin' | null;
  linkedAt: Timestamp | null;
}
```

The queryable `workId` and `editionId` fields live at the top level of the book document even if link provenance uses a nested map. `workId` remains nullable so offline and unmatched books are valid. The migration writes explicit null link fields to unmatched legacy books because Firestore equality queries do not return documents where the field is absent. Until migration completes, the decoder maps missing link fields to null. `linkedAt` uses the client's `Timestamp.now()` to follow the app's existing offline timestamp convention.

The existing personal fields stay unchanged:

- `title`
- `authorIds`
- `isbn`
- `pageCount`
- `currentPage`
- `finished`
- `pagesRead`
- `timeRead`
- metadata fields

When a catalog suggestion is selected, the form fills only fields the user has not already chosen. It prefers edition title, page count, cover, publisher, and publication date; falls back to the work title and cover; and fills authors, subjects, and fiction classification from the work. These are one-time defaults. Later catalog edits never overwrite a personal book's page count, cover, tags, fiction choice, or other metadata. A Work may retain up to 20 authors, but a personal shadow inherits at most the first six because that is the safe Firestore Rules budget for an atomic link plus page correction; the UI states when it truncated the inherited list.

## Catalog ownership and correction

Clients may get an active, searchable catalog work or one of its editions by known ID. They may not list works or editions. Security Rules enforce visibility on direct gets. Search goes through a bounded, quota-protected callable and returns only active, searchable works. Verified, live accounts may list shared authors because author-reading privacy is explicitly out of scope. Open sign-up still means a stranger must not be able to enumerate the union of users' works or libraries. Personal books admit at most six unique author IDs so Rules can verify every referenced shared document within Firestore's access and expression budgets, including a simultaneous page-count correction and Work/Edition link. One-hop merged aliases remain valid for cached offline writes and are canonicalized on the next metadata edit; deleted legacy per-user IDs are rejected.

Client link writes may target only active, searchable works and editions whose `workId` matches. Administrators may link private records to internal works through Admin SDK callables. A personal book linked to an internal work renders from its own fields with a neutral `Linked` marker because the browser cannot read the internal catalog document.

A callable owns catalog creation, ISBN mappings, work merges, and edition changes. This prevents ordinary book edits from rewriting shared metadata. The narrow author-resolution callable may create a missing author but cannot edit or merge one. Linking a personal book reveals that its bibliographic work exists in the shared catalog, so the UI must state that plainly. Migration must not seed catalog works solely from a private user's library without consent. It may seed the operator's library, opted-in libraries, and external bibliographic records. Author identity may be seeded from any resolvable personal book under the relaxed author privacy decision.

The user must be able to change or remove a personal book's link. A bad link should be repairable without editing progress or sessions.

Two reasonable link-write designs exist:

1. Let the owner write `workId` and `editionId`, while Rules require referenced catalog documents to exist.
2. Let a callable own those fields and keep personal books unlinked until the callable succeeds.

Start with option 1. The app currently has a small, trusted user base, and it preserves offline selection of a cached catalog result. Catalog documents remain server-owned. Rules require `workId` and `editionId` to be strings or null, require non-null references to exist, require the work to be active and searchable for client writes, and require the edition to belong to that work. If deliberate bad linking becomes a real problem, move link changes behind a callable later.

An edit should write catalog-link fields only when the user changed the link. Do not include a stale `workId` in every metadata update. Build a link patch only after an explicit link choice, then include that patch in the existing book-edit batch so a simultaneous page-count correction stays atomic. A standalone relink can use its own `updateDoc`. A new personal book may include the selected link in its initial batch.

The page-count clamp path in Firestore Rules has an affected-key allowlist because the client writes a correction event and the book edit together. Add the catalog-link fields to that allowlist. Keep catalog reference reads inside the full book-shape validation branch, guarded by a check that link fields changed. Ordinary progress and timer batches must skip them. This protects both Firestore's document-access limit and the Rules expression budget. Rules tests must cover a link plus page-count clamp succeeding, a link smuggled into a reading-session batch failing, and timer operations keeping their current expression-budget margin.

## Add and edit flow

Catalog suggestions should appear as the user enters an ISBN, title, or author.

Match candidates in this order:

1. An exact normalized ISBN maps to an edition and work.
2. An external provider's work identifier maps to a work.
3. Normalized title and author match a canonical or alternate title.
4. Fuzzy title and author similarity produce suggestions only.

Only exact ISBN and trusted external work identifiers are safe candidates for automatic preselection. Title matches should ask for confirmation. Never merge or link automatically from title alone.

A suggestion row should show:

- Cover, canonical title, and authors.
- Matching edition, ISBN, publisher, and suggested page count when known.
- A clear `Use this work` action.
- A `This is a different book` action.
- A warning if the signed-in user already has a personal record linked to that work, with choices to open it or add a reread.

After selection:

- Fill only empty title, author, ISBN, and metadata fields.
- Keep the page-count input editable and label it `Your edition's page count`.
- Show the selected work as a removable link below the form.
- Do not change an existing personal book's page count when catalog metadata changes.

If catalog lookup is unavailable, save an unlinked personal book through the existing offline path. Offer `Find matching work` after reconnection. Existing cached shared authors remain offline-capable. A genuinely new author is resolved before the optimistic write starts; if the browser is offline or the callable refuses the request, keep the modal and draft open and queue no partial book.

Normalize any valid ISBN during `prepareBookWrite`, even when the user did not press the current `Look up` button. Preserve a non-empty invalid value for the existing `/isbns` repair flow, but never use it for catalog identity. Catalog matching uses only a checksum-valid normalized ISBN-13.

## Catalog search

Add a signed-in `catalog-search` callable with a bounded request and response:

```ts
interface CatalogSearchRequest {
  isbn13?: string;
  title?: string;
  authorNames?: string[];
}

interface CatalogSearchResult {
  workId: string;
  editionId: string | null;
  confidence: 'exact-edition' | 'strong-work' | 'possible-work';
  reason: string;
  work: CatalogWorkSummary;
  edition: CatalogEditionSummary | null;
}
```

Exact ISBN lookup reads `isbnIndex/{isbn13}`. Exact title matching uses `titleKeys`; prefix search uses a bounded range query over `workTitleIndex.titleKey`. The function scores that small candidate set with the supplied authors and returns only active, searchable works. A title-and-author result selects the Work only and never assigns an arbitrary Edition; Edition metadata is inherited automatically only from exact identifier evidence. One `normalizeTitle` implementation defines punctuation, whitespace, diacritics, and supported leading-article handling. The client, function, and migration must share it or use agreement fixtures that fail when their copies diverge. Do not scan every personal book or expose personal-book metadata through search.

Protect catalog search with the repository's existing callable quota mechanism, a fixed instance cap, the functions runtime service account, strict request decoding, and a bounded result count. The implemented boundary is 60 searches per account per hour and a 100-title-search-per-hour global spend breaker. Exact ISBN and external-ID hits return before the global breaker; only the bounded title-index path consumes it. Cache author hydration within one request so repeated candidates and response construction read each shared author only once. Do not return reader counts from search unless those counts include only users who opted in.

At the current scale, Firestore is enough. Revisit a dedicated search service only when prefix queries and alternate-title indexes stop returning good candidates or the catalog grows large enough that reads become material.

## Catalog creation and races

The initial release does not deploy an ordinary-user `catalog-create` endpoint: open-signup accounts are not a sufficient trust boundary for reserving shared ISBNs or provider IDs. If no existing work is selected, save the personal book unlinked. The bounded admin curation workflow may later create a work and link the unmatched books; a future trusted-contributor gate may safely expose a narrower creation flow.

For a valid ISBN, the function transaction reads `isbnIndex/{isbn13}` first. If it points to a searchable work, return that work and edition instead of creating a duplicate. If it points to an internal work, do not return private catalog metadata and do not let the ordinary create callable promote it; promotion is reserved for the consent-aware admin workflow. The caller may save unlinked. Otherwise, create the work, edition, ISBN mapping, and title-index rows atomically. An ISBN-less creation can race with another title-based creation, so duplicate works remain possible and the merge workflow is the repair path. Do not enforce title uniqueness.

The create request carries bounded bibliographic metadata only. It accepts only `https:` cover URLs. It never accepts a UID, reader count, progress, or session data from the client. The handler derives the caller identity from the verified callable context and logs no personal-book fields.

## Work page

Add an authenticated `/books/[workId]` route. The page shows the canonical work, known editions, and one row per shared reading attempt.

Catalog cover images remain third-party URLs. Render them with `referrerpolicy="no-referrer"`, matching the application's existing cover privacy rule.

One user may have multiple personal books linked to the work. Group those attempts under the same profile instead of discarding rereads.

Suggested row fields:

- Public username and display name.
- Reading status.
- The user's chosen page count.
- Edition ISBN when the user chose to share it.
- First recorded reading date.
- Finished date when it can be inferred.
- Calendar-day span.
- Active reading days.
- Tracked reading minutes.
- Count of reading sessions.
- Qualified pages per hour.
- Percent of the user's edition read per tracked hour.
- Tracking coverage.

The page should distinguish calendar speed from active reading time. Someone may finish in two calendar days but record six hours of reading. Both facts are useful.

## Metric definitions

Keep metric constants and semantics aligned with `src/lib/utils/sessions.ts`. The Functions package cannot currently import that client module because it has a separate CommonJS build rooted at `functions/src`. For the first version, implement the pure summary code deliberately on both sides and pin the copies with shared input and expected-output fixtures. Moving utility code into a third build target would cost more than the duplication here.

The current client date helpers use the machine's local timezone. A Cloud Function runs in UTC, so calling the same-looking helper there would produce different 3 AM day boundaries. Persist an IANA timezone in the user's sharing settings, initially captured from `Intl.DateTimeFormat().resolvedOptions().timeZone`, and make server summary functions take that timezone explicitly. Run tests with the process timezone set to UTC so an accidental local-time dependency fails.

### Start and finish

- `firstProgressAt` is the first reading or page-correction event for the personal book.
- `firstReadAt` is the first timed reading event and may be unknown.
- `finishedAt` is the final progress event for a currently finished book, following the current `finishedAtByBook` convention.
- If a book was added as finished and has no events, all reading dates are unknown. Do not use book creation time as a claimed reading date.

### Active time and days

- `trackedMinutes` is the sum of reading-event `timeRead`.
- `activeDays` and `sessionCount` use timed reading events only. Page-correction rows do not claim that reading happened on that day.
- `activeDays` uses the app's 3 AM day boundary in the reader's persisted timezone.
- `calendarDays` is the inclusive span from `firstProgressAt` to `finishedAt` and should be labeled `recorded span` in the UI.

### Speed

- Keep the current session qualification rules: at least five minutes and no more than 150 pages per hour.
- Require at least 60 qualified minutes before displaying a per-book speed, matching `BOOK_SPEED_MIN_MINUTES`.
- `pagesPerHour` is useful within similar editions but is sensitive to pagination.
- `editionPercentPerHour` is `qualified pages / personal page count / qualified hours * 100`.
- `trackingCoverage` is qualified tracked progress divided by the personal page count, capped only for display. The raw value should remain available to reveal rereading or unusual session data.

Show `Not enough tracked reading` when the denominator is missing or too little activity qualifies. Do not rank readers by a metric with poor coverage.

## Privacy model

Per-book sharing needs separate consent. A public profile does not currently imply consent to publish specific titles and reading dates.

Add an owner-scoped settings document keyed by UID:

```text
users/{uid}/settings/bookSharing
  profileUsername
  timeZone
  createdAt
  updatedAt
```

The document's existence means the owner opted into per-book summaries. `profileUsername` chooses the one public profile used as the row identity if an account owns several. `timeZone` defines the 3 AM reading-day boundary. Rules require the referenced profile to belong to the same UID and be public. The work endpoint repeats those checks each time and fails closed if the user root, settings document, or selected public profile is missing.

Keep the setting outside the profile document because cached clients overwrite profile documents wholesale. A profile rename updates `profileUsername` in the same batch. Deleting the selected profile disables sharing. The Auth deletion trigger explicitly deletes the settings document even though the endpoint would already fail closed, and the database audit reports orphaned settings.

The response may contain:

- Username and display name.
- Sanitized work-level reading summaries.

The response must not contain:

- Email addresses.
- Firebase UIDs.
- Firestore document paths.
- Raw session documents.
- Private profiles or readers who have not opted in.

Catalog search may reveal that a bibliographic work exists. Sign-in is not the privacy boundary because strangers can create accounts. No client may list the catalog, and reader counts and identities include only opted-in profiles.

## Work-reader endpoint

Add the signed-in `catalog-workreaders` callable:

1. Resolve any work merge redirect and require the canonical work to be active and searchable.
2. Build the bounded set containing the canonical work ID and every merged source ID.
3. Query the server-only `sharedWorkOwners` candidate projection for those IDs. Three Firestore triggers maintain this projection after book-link, sharing-setting, and public-profile changes; the migration backfills existing eligible rows.
4. Re-read every candidate's live account, UID-keyed sharing setting, selected owned public profile, and linked personal books. A stale projection never authorizes disclosure.
5. Drop all records without current consent or a current matching book.
6. Read bounded updates for the remaining personal books.
7. Compute and return bounded summary rows, marking quota-truncated responses as incomplete with an omission count.

Add ascending `COLLECTION` and `COLLECTION_GROUP` scopes to the `books.workId` field override in `firestore.indexes.json`, plus a collection-group index on `books.editionId`. The collection scope preserves owner-library duplicate checks; the collection-group scopes support bounded admin curation and integrity checks. Reader discovery uses the server-only projection described above.

Protect the callable with the existing quota mechanism, a fixed instance cap, the functions runtime service account, and strict request and response decoders. Log one structured summary per successful call with the canonical work ID, personal books read, opted-in rows returned, duration, and whether aliases were queried. Do not log titles, user identities, or raw session data.

Reading metrics remain computed on demand for correctness while their definitions are still changing. The implementation does use a minimal work-ID/UID candidate projection to avoid an unbounded collection-group scan; it contains no titles, profile names, dates, progress, or session data and is never trusted without live authorization checks. Owner-wide projection refreshes query at most 501 linked books, deduplicate rereads, and refuse fan-out above 500 linked books or 200 distinct works; they do not scan attacker-controlled unlinked books or the global catalog. Reader candidates are stably paginated in groups of ten. Combined with the five-reread and 201-update query ceilings, every owner on a returned page is fully handled within the 10,050-row update budget, so stale, oversized, or adversarial rows cannot permanently crowd out later readers. The global hourly breaker is 100 valid-work pages. Add a materialized reading-summary projection only if popular work pages become expensive; it would need updates after session create, edit, delete, book deletion, link changes, profile visibility changes, sharing changes, and work merges.

## Admin catalog curation

Extend the existing `/admin` area with a `/admin/catalog` route after the initial catalog migration has run. It inherits the current client-side route gate, but every read and mutation still goes through server-side admin callables. Firestore Rules continue to deny direct cross-user access from the browser. The fixed administrator UID and verified-email claim remain the real authorization boundary.

The current `adminCallable` accepts only an empty request. Refactor it to require a decoder and handler, with an option for recent authentication. The fixed order is authenticate, check administrator identity, check recent authentication when requested, decode, then handle. `overview` supplies the existing empty decoder. Catalog endpoints supply exact request decoders from `functions/src/decoders.ts`, so no endpoint can bypass the common gate to accept input.

The purpose of this tool is to keep catalog identity healthy across the complete database. It is not a general reader-surveillance page. Return only the personal-book fields needed to decide identity:

- The owning UID and book ID. The administrator already receives account UIDs and emails from the overview, so invented opaque keys would add a secret and no meaningful privacy.
- Title and resolved author names.
- Valid normalized ISBN when present, plus the raw ISBN only when it needs repair.
- Page count, publisher, publication date, and cover.
- Current `workId`, `editionId`, and catalog-link provenance.
- Book creation and metadata update timestamps for stale-write checks.

Do not return current page, finished status, pages read, time read, timers, reading dates, session counts, profile visibility, or raw update rows. Those fields do not help catalog matching.

Books under deleted or phantom users appear as anomalies and are excluded from automatic work-candidate operations. Author resolution follows shared catalog redirects and removes placeholder authors such as `Various Authors` from work identity scoring.

### Admin view

Use one page with sections rather than four separate screens:

1. `Authors` lists active and merged shared authors, alternate spellings, work counts, and audit warnings.
2. `Works` lists active and merged works with edition count, linked personal-book count, visibility, and audit warnings.
3. `Unmatched books` lists unlinked personal books across users, with exact and likely candidate works.
4. `Review findings` groups deterministic scan results such as duplicate authors, ISBN mappings, suspected duplicate works, broken links, edition mismatches, and conflicting titles or authors.
5. `Work detail` edits one selected work, its editions, aliases, visibility, and links. It also shows the personal books currently attached to that work.

One bounded `admin-catalogscan` endpoint computes the sections on demand at the current scale. The first release scans at most 200 works and 500 each of editions, ISBN indexes, and external-ID indexes. Create/upsert transactions refuse to cross those capacities; repair edits, merges, repoints, and unlinking remain available at capacity. Raise the caps only together with paginated or materialized review state. Do not create a persistent review queue until scans become slow enough to justify synchronization work.

### Admin actions

Use eight tagged operation types:

- `upsertAuthor` creates or edits a shared author, preserves a prior canonical name as an alias on rename, and rejects a normalized name already owned by another active author.
- `mergeAuthors` compresses shared author aliases and rewrites all affected works and personal books.
- `createWork` creates an internal or searchable work from selected unmatched books.
- `linkBooks` sets a target work and optional edition, moves or splits records by choosing a different target, or unlinks by choosing null.
- `mergeWorks` compresses source aliases into one active target and rejects a result with more than 29 merged IDs.
- `editWork` changes canonical metadata and includes an explicit visibility-promotion option.
- `upsertEdition` creates or edits an edition; changing `workId` moves it without changing its ID.
- `repointIsbn` clears the old edition's ISBN and updates the new edition and index atomically.

Link and repair operations change only catalog-link fields on personal books. They never rewrite the user's title, authors, ISBN, page count, progress, timestamps that drive reading-list order, or reading sessions. If a personal metadata correction is ever needed, design it as a separate explicit operation with its own preview and consent policy.

Works reference shared author IDs. The admin UI owns canonical-name changes, alternate spellings, kind and sort-name corrections, and merges. A merge retains one-hop redirects and rewrites all affected works and personal books before retiring the source. Personal author documents are migration-only legacy state and are removed once no personal book references them.

An internal work becomes searchable only through an explicit promotion action. External verification proves the bibliographic metadata but does not prove consent to disclose that a reader in this app chose the book. Promotion is allowed only when the work has a linked record from the operator or from a library with current live sharing consent. A historical ISBN, external-ID, catalog-choice, migration, or admin link is not durable disclosure consent. Otherwise obtain consent first.

### Preview, apply, and recovery

Every mutation uses a two-step flow:

1. A preview endpoint resolves redirects, validates the selected books and editions, and returns the exact catalog and link changes.
2. An apply endpoint repeats every validation against current data and commits only if the expected work versions and personal-book link fields still match.

The preview is informative, not a lock. It returns an `operationId`, catalog document update times, and the expected current link fields for each personal book. Apply echoes `operationId`, repeats validation, uses update-time preconditions for catalog documents, and compares only personal-book link fields. A concurrent user title edit should not block an admin link, while a deleted or relinked book must reject the stale operation.

Cap one operation at 200 touched documents and commit it in one transaction. Reject anything larger with a clear message. Do not build chunked resumable operations for the current database size.

Never hard-delete a work that may have references. Merge it into an active target and repoint the source plus all of its prior aliases directly to the target in the same transaction. Edition moves and ISBN repoints update the edition and ISBN index atomically. Title changes and merges update all affected title-index rows in the same transaction.

Each successful mutation writes its `adminAudit` row inside the same transaction. The row contains the operation type, administrator UID, operation ID, counts, timestamp, `expiresAt`, and a bounded before-and-after record for catalog fields, personal-book link fields, ISBN-index rows, and title-index rows touched. Store no session data. Apply first checks for the operation ID and returns the recorded result on retry, so a client timeout cannot apply the operation twice.

The audit record supplies the pre-state needed to construct a forward repair with the same six operations. It is not a literal undo because users may link new records after a merge. Keep the current 365-day audit retention as the recovery window unless operations approach the document size limit. Read-only admin calls keep the current successful-view audit. Mutation calls write only their transactional operation audit, so they do not produce a second generic view row. Denied calls continue to use Cloud Logging under the existing policy.

Require recent authentication for catalog mutations, in addition to the existing immutable UID and verified-email checks. Read-only catalog calls may use the ordinary admin gate. Mutation wrappers compare the server's current epoch seconds with `context.auth.token.auth_time`, require an age of at most 900 seconds, and allow a small documented clock skew. Token refresh does not update `auth_time`.

Add password reauthentication to `src/lib/firebase/auth.ts` with `reauthenticateWithCredential` and `EmailAuthProvider.credential`. After the administrator gate succeeds, an old token produces a dedicated `failed-precondition` reason that prompts the catalog UI for the password and retries with a new ID token. Non-administrators still receive only `not-found`.

### Admin API shape

Keep admin functions in `functions/src/admin.ts` so every endpoint inherits the refactored wrapper by construction. Use three endpoints:

- `admin-catalogscan`
- `admin-catalogpreview`
- `admin-catalogapply`

The final Firebase export names follow the repository's grouped export convention. All three use `ADMIN_MAX_INSTANCES`, currently 2, so read-heavy scans can queue behind one another. Add every endpoint to the exact function-export, runtime identity, instance-cap, secret-binding, and audit tests. Mutation decoders use the eight-operation tagged union rather than accepting arbitrary Firestore patches or paths.

## Migration

Follow the repository migration playbook. The migration must be read-only by default, require `--prod --apply` plus production confirmation for writes, avoid touching book `updatedAt`, and be idempotent.

Use deterministic IDs for migration-created works and editions, based on a reviewed group key and normalized ISBN where available. IDs remain opaque after creation. Interactive ISBN-less work creation may use an operation-based generated ID because title uniqueness is not safe. Create ISBN-index documents with create-only transaction semantics so concurrent or repeated runs cannot overwrite a mapping. Extend the migration writer with `create` support or keep these writes in explicit transactions.

Suggested passes:

1. Resolve every legacy personal-author redirect and create deterministic shared author rows, including placeholders used by personal books.
2. Build candidate work groups using valid ISBNs.
3. Add normalized title and resolved non-placeholder author matches.
4. Add reviewed alternate-title and translation mappings.
5. Print ambiguous groups without linking them.
6. Create works, editions, and ISBN index entries from the operator's library, opted-in libraries, and external bibliographic records. Do not seed unique works solely from private users.
7. Rewrite resolvable personal-book `authorIds` to shared IDs, including explicit reviewed spelling corrections. Every reviewed group must carry positional `authorKinds`; decoding keeps each name and kind paired through normalized deduplication and sorting, so an entity or placeholder never silently becomes a person. Author-kind conflicts, personal shadows over six authors, and work identities over 20 authors remain unlinked and retain their legacy rows for review. Add `workId`, `editionId`, and migration provenance to unambiguous personal books when the matching work already exists, and explicit null link fields to every unmatched personal book. Linking a private record does not make its reader visible.
8. Delete legacy personal-author documents only after a transaction confirms every book under that user has shared IDs and no legacy author field.
9. Run the database audit and a second migration dry run.

The 18 known cross-user works should become explicit migration fixtures or acceptance assertions. These include spelling and translation cases such as:

- `Gul bok`, including one misspelled author.
- `The Hitchhiker's Guide to the Galaxy` with punctuation and article differences.
- `The Unbearable Lightness of Being` and `Tilværelsens uutholdelige letthet`.

Treat the misspelled-author `Gul bok` case as an explicit reviewed fixture, not permission to use fuzzy author matching generally. Do not force ambiguous same-title books into one work. Leave them unlinked for review.

Extend `db-audit.ts` before the production apply. It must check that every non-null book `workId` resolves through exactly one redirect at most; each edition's work resolves to the same canonical work as the linked book; every ISBN index target exists and agrees with the edition's nullable ISBN; books linked through ISBN provenance still agree with the current ISBN mapping; merged works point directly to an active target; canonical `mergedFrom` lists agree with source redirects; every title-index row targets an existing work; and no catalog merge cycle exists.

Run the initial migration, audit, and repair pass before building `/admin/catalog`. That one-off script handles the known 18 overlaps with the repository's existing snapshot, dry-run, confirmation, and idempotence controls. Build the UI afterward for residual and ongoing curation, informed by the operations the migration actually needed.

## Implementation phases

### Phase 1: catalog foundation

- Add work, edition, and catalog-link interfaces and decoders.
- Add shared author interfaces, redirects, strict decoding, and the bounded author-resolution callable.
- Add catalog collections, Rules, indexes, and callable request decoders. Deploy the `books.workId` indexes before dependent functions.
- Add both `COLLECTION` and `COLLECTION_GROUP` ascending scopes to the `books.workId` field override so owner queries and cross-user queries both retain an index.
- Extend the page-count clamp allowlist and add catalog reference checks without crossing Firestore's rules document-access limit.
- Update `rules-shape.ts` and its agreement tests with the new book fields.
- Implement exact ISBN lookup and bounded searchable-title suggestions. Ordinary accounts may only select an existing searchable work; catalog creation stays server-owned and administrator-only.
- Extend the add and edit modal with catalog selection.
- Preserve offline saving with nullable catalog links.
- Preserve offline saving for books that use cached shared authors; explain that a new shared author needs a connection.
- Add a way to relink and unlink a personal book.
- Write link fields on edit only when the user changed them.

### Phase 2: migration and repair

- Build the dry-run migration and deterministic report.
- Seed works and editions from the operator's library, consented libraries, and external records.
- Link unambiguous existing personal books.
- Run the production migration, audit, and second dry run before starting the admin UI.
- Add `/admin/catalog` with bounded work, unmatched-book, review, and detail views.
- Refactor `adminCallable` to require a decoder and optional recent-auth policy.
- Add `catalogscan`, `catalogpreview`, and `catalogapply` with eight tagged mutation types and a 200-document transaction cap.
- Require recent authentication for admin catalog mutations and record recovery audit details in the mutation transaction.
- Extend the database audit with catalog and redirect invariants.
- Confirm the 18 known overlaps resolve as expected.

### Phase 3: private work page and metrics

- Add `/books/[workId]` for the signed-in user's own linked attempts.
- Implement client and server work-summary calculations against shared fixtures.
- Link book titles or a simple `Linked` indicator from current and finished book lists. Reader-count badges wait for a cheap server projection.

### Phase 4: consent and cross-user rows

- Add UID-keyed per-book sharing settings, a chosen profile username, an IANA timezone, and profile controls.
- Update profile rename, visibility, profile deletion, and Auth deletion flows.
- Add the `catalog-workreaders` callable and minimal owner-candidate projection with strict response decoding and live consent rechecks.
- Show opted-in reader summaries on the work page.
- Add privacy-focused emulator and function tests.

### Phase 5: operational refinement

- Measure callable reads, latency, and popular work-page traffic.
- Measure the candidate projection's bounded refresh cost and callable update reads. Paginate or redesign owner refresh before legitimate accounts approach 500 linked books or 200 distinct works.
- Add materialized reading-summary projections only if on-demand metric computation becomes expensive.
- Revisit search infrastructure only if catalog query quality or cost warrants it.
- Register every new function in the exact export and runtime-tier tests, document its cap, and update the architecture inventory.

## Main code areas

- `src/lib/interfaces/book.ts`
- New catalog interfaces under `src/lib/interfaces/`
- `src/lib/firebase/db.ts`
- `src/lib/firebase/auth.ts`
- `src/lib/firebase/functions.ts`
- `src/lib/firebase/decoders.ts`
- `src/lib/components/NewBookModal.svelte`
- `src/lib/components/BookList.svelte`
- New route at `src/routes/books/[workId]/+page.svelte`
- New route at `src/routes/admin/catalog/+page.svelte`
- New function module under `functions/src/`
- `functions/src/admin.ts`
- `functions/src/decoders.ts`
- `functions/src/index.ts`
- `functions/src/quota.ts` and `functions/src/runtime.ts`
- `functions/test/triggers.test.cjs`
- `functions/test/admin-overview.test.cjs` and new catalog tests
- `firestore.rules`
- `rules-shape.ts`
- `firestore.indexes.json`
- `db-audit.ts`
- A new migration script plus `MIGRATIONS.md`
- Architecture diagrams and route/function inventories

## Test plan

### Matching tests

- ISBN-10 and ISBN-13 normalize to the same edition mapping.
- Different ISBNs can map to the same work.
- Exact title and author produce a suggestion.
- Punctuation, case, and diacritics do not prevent a suggestion.
- Alternate and translated titles resolve through explicit aliases.
- Same title with a different author never auto-links.
- Fuzzy matches remain suggestions and never create links without confirmation.
- Client, function, and migration title normalization pass the same fixtures.
- A bad ISBN mapping can be repointed without leaving a dangling edition.
- Two simultaneous creates for one ISBN return one edition mapping.
- Simultaneous ISBN-less creates may produce repairable duplicate works and never corrupt the title index.

### Personal-data tests

- Linking never changes a personal title, page count, progress, or timestamps.
- An edition page count fills an empty add form but never overwrites entered data.
- Unlinked books remain valid and fully usable offline.
- A user can add the same work as a reread.
- Work merges preserve links through redirect resolution.
- Books linked to merged source IDs appear on the canonical work page and in the user's duplicate warning.
- A metadata edit that did not change the link cannot restore a stale link.
- A link plus page-count clamp succeeds atomically, while a reading-session batch cannot change link fields.

### Privacy tests

- Another client cannot read personal books or updates directly.
- A signed-in stranger cannot list works, editions, ISBN mappings, or another user's sharing settings.
- A private profile never appears on a work page.
- A public profile without sharing settings never appears.
- Sharing settings that name a profile owned by another UID fail Rules and endpoint checks.
- Disabling profile visibility immediately removes the reader from function output.
- Disabling book sharing immediately removes the reader from function output.
- Function responses never include UID, email, owner references, or raw sessions.
- Profile rename, profile deletion, and account deletion update or remove sharing settings.
- Privacy tests run end to end against the emulators, not only against pure response helpers.

### Metric tests

- Cross-user summaries use the 3 AM boundary in the reader's persisted IANA timezone, including when the function process runs under `TZ=UTC`.
- Session qualification constants and outputs match current personal analytics through agreement fixtures.
- Calendar span, active days, tracked minutes, and finish date handle session edits and corrections.
- Page corrections affect progress dates but do not count as timed sessions or active reading days.
- Added-as-finished books with no events report unknown dates.
- Different page counts produce different pages-per-hour context without changing work identity.
- Fewer than 60 qualified minutes and low coverage suppress speed and rankings.

### Migration tests

- Dry run performs no writes.
- Apply is idempotent.
- Existing book `updatedAt` values remain unchanged.
- Ambiguous matches remain unlinked.
- ISBN index entries are unique and point to existing works and editions.
- Author merge redirects resolve before matching, and placeholder authors do not create identity evidence.
- Every merged source points directly to an active canonical work, editions belong to their resolved work, and canonical alias lists agree with merged source docs.
- Unmatched legacy books receive explicit null catalog-link fields, while the transitional decoder treats missing fields as null.
- A post-migration audit reports no new drift.

### Admin curation tests

- Every catalog endpoint rejects non-admin, unverified, and signed-out callers before privileged reads.
- The refactored wrapper checks authorization before decoding and requires a decoder for every endpoint.
- Mutation endpoints reject an otherwise valid admin token whose `auth_time` is older than 15 minutes, while a fresh password reauthentication permits the retry.
- Clients cannot read or mutate cross-user books directly through Firestore Rules.
- Clients cannot get or link to internal works and editions.
- An exact ISBN collision with an internal work reveals no private catalog metadata; promotion requires a separate confirmed, consent-eligible action.
- Admin list responses omit progress, reading totals, timers, profile visibility, and session data.
- Preview performs no writes and apply repeats all version and link checks.
- Apply rejects a book deleted or relinked after preview, but a concurrent user title edit does not block an otherwise valid link operation.
- A concurrent owner relink and admin apply cannot silently overwrite each other.
- Linking, moving, and splitting change only catalog-link fields and preserve book `updatedAt`.
- Work merge compresses pre-existing redirects to one hop, updates catalog indexes, and records enough pre-state for a later forward repair.
- A merge that would produce more than 29 aliases rejects without writes.
- ISBN repoint leaves exactly one valid mapping, clears the old edition's nullable ISBN, and records the old index state.
- Moving an edition changes its `workId` without changing its ID, and existing personal-book edition links remain valid.
- Mutation payloads cannot name arbitrary Firestore paths or fields.
- Operations touching more than 200 documents reject before writes.
- Retrying one `operationId` returns the committed result without applying twice.
- The catalog mutation and its single bounded audit record commit in the same transaction, with no generic duplicate view audit and no reading-session data.
- Rules-shape agreement tests include catalog-link fields, and timer Rules budget probes retain their current margin.
- Emulator tests exercise preview and apply contention against real Firestore transactions rather than only mocked handler helpers.

## Risks and trade-offs

- Work identity is subjective for translations, revised editions, collected volumes, and abridgements. Explicit links and merge redirects make mistakes repairable.
- One personal book links to one catalog work. An omnibus or anthology can be a catalog work in its own right, but the first version does not link it to each contained work.
- On-demand session reads cost more than materialized summaries. The minimal candidate projection bounds discovery cost, while live checks and on-demand metrics keep consent and calculations correct.
- Client-writable catalog links allow a user to choose the wrong work. This is a data-quality problem, not a cross-user read permission. Keep catalog metadata server-owned and add repair tools.
- Exact reading dates reveal more than current public profiles. Separate opt-in consent is worth the extra UI and Rules work.
- Page-based speed remains imperfect across typography and formats. Show active time and calendar span beside it, and avoid a single fastest-reader leaderboard.
- Catalog work existence can disclose that somebody introduced a rare title. Prevent work enumeration, state this consequence when linking, and do not seed unique works from private libraries without consent. Shared author enumeration is accepted by product policy.
- A work can accumulate more merge aliases than one Firestore `in` query accepts. Reject merges above 29 aliases so every reader and admin query stays within one `in` query.
- The admin catalog can inspect bibliographic fields from private books. Keep its response narrower than the existing Admin SDK access, audit every mutation, and do not turn it into a reading-history browser.
- Reversible audit details add storage and may contain private book titles. Restrict them to the administrator, bound their size, and retain them only for the defined recovery window.

## Implemented first-release decisions

1. Should work pages require authentication, or should opted-in summaries also be publicly accessible?
2. Should sharing expose exact dates, month-level dates, or only durations?
3. Should ISBN be visible on shared reader rows?
4. Should an existing public profile be required before enabling per-book sharing, and which profile represents an account that owns several?
5. Who may merge catalog works and correct shared metadata?
6. Should rereads be modeled as separate personal books for now, or should a later reading-attempt entity be introduced?
7. How recent must administrator authentication be before a catalog mutation?
8. Should externally verified internal works become searchable automatically, or only after a separate promotion action?

The implementation uses authenticated work pages, exact day-level dates only after explicit consent, hidden ISBNs on reader rows, one explicitly selected owned public profile, administrator-only catalog creation/edits/merges, separate personal-book records for rereads, a 15-minute recent-authentication window for admin mutations, and explicit promotion of internal works. Authentication controls access to the page but is not treated as secrecy because sign-up remains open.

The admin console scans personal books in bounded pages, suggests exact ISBN/title and likely matches, and supports author create/edit/merge plus work create/edit/link/unlink/merge, edition moves, and ISBN repoints through preview/apply transactions. Invalid low-level catalog shapes are release-blocking `db-audit.ts` findings and require an operator repair rather than an arbitrary document editor in the browser.

The migration may seed public work and edition metadata only from the operator's live books or from a currently consented user's book. It rechecks the source book, live account, exact sharing setting, and owned public profile inside the same transaction that creates those public catalog documents, so consent revocation or book deletion wins the race. Shared authors may be consolidated from every resolvable personal book. Their source book and legacy author versions are pinned transactionally, all personal books are rewritten to catalog author IDs, and legacy per-user author documents are deleted only after an atomic read proves none remain referenced.
