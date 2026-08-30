# Book Tracker architecture guide

Book Tracker is a private, offline-capable reading tracker with opt-in public profiles and optional Toggl synchronization. This guide explains how requests move through the app, where security is enforced, which code owns each responsibility, and what to update when the system changes.

Last audited: 2026-08-29 against the cross-user works implementation branch. Run `node docs/architecture/verify.mjs` to check the current route and function inventory.

## Quick facts

| Item | Value |
|---|---|
| Production | [book.ankile.com](https://book.ankile.com) |
| Firebase project | `book-tracker-d8f24` |
| Web app | Static SvelteKit SPA, installable PWA |
| Public profiles | Server-rendered by `publicweb`, then hydrated by the SPA |
| Firestore | `eur3`, with IndexedDB multi-tab persistence in the browser |
| Cloud Functions | `europe-west1`, Node.js 22, Gen 1 and Gen 2 |
| Local app | `npm run dev`, normally `http://localhost:5173` |
| Local Firebase stack | `npm --prefix functions run serve`, then `VITE_EMULATOR=1 npm run dev` |
| Emulator ports | Auth `9099`, Firestore `8080`, Functions `5001`, Emulator UI `4000` |

Six facts explain most of the design:

- Private library data lives below `users/{uid}`. The browser can read or change only its owner's data, and Firestore Rules validate correlated book, page, session, and timer updates.
- The service worker caches the app shell. Firestore persists data in IndexedDB, so normal writes can be accepted offline and sent later.
- Public sharing is separate from search discovery. `profiles/{username}` holds the profile, while `profileDiscovery/{username}` is the explicit search opt-in.
- Shared works are server-owned bibliography. A personal book keeps its own title, page count, progress, and sessions, and may hold a nullable link to one work and edition. Reader comparisons require a separate `users/{uid}/settings/bookSharing` consent document and an owned public profile.
- Browser Firestore access goes through Security Rules. Functions use the Admin SDK and bypass those rules, so IAM service accounts are the relevant boundary there.
- Hosting and `publicweb` share a generated Svelte shell. They must be built and deployed together because Hosting pins a specific Cloud Run revision.

## Diagram guide

Each diagram answers one question and stays small enough to read at normal screen width. SVG is best for inspection and sharing. Mermaid is the editable source.

| View | Question |
|---|---|
| [System context](system-context.svg) | Who uses Book Tracker, and which outside systems does it depend on? |
| [Containers and trust boundaries](app-architecture.svg) | Where does code run, and which security mechanism controls each connection? |
| [Backend paths](backend-runtime.svg) | What invokes every function, and what data or API does it touch? |
| [Pages and navigation](site-functionality.svg) | How do people move through the site, and which dialogs or local actions open from each page? |
| [Route access matrix](site-access.svg) | Who can read each route, what can be changed there, and how is it reached? |

### System context

[SVG](system-context.svg) · [Mermaid](system-context.mmd) · [PNG](system-context.png)

![Book Tracker system context](system-context.svg)

### Containers and trust boundaries

[SVG](app-architecture.svg) · [Mermaid](app-architecture.mmd) · [PNG](app-architecture.png)

![Book Tracker container and trust boundaries](app-architecture.svg)

### Backend request and event paths

[SVG](backend-runtime.svg) · [Mermaid](backend-runtime.mmd) · [PNG](backend-runtime.png)

![Book Tracker backend request and event paths](backend-runtime.svg)

### Pages and navigation

[SVG](site-functionality.svg) · [Mermaid](site-functionality.mmd) · [PNG](site-functionality.png)

![Book Tracker pages and navigation](site-functionality.svg)

### Route access matrix

[SVG](site-access.svg) · [Mermaid](site-access.mmd) · [PNG](site-access.png)

![Book Tracker route access matrix](site-access.svg)

## Request paths worth knowing

### Signed-in or offline book write

1. A page or dialog writes through `src/lib/firebase/db.ts` or `readingSessionWrites.ts`.
2. The Firebase SDK first updates its local IndexedDB-backed view. An offline user can keep working.
3. After connectivity returns, Firestore evaluates the write against `firestore.rules`. Book aggregates and their corresponding update row move in one atomic batch.
4. A server rejection arrives later. The app reports the failed operation in its error UI; issue telemetry is not queued while offline.

Deleting a book is different from editing one. The client deletes the book document, then Eventarc invokes `deletebookupdates` to recursively remove that book's `updates` subcollection.

### Public profile HTML and JSON

1. Firebase Hosting rewrites `/profiles/**` and `/sitemap.xml` to the pinned `publicweb` Gen 2 revision.
2. `publicweb-runtime` reads the profile and optional discovery marker with the Admin SDK.
3. A public profile returns cached HTML or a UID-free JSON projection. A private or missing profile returns the same 404 response.
4. The SPA hydrates the returned shell. If the signed-in viewer owns a private profile, the browser can then read the raw document through Firestore Rules and render it client-side. The public JSON endpoint itself never serves private profiles.

### Shared catalog and reader summaries

1. The add/edit dialog makes bounded, signed-in calls to `catalog-search`. Exact ISBN or trusted external-ID matches may be preselected; title matches remain explicit choices. A 60-search/account quota is backed by a 100-title-search/hour global breaker, charged only after exact identifier lookups miss.
2. The browser writes only the nullable link fields on its own personal book. Rules require an active searchable work and a matching edition, while ordinary progress/timer writes avoid those catalog reads. If no suggestion is chosen, saving remains offline-capable and the book stays unlinked. Existing cached authors preserve that path; a genuinely new author is resolved before the optimistic write begins, so an offline or quota failure leaves the dialog and draft open without queuing a partial book.
3. Works, editions, and their indexes are admin-owned. Verified live accounts read the shared author list and use the bounded `catalog-ensureauthors` callable to resolve or create a genuinely missing author. The global creation breaker counts only missing names, and the transaction enforces the 500-author operating capacity. Only `/admin/catalog` may rename or merge authors, and those merges rewrite both works and personal books.
4. Three Gen 2 triggers maintain `sharedWorkOwners`, a server-only work-ID/UID candidate projection. The migration also backfills it. Owner-wide refreshes query at most 501 linked books, deduplicate rereads, and refuse fan-out above 500 linked books or 200 distinct works; they never scan an attacker's unlinked books or the global catalog. Profile privacy and deletion Rules require the selected sharing setting to be removed or atomically repointed.
5. `/books/[workId]` calls `catalog-workreaders`. The function resolves one-hop aliases, pages projection candidates stably in groups of ten, then rechecks the live book, consent setting, account, and owned public profile before reading updates. The page size is deliberately aligned with the five-reread and 201-update ceilings so every owner in a page is handled within the total read budget. It returns date-only summaries and omits UID, email, ISBN, raw updates, and unqualified speed values. A bounded partial result is marked `incomplete` with an omission count; later candidate pages remain reachable with a cursor. The global breaker allows 100 valid-work pages per hour, preserving the prior worst-case read envelope while invalid work IDs are excluded from it.
6. `/admin/catalog` uses paginated, bounded admin callables. Mutations require recent authentication, preview before apply, a strict eight-operation union, stale-state checks, and one transaction that includes the recovery audit row. Creation and edition upserts transactionally refuse to cross the scan capacities (500 authors, 200 works, and 500 each of editions, ISBN indexes, and external-ID indexes), while repair edits, merges, repoints, and unlinking remain available at capacity.

Profile HTML, instance caches, the Hosting CDN, and browser caching mean a privacy change is not instant. The detailed cache ceilings and sitemap behavior live in [the root README](../../README.md#public-profile-search-indexing).

### Toggl timers and offline recovery

Online timer and token operations use Gen 1 callables. Each handler requires a Firebase ID token and stores the active timer claim with the relevant book. The browser never receives a privileged server credential.

When an offline stop cannot reach Toggl, the client atomically clears or changes its local timer state and writes a bounded `togglQueue` row. IndexedDB holds that batch until reconnect. The Firestore write then triggers `toggl-syncqueue`, which claims the row, enforces a server quota, creates or patches the Toggl entry, and records a recoverable status. Successful rows are deleted. Terminal failures receive a 90-day TTL unless the row must remain as the recovery handle for a correlated stop.

## Security boundaries

| Boundary | Real enforcement | Important consequence |
|---|---|---|
| Private page navigation | Root Svelte layout and route code | This is user experience, not the data-security boundary. |
| Browser to Firestore | Firebase ID token plus `firestore.rules` | Rules enforce owner scope and multi-document invariants. Offline acceptance is provisional until the server evaluates the write. |
| Browser to callable | Publicly invokable endpoint; handler checks the ID token and request shape | An unauthenticated request can incur an invocation before rejection. Instance caps bound cost and fan-out. |
| `/admin` and `/admin/catalog` | Client layout hides the pages; every admin callable checks one UID and a verified email | The server check is authoritative. Catalog mutations also require `auth_time` within 15 minutes, preview/apply validation, and a transactional audit; denials look like not-found. |
| Shared-work reader rows | `catalog-workreaders`, a server-only candidate projection, and live consent/profile checks | Authentication alone does not expose a library. A stale projection cannot authorize disclosure: every row requires the live UID-keyed setting, its selected owned public profile, and a currently linked book. Responses contain no UID, ISBN, or raw session rows. |
| Public HTTP | Hosting rewrite plus `publicweb` visibility checks | Private and missing usernames are deliberately indistinguishable. |
| `publicweb` to Firestore | `publicweb-runtime` with `roles/datastore.viewer` | It cannot write, access Auth, or read secrets. Firestore IAM cannot restrict it by collection, so it can technically read the entire database, including stored Toggl tokens. |
| Other functions to Firebase | `functions-runtime` with Firestore write, Auth viewer, Eventarc, Run invoker, and one secret binding | Admin SDK access bypasses Firestore Rules. IAM and handler checks must be reviewed with every new function. |
| Firestore-triggered Gen 2 functions | Eventarc with internal-only ingress | They accept event delivery from Google's network, not public HTTP traffic. |
| Cloud Storage | Deny-all `storage.rules` | The app does not use Storage, and clients cannot use the bucket as file hosting. |

## Firestore ownership and lifecycle

| Path | Purpose | Browser access | Function access and cleanup |
|---|---|---|---|
| `users/{uid}` | Account identity, Toggl configuration | Owner read; no client create, update, or delete | Auth trigger creates root. Toggl callables update configuration. Auth deletion trigger deletes only this root document. |
| `users/{uid}/books/{bookId}` | Books, aggregate progress, active timer | Owner read/write with strict validation | Functions read/write timer state. Book deletion triggers recursive update cleanup. |
| `users/{uid}/books/{bookId}/updates/{updateId}` | Reading sessions and page corrections | Owner read/write; owner-scoped collection-group reads | `deletebookupdates` recursively removes rows after their book is deleted. |
| `catalogAuthors/{authorId}` | Shared canonical authors, alternate names, and one-hop redirects | Verified live-account read/list; no browser writes | `catalog-ensureauthors` resolves or creates missing rows. Admin preview/apply owns edits and merges. Book Rules verify up to six unique references; cached one-hop aliases remain valid. |
| `users/{uid}/authors/{authorId}` | Legacy personal author state | No browser access | The catalog migration rewrites book references and deletes these documents after a transactional no-reference check. |
| `users/{uid}/timerLifecycle/current` | Cross-book timer claim | Owner read and narrowly validated transitions | Toggl callables own remote claim transitions. |
| `users/{uid}/togglQueue/{queueId}` | Offline create/stop work | Owner read, create, and bounded retry requests | `toggl-syncqueue` claims and writes status. Successful rows are deleted; eligible terminal rows have a 90-day TTL. |
| `users/{uid}/functionQuotas/{name}` | Callable and queue rate windows | No client access | Functions own all reads and writes. |
| `users/{uid}/settings/bookSharing` | Per-account consent, chosen public profile, and IANA timezone | Owner get/create/update/delete only; exact Rules shape | Catalog reader summaries read it. Projection triggers refresh the owner's candidates; profile rename moves it atomically; profile/account deletion removes it. |
| `works/{workId}` | Canonical works, aliases, visibility, and one-hop merge redirects | Signed-in direct get only when active and searchable; never list or write | Catalog/admin callables create and curate. Migration may create internal works. |
| `editions/{editionId}` | Edition metadata and its owning work | Signed-in direct get only when its work is active and searchable; never list or write | Catalog/admin callables create, move, and edit. Page count is advisory only. |
| `isbnIndex/{isbn13}`, `externalIdIndex/{id}`, `workTitleIndex/{id}` | Server-owned matching indexes | No browser access | Catalog search and admin/migration transactions maintain them. Title rows carry work visibility so internal records cannot crowd public suggestions. |
| `sharedWorkOwners/{hash}` | Work-scoped UID candidates for reader lookup | No browser access | Three Firestore triggers and the migration maintain it. `catalog-workreaders` treats it only as a candidate and rechecks all live authorization state. |
| `functionGlobalQuotas/{name}` | Emergency global callable circuit breaker | No browser access | Functions own all reads and writes; per-user quota remains the primary abuse boundary. Reader calls consume their breaker only after resolving a real searchable work. Title search consumes its breaker only after exact ISBN/external-ID paths miss. Author resolution meters all requested names per user but charges its breaker only for missing authors created transactionally. |
| `profiles/{username}` | Public or private profile document | Owner raw read and CRUD only | `publicweb` reads it and emits a bounded public projection without the Firebase UID. Auth deletion removes matching profiles. |
| `profileDiscovery/{username}` | Explicit search-engine opt-in | Owner can get, create, or delete its marker; clients cannot list | `publicweb` lists markers for the sitemap. Auth deletion removes matching markers. |
| `logEvents/{id}` | Allowlisted client and function issues | No client access | Telemetry writes; admin reads. TTL owns retention. |
| `adminAudit/{id}` | Successful admin views and bounded catalog mutation recovery records | No client access | Admin function writes. Mutation audit commits with the mutation; TTL owns 365-day retention. |

Firestore does not cascade when `users/{uid}` is deleted. `deleteUserDocument` removes the sharing setting first, then the root account document, owned profiles, and discovery markers. Books, updates, legacy author rows, `timerLifecycle`, and `togglQueue` subcollections remain until an operator removes them with the Admin SDK. Follow the account-disable and session-revocation sequence in [Abusive or compromised accounts](../../README.md#abusive-or-compromised-accounts) before deleting an Auth user.

## Deployed function inventory

All function regions are `europe-west1`.

| Deployed name | Generation and trigger | Authorization | Main dependencies |
|---|---|---|---|
| `publicweb` | Gen 2 public HTTP | Public visibility rules in handler | Profiles, discovery markers, generated profile shell, Hosting cache |
| `booksapi-lookupisbn` | Gen 1 callable | Signed-in handler, 60 lookups per user per hour | Secret Manager, Google Books, function quota |
| `catalog-search` | Gen 1 callable | Signed-in handler, strict bounded request, 60 searches/account/hour plus 100 title searches/hour globally | Works, editions, shared author hydration cache, server-owned matching indexes |
| `catalog-workreaders` | Gen 1 callable | Verified signed-in handler, searchable-work and live consent checks, per-user quota | Catalog aliases, server-only owner projection, private books/updates, sharing settings, public profiles |
| `telemetry-reportissue` | Gen 1 callable | Signed-in handler, allowlisted payload, 20 reports per user per hour | Issue quota, `logEvents` |
| `admin-overview` | Gen 1 callable | Fixed UID and verified email | Auth Admin API, library aggregates, `logEvents`, `adminAudit` |
| `admin-catalogscan` | Gen 1 callable | Fixed UID and verified email | Bounded bibliographic/catalog projection, view audit |
| `admin-catalogpreview` | Gen 1 callable | Fixed UID and verified email | Strict operation decoding and current-state validation |
| `admin-catalogapply` | Gen 1 callable | Fixed UID, verified email, and recent authentication | One catalog transaction, indexes, personal links, mutation audit |
| `toggl-savetoken` | Gen 1 callable | Signed-in handler | Toggl user/project lookup, `users/{uid}` |
| `toggl-cleartoken` | Gen 1 callable | Signed-in handler; timer must be idle | `users/{uid}`, timer lifecycle |
| `toggl-start` | Gen 1 callable | Signed-in handler | Book and timer claim transaction, Toggl create |
| `toggl-stop` | Gen 1 callable | Signed-in handler | Toggl stop, book and timer claim cleanup |
| `toggl-clearstopping` | Gen 1 callable | Signed-in handler plus explicit recovery conditions | Book, timer claim, and matching queue row |
| `createUserDocument` | Gen 1 Auth `onCreate` | Firebase Auth event | Account root and idle timer lifecycle |
| `deleteUserDocument` | Gen 1 Auth `onDelete` | Firebase Auth event | Account root, profile documents, discovery markers |
| `deletebookupdates` | Gen 2 Firestore `onDelete` | Internal event ingress | Recursive deletion of one book's update subcollection |
| `syncbooksharingprojection` | Gen 2 Firestore `onWrite` | Internal event ingress | Personal-book work links and `sharedWorkOwners` |
| `syncsharingsettingprojection` | Gen 2 Firestore `onWrite` | Internal event ingress | Sharing consent, owned public profile, catalog works, and `sharedWorkOwners` |
| `syncsharingprofileprojection` | Gen 2 Firestore `onWrite` | Internal event ingress | Public-profile state, catalog works, and `sharedWorkOwners` |
| `toggl-syncqueue` | Gen 2 Firestore `onWrite` | Internal event ingress | Queue claim and quota, Toggl create/patch, recovery status and TTL |

## Route catalog

| Route | Main functionality | Access and writes |
|---|---|---|
| `/` | Books in progress, page progress, reading sessions, local or Toggl timers | Owner read/write |
| `/finished` | Finished books, search, sorting, year filtering, totals, session correction | Owner read/write |
| `/me` | Reading analytics, add book, profile settings, Toggl connection, sign out | Owner read/write |
| `/authors` | Browse and search the shared author catalog | Verified live account; read-only |
| `/isbns` | Find missing, invalid, unresolved, or coverless ISBN metadata and open the edit dialog | Owner read/write |
| `/profiles/[username]` | Public reading statistics, heatmap, records, yearly data, and links | Anyone when published; owner can render their private profile through authenticated Firestore; no writes on the page |
| `/books/[workId]` | Canonical work, editions, and grouped opted-in reading attempts | Signed-in users; read-only redacted callable response |
| `/admin` | Account activity, aggregate library totals, anomalies, and recent issue feed | Fixed verified operator; server writes a view audit row |
| `/admin/catalog` | Works, unmatched books, findings, work detail, and preview/apply curation | Fixed verified operator; mutations require recent authentication and write a transactional audit |

## Where to make common changes

| Change | Start here | Also review |
|---|---|---|
| Add or rename a route | `src/routes/`, `src/lib/components/Navbar.svelte` | Root auth gate, `site-functionality.mmd`, `site-access.mmd` |
| Add a book or session field | `src/lib/interfaces/`, `src/lib/firebase/db.ts`, decoders | `firestore.rules`, migration scripts, public profile projection, tests |
| Change shared-work matching | `src/lib/utils/catalog.ts`, `functions/src/catalog.ts`, `cross-user-work-migration.ts` | Shared normalization fixtures, server-owned indexes, Rules, privacy and race tests |
| Change admin curation | `functions/src/admin.ts`, admin catalog client/route | Recent-auth ordering, preview/apply stale checks, transactional audit, emulator contention tests |
| Change a correlated write invariant | `src/lib/firebase/readingSessionWrites.ts`, `firestore.rules` | Emulator tests and offline failure handling |
| Add a callable | New or existing `functions/src/*.ts`, then export from `functions/src/index.ts` | Client binding, auth and quota, service account, max instances, function table |
| Change public profile output | `functions/src/publicWeb.ts`, `publicProfileRenderer.ts` | `sync-profile-shell.ts`, cache/privacy tests, coupled Hosting deployment |
| Change Toggl behavior | `src/lib/firebase/db.ts`, `functions/src/toggl.ts` | Timer decoders, Rules, queue recovery, TTL and emulator tests |
| Change authentication | `src/lib/firebase/auth.ts`, `src/routes/+layout.svelte` | Rules, Auth triggers, emulator tests, admin gate |
| Deploy the frontend or public renderer | Root [Deployment guide](../../README.md#deployment) | Build first, deploy `functions:publicweb,hosting` together, verify through the custom domain |
| Run a data repair | [MIGRATIONS.md](../../MIGRATIONS.md) | Dry-run, snapshot, apply, and idempotence checks in the relevant runbook |

## Deployment constraints worth preserving

- `npm run build` produces `public/index.html` and `functions/assets/profile-shell.html` with the same hashed assets. Artifact tests reject drift.
- The Hosting rewrite uses `pinTag`. The custom domain reaches the revision pinned by the last Hosting release, which may differ from the newest direct Cloud Run revision.
- There is no safe Hosting-only or preview-channel release path. Test locally or with the emulators.
- Roll forward with a new deploy. The operational runbook removes stale Cloud Run tags and revisions, so console rollback can point Hosting or Eventarc at a retired revision.
- New functions must choose one of the dedicated runtime identities, set an instance cap, and document whether the endpoint is public, handler-authenticated, or internal-event-only.
- Deploy the additive `books.workId` and `books.editionId` collection-group indexes, searchable-title and stable work-reader pagination composite indexes, and three sharing-projection triggers before catalog callables or a linking client. Rehearse the catalog/projection migration in emulators, then run production dry-run, snapshot, apply, second zero-write run, and `db-audit.ts` before exposing admin curation and shared-work pages.

The complete release, monitoring, spend, and recovery procedures remain in [README.md](../../README.md#deployment) and [MIGRATIONS.md](../../MIGRATIONS.md). This guide summarizes architecture rather than duplicating those runbooks.

## Keeping the diagrams current

Edit the Mermaid source, then render and verify every image:

```bash
./docs/architecture/render.sh
```

The renderer pins Mermaid CLI `11.16.0`, applies the shared [configuration](mermaid-config.json) and [styles](mermaid.css), and writes SVG plus PNG. It uses Chrome or Chromium. Set `PUPPETEER_EXECUTABLE_PATH` when the browser is installed somewhere unusual.

The final verification step checks:

- Every `src/routes/**/+page.svelte` route appears in both site diagrams.
- Every deployed function export appears in the backend diagram and this guide.
- Every Mermaid source has an accessible title and description.
- Every SVG and PNG exists and is newer than its source and shared styles.

Update the audit date and commit after checking behavior that cannot be inferred mechanically, especially permissions, data lifecycle, deployment coupling, and external API behavior.
