# The Stupid-Simple Book Tracker

> The solution is located at [book.ankile.com](https://book.ankile.com).

This responsive single-page app allows one to keep track of what one's reading, as well as give some indication as to how long books will take to complete.

## Screenshots

### Currently Reading
![Currently Reading Page](static/screenshots/currently_reading.png)

### Profile & Reading Activity
![Profile Page with Statistics and Reading Heatmap](static/screenshots/my_page.png)

## Features

### Core Functionality
- **Book Management**: Add, edit, and delete books from your library
- **Reading Progress**: Track current page and mark books as finished
- **Reading Sessions**: Log reading sessions with time spent and pages read
- **Session Management**: View, edit, and delete individual reading sessions

### Statistics & Analytics
- **Profile Dashboard**: Comprehensive reading statistics including:
  - Total books read and currently reading
  - Total time spent reading and pages read
  - Books per year average
  - Average time per finished book
  - Year-by-year breakdown with longest books

- **Reading Heatmap**: GitHub-style activity visualization showing:
  - Daily reading activity (pages read per day)
  - Customizable 3 AM day boundary (late-night sessions count as previous day)
  - Year selector (view specific years or last 12 months)
  - Current reading streak and longest streak tracking
  - Detailed tooltips with session information

### Book Metadata
- **ISBN Lookup**: One button fills title, author, page count, cover, genres and
  a fiction/non-fiction flag from the book's ISBN
- **Book Covers**: Shown on the reading and finished lists, hot-linked from the
  source catalogue (no image storage)
- **Metadata Repair**: `/isbns` lists books whose ISBN is missing or mistyped —
  the only cases the automatic enrichment cannot fix

### Organization & Filtering
- **Finished Books Page**: Browse completed books with:
  - Sort options: recently finished, title (A-Z), length, or time spent
  - Filter by year
  - Summary statistics for filtered view

- **Currently Reading**: View all books in progress

## Book metadata

Covers, genres and the fiction/non-fiction flag are all derived from a book's
ISBN. Four sources are consulted in a fixed order, each filling only the fields
the previous ones left empty (`mergeMetadata` in `src/lib/utils/googleBooks.ts`).
An earlier source always wins — the order encodes which source is most
trustworthy for a given field, not which one answered first.

| # | Source | Why it is at this position | Parser |
|---|---|---|---|
| 1 | **Open Library** | Richest subject lists and stable, hot-linkable cover URLs. Free, no key. | `utils/bookMetadata.ts` |
| 2 | **Google Books** | BISAC top-level categories ("Business & Economics", "Science") settle fiction/non-fiction where Open Library's free-form subjects cannot. Needs an API key. | `utils/googleBooks.ts` |
| 3 | **Nasjonalbiblioteket** | The only source that reliably knows Norwegian editions. MODS genres ("Romaner", "Skuespill", the explicit `notfiction` marker) classify them. Free, no key. | `utils/nasjonalbiblioteket.ts` |
| 4 | **Goodreads** | Last resort, **backfill only** — see the caveat below. | `utils/goodreads.ts` |

Books store the result in `coverUrl`, `publisher`, `publishedDate`, `subjects`
and `fiction` (`null` when genuinely unknown). The fields are advisory display
data: Firestore rules give owners blanket write access to their own book
documents, so nothing may ever depend on them being accurate.

### In the app

The **Look up** button in the add/edit book modal queries sources 1-3 live.
Sources 1 and 3 are called straight from the browser; Google Books goes through
the `booksapi-lookupisbn` callable, because it proxies a metered API key and must
not be reachable unauthenticated. A failure of any single source degrades to
"one fewer source" rather than discarding the others' results.

Goodreads is **not** in the app and should not be added: it sends no CORS
headers, so a browser cannot call it at all.

### Backfilling existing books

One migration per source, run in numeric order and following the
[MIGRATIONS.md](MIGRATIONS.md) loop. Each is gap-fill only and idempotent, and
each caches its lookups (`ol-cache.json`, `gb-cache.json`, `nb-cache.json`,
`gr-cache.json`, all gitignored) so re-runs and the prod pass cost no requests.
Cache files are runtime-validated before any migration connects or writes. If a
cache is truncated or hand-edited into an invalid shape, the script stops with
the offending field; repair that entry or delete the cache to refetch it.

```bash
node migrate-enrich-books.ts --prod --apply      # 1. Open Library
node migrate-enrich-google.ts --prod --apply     # 2. Google Books (needs GOOGLE_BOOKS_KEY)
node migrate-enrich-nb.ts --prod --apply         # 3. Nasjonalbiblioteket
node migrate-enrich-goodreads.ts --prod --apply  # 4. Goodreads
```

Order matters: running a later pass first lets it claim fields an earlier,
more trustworthy source should own.

The Google Books key comes from the same secret the Cloud Function reads:

```bash
export GOOGLE_BOOKS_KEY=$(gcloud secrets versions access latest \
  --secret=FUNCTIONS_CONFIG_EXPORT --project book-tracker-d8f24 \
  --account=lars.ankile@gmail.com \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['booksapi']['key'])")
```

### The Goodreads caveat

Goodreads retired its public API in December 2020 and its Terms of Service
disallow automated access. `migrate-enrich-goodreads.ts` is therefore a
deliberate, hand-run exception rather than infrastructure, and it is written to
stay one:

- it runs only over books the three open sources left empty (a few dozen
  requests across the whole library), never on a schedule;
- it requests `/book/isbn/<isbn>`, which `robots.txt` permits — **not**
  `/search`, which `robots.txt` disallows;
- it reads schema.org JSON-LD, which is machine-intended and far more stable
  than the surrounding markup;
- it identifies itself, waits 5s between requests, and aborts on the first
  403/429 instead of retrying into a ban.

If it ever needs to run at volume, or on a schedule, or over books that are not
the owner's own, that is the point to stop and buy the data instead —
[Bokbasen](https://www.bokbasen.no/hjelp/fa-tilgang-til-metadata) is the
authoritative commercial source for Norwegian titles.

### What automation cannot fix

A book with no ISBN, or a mistyped one, has nothing to look up. Those are listed
at `/isbns`, grouped by problem, and repaired through the normal edit modal. The
Me-page "Needs an ISBN" card links there and shows the count.

## Version 2.0 - Major Upgrade 🎉

Version 2.0 brings a complete modernization of the tech stack:

- **Svelte 5** with runes syntax (`$state`, `$derived`, `$effect`, `$props`)
- **SvelteKit 2** with file-based routing
- **Vite 7** build system (replacing Rollup)
- **Firebase 12** with modular SDK
- **TypeScript 5**
- **Bootstrap 5** for styling

## Prerequisites

- Node.js 22.18+ (pinned to Node.js 22.23.1 in `.nvmrc`)
- npm (comes with Node.js)
- Firebase CLI when deploying (the commands below use a pinned temporary copy)

## Installation & Setup

### 1. Clone the repository

```bash
git clone <repository-url>
cd book-tracker
```

### 2. Install dependencies

```bash
# Install root dependencies (for the web app)
npm install

# Install Firebase Functions dependencies
npm --prefix functions install
```

### 3. Firebase Configuration

If this is your first time setting up the project:

```bash
# Login to Firebase
npm exec --yes --package firebase-tools@15.24.0 -- firebase login --reauth

# Initialize Firebase (if not already done)
npm exec --yes --package firebase-tools@15.24.0 -- firebase init
```

The project is already configured to use the Firebase project `book-tracker-d8f24` (see `.firebaserc`).

## Local Development

### Running the Development Server

Start the development server with HMR (Hot Module Replacement):

```bash
npm run dev
```

This will:
- Start Vite development server with HMR
- Start a local server on **http://localhost:5173**
- Enable automatic browser refresh on file changes

### Building for Production

```bash
npm run build
```

This creates an optimized production build in the `public/` directory using SvelteKit's static adapter.

### Preview Production Build Locally

```bash
npm run preview
```

This serves the built app locally to test the production build before deploying.

### Public Profile Search Indexing

Profile pages are rendered as complete HTML by the `publicweb` HTTPS Function;
they do not need to be generated as one static file per username. Firebase
Hosting sends `/profiles/**` and `/sitemap.xml` to that Function, while the
Svelte app still hydrates the profile page for interactive visitors.

Search discovery is a separate, explicit opt-in from public sharing. A profile
owner first enables **Public profile**, then enables **Appear in search
engines**. The second switch creates `profileDiscovery/<username>` with the
same owner uid. The server applies these states:

- public profile plus matching discovery marker: `200`, indexable metadata,
  canonical URL, and inclusion in `/sitemap.xml`;
- public profile without a marker: `200` with `noindex,follow`;
- private or missing profile: indistinguishable `404` HTML with
  `noindex,nofollow`;
- a stale marker whose profile is missing, private, or owned by a different uid:
  excluded from the sitemap and reported by `db-audit.ts`;
- `/profiles/<username>.json`: the same visibility rule as the HTML, no `uid`
  on the wire, `public, max-age=60, s-maxage=300`. The Svelte app reads it for
  every profile except the viewer's own, because the `profiles/{username}`
  document is readable only by its owner (SEC-019). Under `vite dev` nothing
  serves this path, so other people's profiles resolve only against a deployed
  or emulated Hosting stack.

The Function memoises finished `200` responses per instance for 60 s and
refuses uncached work with a `503` once 300 misses land in a minute, so a
flood of distinct paths is bounded even when it bypasses the CDN. `404`s are
memoised in a separate pool, so repeats stay free but a flood of them cannot
evict real profiles, and while the budget is exhausted a memoised profile (or
the sitemap) is served stale (up to 5 min old) rather than refused; a profile
the origin has since seen as private is not revived. A profile flipped private can therefore stay served for up to 60 s
(function; 300 s while the origin is being flooded) + 300 s (shared CDN) +
60 s (browser); there is no purge path.

`npm run build` creates both `public/index.html` and
`functions/assets/profile-shell.html`. They deliberately contain the same
hashed JS/CSS references. Treat the Hosting release and `publicweb` revision as
one coupled artifact; the build and artifact tests fail if those shells drift.

### Testing Functions Locally

To test Firebase Functions locally using emulators:

```bash
npm --prefix functions run serve
# in another shell, route the web client to all three emulators
VITE_EMULATOR=1 npm run dev
```

The command starts Authentication, Firestore, and Functions together so an
emulated function can never fall through to production Firestore. Toggl calls
use deterministic local responses whenever `FUNCTIONS_EMULATOR=true`; copied
production tokens are never sent to Toggl, and start, stop, token, and queue
flows still exercise their real Firestore state transitions. The metered Google
Books proxy also returns a local miss instead of consuming its production key.
Queued Toggl work is claimed under a server-owned ten-per-hour user quota.
Successful queue rows are deleted, while terminal rows receive a 90-day TTL;
malformed events consume quota before they are rejected.
Before Firebase starts, `serve` stages the checked-in dummy
`functions/.secret.emulator` as the ignored `.secret.local`; Firebase resolves
bound secrets before handler guards run, so this prevents an emulator startup
from consulting Secret Manager. Never put credentials in `.secret.emulator`.
If a different `.secret.local` already exists, `serve` fails without changing
it; move that file aside before starting the emulators. Do not bypass `serve`
with a raw `firebase emulators:start` command.

### Run the complete validation suite

```bash
npm run validate
```

This runs Svelte diagnostics, PWA tests, Functions linting and compilation,
the production web build, a bundle-size budget, and production-dependency
security audits for both workspaces.

The multi-tab authentication regression uses a real browser against isolated
Auth and Firestore emulators. Install its browser once, then run it separately:

```bash
npx playwright install chromium
npm run test:e2e
```

## Deployment

### Prerequisites for Deployment

1. Make sure you're logged into Firebase:
   ```bash
   npm exec --yes --package firebase-tools@15.24.0 -- firebase login --reauth
   ```

2. Verify you're deploying to the correct project:
   ```bash
   npm exec --yes --package firebase-tools@15.24.0 -- firebase use default
   # Should show: book-tracker-d8f24
   ```

3. Before the first Functions deployment from this version, migrate the
   existing Runtime Config to Secret Manager:

   ```bash
   npm exec --yes --package firebase-tools@15.24.0 -- \
     firebase functions:config:export \
     --project book-tracker-d8f24 \
     --secret FUNCTIONS_CONFIG_EXPORT \
     --force
   ```

   This preserves the existing `booksapi` URL and API key without printing or
   copying the secret into the repository.

#### Runtime identities

Functions do not run as the project-default (Editor) service accounts.
`functions/src/runtime.ts` names two dedicated accounts that must exist in
IAM before a deploy: `publicweb-runtime@` (`roles/datastore.viewer` — the
one function strangers reach can only read Firestore, nothing else) and
`functions-runtime@` (`roles/datastore.user`, `roles/firebaseauth.viewer`,
`roles/eventarc.eventReceiver`, `roles/run.invoker` on the two
Eventarc-fed services, and `secretmanager.secretAccessor` on
`FUNCTIONS_CONFIG_EXPORT`). `datastore.viewer` is read access to the whole
database (Firestore IAM cannot scope to collections), so the reduction is
"read-only, nothing else", not "public data only". The deployer needs
`iam.serviceAccountUser` on both accounts — a project Owner has it; any
other deployer (for example the `firebase-adminsdk` key used for headless
Hosting deploys) would need that role granted on these two accounts, not
on the App Engine default. `triggers.test.cjs` fails if any exported function lacks one of these
identities, and the two Firestore-triggered gen2 services are
`ALLOW_INTERNAL_ONLY`. A new function that needs another Google API gets
its role added to the matching account — never `roles/editor`.

The Hosting rewrite for `/profiles/**` and `/sitemap.xml` uses `pinTag`,
so `book.ankile.com` is served by the Cloud Run revision that was tagged at
the last **Hosting** deploy, not by whatever `publicweb` revision is latest.
Any change to `publicweb`'s identity or roles therefore needs a Hosting
deploy to re-pin (`firebase deploy --only functions:publicweb,hosting`),
and the post-deploy check must go through `https://book.ankile.com/profiles/…`
and `/sitemap.xml`, not the `*.run.app` origin — the origin always runs the
latest revision and passed while the pinned one was returning 500
(2026-08-27, see MIGRATIONS). Hosting leaves every previously pinned
revision tagged and publicly reachable at its `fh-<tag>---…run.app` URL;
after a deploy, drop stale tags and delete retired revisions
(`gcloud run services update-traffic publicweb --remove-tags …`,
`gcloud run revisions delete …`) so only revisions on the current identity
stay addressable. That cleanup also means **never roll back through the
console** — neither Hosting nor any gen-2 Cloud Run service: every earlier
Hosting release's rewrite points at a tag that no longer exists, and retired
revisions of every service have been deleted, so a rollback breaks the
public pages (or, for the Eventarc services, fails deliveries silently for
24 h before they are dropped). Recover from a bad release with a fresh
`firebase deploy` of the affected targets instead. `firebase login` must be
`login --reauth` after any Google-account grant change: plain `login`
trusts a stale cached credential.

Detection (2026-08-27): two content-matching uptime checks through
`book.ankile.com` (`/profiles/lars`, `/sitemap.xml`) and alert policies for
their failure, `publicweb` 5xx, any `PERMISSION_DENIED` in a function, and
`publicweb.sitemap.truncated`/`.skip` — all to the owner's email channel.

### Deploy Everything

The first strict-TypeScript release must follow the authoritative
[timer-claim rollout](MIGRATIONS.md#timer-claim-rollout). Do not use an
all-at-once `firebase deploy`: every user needs a lifecycle document before the
claim-aware web client is exposed. Before deploying, complete the
[release record and rollback gates](MIGRATIONS.md#strict-typescript-release-record-and-rollback-boundary).
After the new Hosting bundle has been exposed, keep the current schema contract
and fix forward; cached old and new bundles make a blind full-stack rollback
unsafe. With the current release artifacts, the fix-forward boundary begins
when the new Functions are deployed: the queue worker can already produce an
ambiguous remote Toggl outcome that the pre-release stack cannot reconcile.

```bash
# 1. Reject uncorrelated legacy timer writes.
npm exec --yes --package firebase-tools@15.24.0 -- firebase deploy --only firestore

# 2. Deploy the claim-aware callables.
npm exec --yes --package firebase-tools@15.24.0 -- firebase deploy --only functions
# Before migrating, let old in-flight invocations drain.

# 3. Review, snapshot, apply, and prove the timer migration is idempotent.
node migrate-timer-claims.ts --prod
node db-snapshot.ts --prod
node migrate-timer-claims.ts --prod --apply
node migrate-timer-claims.ts --prod --apply
node db-audit.ts --prod

# 4. Expose the claim-aware, progress-source-compatible client and its matching profile renderer.
npm run build
npm exec --yes --package firebase-tools@15.24.0 -- firebase deploy --only functions:publicweb,hosting

# 5. Wait the documented 7-day old-bundle overlap window before backfilling progress ownership.
node migrate-reading-progress-sources.ts --prod
node db-snapshot.ts --prod
node migrate-reading-progress-sources.ts --prod --apply
node migrate-reading-progress-sources.ts --prod --apply
node db-audit.ts --prod
```

Review every migration line, then take each snapshot immediately before that
migration's first apply. The second applies must report zero users and zero
books. The pre-Hosting audit must contain no `timer-lifecycle.*` findings. In
the final audit, investigate every `book.progress-source-null-baseline` as a
possible missing history row; all other `book.progress-source-*` findings must
be absent. Record each accepted nonzero baseline in the rollout log.
After this one-time rollout has completed
successfully, routine full deployments can use the standard `firebase deploy`
command, but must run `npm run build` first so Hosting and `publicweb` receive
the same generated shell.

### Deploy Hosting and Profile Renderer

There is intentionally no Hosting-only release path. Even a frontend-only
build changes the generated SvelteKit shell identifier, and the profile
Function embeds that shell. Deploy both targets from one build:

```bash
# Build the web app
npm run build

# Deploy the matching renderer revision and Hosting release together
npm exec --yes --package firebase-tools@15.24.0 -- firebase deploy --only functions:publicweb,hosting
```

### Deploy to Preview Channel

Preview channels are not part of the normal workflow any more: Firebase Auth
only accepts the four production `authorizedDomains` (SEC-021), so sign-in
does not work on a channel URL, and a channel release pins a `publicweb`
Cloud Run revision by tag on the **production** service — a publicly
reachable `fh-<tag>---…run.app` origin that outlives the channel's expiry
and bypasses the CDN (SEC-020/SEC-022). If one is ever needed for a
signed-out check, deploy it and clean up afterwards:

```bash
npm run build
npm exec --yes --package firebase-tools@15.24.0 -- firebase deploy --only functions:publicweb
npm exec --yes --package firebase-tools@15.24.0 -- \
  firebase hosting:channel:deploy preview --expires 1d
# afterwards: delete the channel and the tag it pinned
npm exec --yes --package firebase-tools@15.24.0 -- firebase hosting:channel:delete preview
gcloud run services update-traffic publicweb --region europe-west1 --remove-tags <fh-tag>
```

Never add the channel host to `authorizedDomains`.

### Deploy Functions Only

To deploy backend-only Firebase Functions changes that do not touch
`publicweb`, `src/app.html`, client assets, or the shell sync script:

```bash
# The predeploy hooks will automatically lint and build
npm exec --yes --package firebase-tools@15.24.0 -- firebase deploy --only functions
```

Or use the npm script:

```bash
npm --prefix functions run deploy
```

If `publicweb` or any web-shell input changed, use **Deploy Hosting and Profile
Renderer** instead. Deploying either half alone can return HTML whose hashed
assets do not exist in that Hosting release.

### View Deployment Logs

```bash
# View function logs
npm exec --yes --package firebase-tools@15.24.0 -- firebase functions:log

# Or use the npm script
npm --prefix functions run logs
```

## Project Structure

```
book-tracker/
├── src/                    # Svelte source files
│   ├── app.html           # SvelteKit HTML template
│   ├── routes/            # SvelteKit file-based routes
│   │   ├── +layout.svelte # Root layout (auth guard)
│   │   ├── +page.svelte   # Home page (reading books)
│   │   ├── finished/      # Finished books page
│   │   └── me/            # User profile page
│   └── lib/               # Shared components and utilities
│       ├── components/    # Svelte 5 components
│       ├── firebase/      # Firebase configuration and utilities
│       ├── interfaces/    # TypeScript interfaces
│       └── utils/         # Utility functions
├── static/                # Static assets (favicon, manifest, etc.)
├── public/                # Build output (generated by SvelteKit)
├── functions/             # Firebase Cloud Functions
│   └── src/              # Function source code
├── svelte.config.ts      # SvelteKit configuration
├── vite.config.ts        # Vite bundler configuration
├── package.json          # Root dependencies
└── firebase.json         # Firebase configuration
```

## Technology Stack

### Frontend
- **Svelte 5.56.6** - Reactive UI framework with runes
- **SvelteKit 2.70.1** - Application framework with routing
- **Vite 7.3.6** - Fast build tool with HMR
- **TypeScript 5.9.3** - Type-safe JavaScript
- **Bootstrap 5.3.8** - CSS framework

### Backend
- **Firebase 12.16.0** - Authentication and Firestore database
- **Firebase Functions 7.3.0** on Node.js 22 - Serverless cloud functions

## Development Guide

### Svelte 5 Runes

This project uses Svelte 5's new runes syntax:

```javascript
// Reactive state
let count = $state(0);

// Derived state
let doubled = $derived(count * 2);

// Side effects
$effect(() => {
  console.log(`Count is ${count}`);
});

// Component props
let { title, onclick } = $props();
```

### SvelteKit Routing

Routes are defined by the file structure in `src/routes/`:

- `/` - Home page (reading books)
- `/finished` - Finished books page
- `/me` - User profile page

### Firebase Integration

The app uses Firebase v12 modular SDK:

```javascript
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { getFirestore, collection, query, where } from 'firebase/firestore';
```

## Troubleshooting

### Node.js Version Issues

This project requires Node.js 22.18+. If you're running a different version, consider using a Node version manager like `nvm`:

```bash
nvm install 22
nvm use 22
```

### Dependency Installation Fails

Confirm `node --version` satisfies `package.json`; with `nvm`, run:

```bash
nvm install
nvm use
```

## Available Scripts

### Root Directory

- `npm run dev` - Start Vite development server (http://localhost:5173)
- `npm run build` - Build for production using SvelteKit
- `npm run preview` - Preview production build locally
- `npm test` - Run web checks, PWA tests, and Functions tests
- `npm run validate` - Run the complete build, test, and audit suite
- `npm run check` - Run Svelte type checking
- `npm run check:watch` - Run type checking in watch mode

### Functions Directory

- `npm run build` - Compile TypeScript functions
- `npm run serve` - Start Firebase emulators for local testing
- `npm run deploy` - Deploy functions to Firebase
- `npm run logs` - View function logs
- `npm run lint` - Lint function code

## Migration Notes (v1.0 → v2.0)

If you're upgrading from version 1.0:

1. **Build system changed**: Rollup → Vite (much faster builds)
2. **Routing changed**: svelte-routing → SvelteKit file-based routing
3. **Firebase SDK changed**: v8 compat API → v12 modular API
4. **Component syntax changed**: Svelte 3 → Svelte 5 runes
5. **Event handlers changed**: `on:click` → `onclick`
6. **Bootstrap upgraded**: v4 → v5
7. **Port changed**: 3000 → 5173 (Vite default)

## License

MIT
