# To-read queue and completion forecast

Status: implemented on this branch, September 16, 2026. The plan below is kept as the specification; the decisions section records where the implementation settled the open questions.

## PR workflow

Use the draft PR on `feature/to-read-planner` to refine this plan, then implement and validate the feature on the same branch when ready. Keep this document and the full plan in the PR description synchronized as decisions change.

- Planning: resolve product and storage decisions through PR review and update the plan.
- Implementation: add focused commits for calculation, persistence, and UI, following the delivery sequence below.
- Testing: record the checks run and their results in the PR, including forecast tests, emulator coverage, and complete browser flows.
- Preview: once there is an implementation, provide a branch preview and record its URL or local launch instructions in the PR. Use isolated test data and emulator-backed services for validation. Preview hosting and backend configuration still need to be set up; this planning PR does not create a running preview.
- Completion: make the PR ready for review after implementation, testing, and preview verification.

Related work: [PR #52](https://github.com/ankile/book-tracker/pull/52) proposes a book finish prediction engine and uncertainty view. Before implementation, review overlap and decide which calculation and presentation pieces to share. This plan starts from `master` and does not depend on that unmerged branch.

## Decisions and implementation (September 16, 2026)

The owner resolved the open questions on September 16, 2026, and the feature was implemented on this branch the same day. The rest of this document is the specification; where it offered options, these choices apply.

- Timeline: year dividers in the list only. The proportional timeline bar is not built. The summary sentence names the queue's end, the spare hours in the current year, or the hours carried past December 31 and the book that crosses it.
- Dashboard: `projectedFinishes()` is unchanged. The "On deck" list on the dashboard is labelled as independent estimates (each book gets the whole 30-day daily budget at its own measured pace) and links to `/to-read`. PR #52 is not touched.
- History source: the existing full-history store is reused. Its listener now delivers metadata changes and publishes cache-origin and pending-write state through `Database.getReadingHistoryState`, so the planner can say when the budget rests on cached or unconfirmed sessions.
- Ranks: fractional numbers. A move writes the midpoint between its neighbours; neighbours closer than the minimum gap renumber the ranked queue in one batch; ties break by entry id. Books not yet positioned are materialised only when a drop lands among them or an estimate is saved on one (`planMove`, `planMaterialize` in `src/lib/utils/readingPlan.ts`).
- Add flow: catalog search, ISBN lookup, and manual title. The catalog search and selection state was extracted once into `CatalogDraft` (`src/lib/components/catalogDraft.svelte.ts`) and the author, edition, and work completion steps into `completeBookDraft` (`src/lib/utils/bookDraft.ts`); the add-book dialog uses both.
- Undo on remove: deferred. Removing a planned book asks for confirmation instead.
- Account lifecycle: plan rows follow the books posture exactly. They are owner-only with no email-verification or tombstone gate, because `users/{uid}/books` has none either; the review's reading that tombstoning should revoke plan access would have been stricter than the data it orders. A rules test pins this.
- Validation: unit tests, emulator Rules tests, and an emulator-backed Playwright flow. No hosted branch preview.
- Bundle: the total budget rises from 370 to 390 KiB with the measurement recorded in `tests/bundle-budget.test.ts` (route chunk 14.4 KiB, shared growth 4.9 KiB, no new dependency).

Storage as built: `users/{uid}/readingPlanEntries/{entryId}` with `kind`, `rank`, `manualMinutesPerPage`, `createdAt`, `updatedAt`; planned rows add `title`, `authors` (up to six `{id, name}` pairs, `id` null for a typed name), `pageCount` (null until known), `isbn`, the five metadata fields, and flat `workId`, `editionId`, `matchMethod`. `users/{uid}/readingPlans/default` holds `dailyMinutesOverride`. Start reading converts a planned row to a book row in the batch that creates the book, and the rules admit that conversion only while the same batch creates the book, so a replay cannot create a second book or reset progress. A replay after the conversion would pass as an ordinary book-row update, so the books rule also pins `createdAt` on edits: the stale set over the started book is refused and takes the batch with it. Only a planned row can be deleted while its book exists, so a Remove confirmed in a tab that still saw the intention cannot erase the started book's rank and estimate. Each newly positioned book costs the rules one lookup and a batched write may make 20, so the client splits larger materializations into batches of 20 (`chunkPlanWrites`); ranks are absolute, so any committed subset is a valid plan. The shared add flow asks its caller whether the form was closed after each network step and stops before the next catalog write. (External review, September 16, 2026.)

Rules for the two collections must be deployed before this client ships; there is no backfill.

## Design and engineering review

[Fable 5.1's detailed review and our assessment](reviews/to-read-fable-5.1.md) cover desktop and mobile layouts, interactions, component reuse, storage, performance, and testing. The review was requested through the Claude CLI against the original plan commit. It is a source review, not evidence from a running implementation.

The constraints below incorporate its verified findings. Of its deferral suggestions, the owner deferred undo and the proportional timeline and kept catalog search; see the decisions section. The review's sample wireframes do not change the rule that currently reading books remain included.

### Visual language and information hierarchy

- Use the existing `BookSummary` presentation for the summary, with its light border, 8px radius, and faint shadow. Put compact queue rows in a matching container. Keep the existing italic book titles, tabular numbers, and duration formatting.
- Reuse the existing teal action and focus colors. The app does not yet have a unified design-token system; avoid introducing another palette or undertaking an unrelated redesign. Extract a small shared style only when it removes actual duplication in the components being changed.
- Default rows show position and drag handle, cover, title and author, reading status, remaining effort, and expected finish month and year. Expand row details for exact dates, pages, pace evidence, manual estimates, and secondary actions. Essential information must not depend on hover.
- On phones, place effort and expected finish below the title. Use CSS for responsive layout, not a separate DOM tree driven by JavaScript window width. Summary statistics use the existing two-column mobile layout.
- Keep one primary Add to plan action. Starting and removing a future book belong in its details. Already-reading rows must not offer Start reading or an ineffective Remove from plan action.
- Update the mobile navigation's three-column assumption for the fourth destination, and verify labels at 320px and 360px. Include the footer and route/access documentation in navigation changes.
- Use existing dialog and form primitives. Only extend a shared primitive where the new behavior is required, such as a larger dialog variant; do not copy its implementation.

### Reorder interaction

Drag starts from a visible handle, after a small movement threshold. Touch scrolling remains available on the rest of the row. Specify insertion targets, edge auto-scroll, Escape and pointer-cancel behavior, and what happens when the underlying queue changes during a drag. A cancelled move writes nothing.

Keyboard users can grab and drop with Space or Enter, move with arrow keys, and cancel with Escape. Keep the explicit Move up, Move down, and Move to position controls. Preserve focus on the moved book. Announce keyboard moves and the final pointer drop through one polite live region; do not announce every pointer movement. Respect reduced motion and use at least 44px interaction targets.

Show pending versus confirmed saves. A write rejection restores the stored order and explains the failure. Browser connectivity alone must not be presented as confirmation that a write reached Firestore.

### Reuse and performance boundaries

Reuse `BookSummary`, `ModalCard`, form controls, author and ISBN helpers, formatting functions, pace estimation, day grouping, cached stores, and existing error handling. Keep the planner separate from the timer-heavy `BookList`. Extract small cover or identity components only where both existing and new callers benefit.

Catalog search currently contains stateful effects inside `NewBookModal`. Extract the shared search and selection behavior once for the planner's add flow, preserving existing catalog tests. Avoid copying that flow or turning the whole modal into a component with many conditional modes. For Start reading, separate reusable book-write construction from batch submission so the planner can supply a fixed book ID and commit the book and entry conversion atomically. A prefilled form and a narrow writer interface may support this without duplicating the form.

Separate reactive calculations into three stages:

1. Recent session totals and the daily budget, updated when session evidence or the reading day changes.
2. An effort map keyed by entry ID, updated when relevant book metadata, progress, pace evidence, or overrides change. Position-only changes must not invalidate this map.
3. A linear cumulative schedule using the order, effort map, and daily budget. Dragging updates this stage only, at most once per animation frame or when the insertion target changes.

Do not rescan session history or rerun `paceFor()` for every pointer event. Keep planner history and entry subscriptions owned by the route. Expose loading, cache origin, pending writes, and server-confirmation state where needed; the current array-only history store does not provide enough information to promise a complete offline forecast. Metadata-only transitions must also update that state.

Measure initial loading, listener counts, recalculation, and compressed bundle growth against the base revision. Start with 60 queued books, 300 library books, and 10,000 history records, then include a 1,000-entry queue stress case. Test dependency invalidation with counters, and benchmark timing separately from ordinary unit tests. Do not add virtualization unless browser measurements show it is needed.

The current bundle test caps all compressed JavaScript at 370 KiB and the largest chunk at 170 KiB. Route splitting can help initial load but does not reduce that total budget. Prefer existing primitives and a small reorder implementation. Any dependency or budget increase needs a measured before/after result and an explanation of its cost; no automatic increase is assumed.

### Coordination and decisions before implementation

- Resolve initial queue ordering and rank persistence before implementing drag. A new future book must land below the entire visible queue, including implicit in-progress rows. New reading activity must not reshuffle a saved plan. Specify concurrent edits, reopening finished books, rank collisions, and large-queue behavior without assuming every queue fits one batch.
- The dashboard's `projectedFinishes()` currently gives each book the full daily budget from a rolling 30-day history window. Label those as independent estimates and explain the basis, with a link to the ordered plan. Coordinate any later replacement with PR #52; do not silently present two different dates as the same forecast.
- Year boundaries are visible in the list as dividers; the proportional timeline is deferred (owner decision 2026-09-16). Unknown effort stops the complete forecast.
- Preserve the existing account lifecycle: plan rows are owner-only like personal books, and a tombstoned account keeps the same access to them that it keeps to its books (none of the per-user book rules gate on the tombstone). A broader content-purge change belongs in a separate decision.

## Outcome

Add a private `/to-read` page where the reader orders everything they intend to read, including books already in progress. Moving a book immediately updates its expected start and finish dates and the dates of the books after it.

The page should answer: "If I read these books in this order, at my recent level of reading, how far into the year does that take me?"

## Reader experience

- Add **To read** to the primary navigation between Reading and Finished.
- Include every currently reading book automatically, using its remaining pages. Initialize their relative order from the existing Reading list. Once the reader changes the order, reading activity must not reshuffle it.
- Add future books by searching the existing catalog, looking up an ISBN, or entering a title manually. A title is enough to save an intention; page count and other metadata can come later.
- Put newly added future books at the bottom. Show new currently reading books that have no saved position after positioned entries, in a stable order, with a clear "New to your plan" indication.
- Allow all entries to move freely, including currently reading books. In-progress status is a badge, not a pinned section.
- Support drag handles on desktop and touch devices, plus Move up, Move down, and Move to position controls. Preserve keyboard focus and announce the new position and finish estimate after a move.
- Each row shows cover, title, status, remaining pages, estimated minutes per page and its source, remaining reading hours, expected start, and expected finish. Show month and year prominently, with the full date in the row details.
- Recalculate locally during reordering; persist the final move on drop. Also recalculate after reading sessions, progress corrections, metadata edits, removals, and day changes.
- "Start reading" turns a future entry into a normal personal book while preserving its queue position. It does not start a timer or record any reading time.
- Remove a future entry after a confirmation (undo deferred, owner decision 2026-09-16). Removing an intention must not delete an existing personal book or its history. Currently reading books remain included while unfinished.
- Finished books leave the forecast automatically. Retain their position metadata so reopening an unfinished book can restore its place. A deleted personal book must disappear without becoming a future entry again.

### Summary and timeline

At the top, show recent reading minutes per day, reading days out of 14, total remaining pages and hours, and the expected end of the queue. Example copy: "At 30 minutes a day, these books take you through December 2026."

The proportional timeline (book segments sized by remaining time) is deferred; the first version marks year boundaries with dividers in the list and states the year summary in the sentence above.

Mark December 31 and show which book crosses into the next year. If the queue fits within this year, show the estimated spare reading hours. If it does not, show the remaining hours carried into the next year. A queue extending several years should still be readable, using year groupings and month detail.

Illustrative forecast, not the reader's actual data. Assume the first available reading day is September 16, 2026, with 30 minutes per day:

| Order | Book | Pages left | Minutes/page | Hours left | Expected finish |
|---|---|---:|---:|---:|---|
| 1 | A, already reading | 200 | 3 | 10 | October 5, 2026 |
| 2 | B | 400 | 3 | 20 | November 14, 2026 |
| 3 | C | 400 | 3 | 20 | December 24, 2026 |

These three books use 50 hours across 100 reading-budget days. Reordering changes individual finish dates; the final date stays the same when the same amount of reading remains.

## Forecast rules

### Separate reading availability from book difficulty

Two quantities are needed:

1. **Minutes per calendar day** measures how much time the reader actually spends reading. Calculate this from the last two weeks.
2. **Minutes per page** estimates how much time a particular book needs. Use that book's history or an estimate from the reader's other books.

Using only pages per day would treat every book as equally difficult. Using only minutes per page would assume reading time without knowing how much is available.

### Recent daily budget

Use the previous 14 completed reading days. Follow the app's existing local 3 a.m. day boundary in `stats.ts`, and display the exact date range used. Exclude the current partial day from the average so merely opening the app in the morning does not depress it.

```text
dailyMinutes = total recorded reading minutes in the window / 14
```

Include days with no reading in the denominator. Include recorded reading on all books, even books now finished or outside the future queue. Count only `type: 'reading'` updates; page corrections add no time. Running timers contribute once their sessions are saved. Count the app's saved session once, without separately importing its external timer record.

Group sessions by their existing `createdAt` convention. The current model does not provide enough interval detail to split every manual session across midnight. State this limitation in the estimate details.

Use local calendar arithmetic across daylight-saving changes. Rebuild the window at the reading-day boundary and on app resume. A timezone change follows the app's current local-time behavior and triggers recalculation.

### Remaining effort per book

```text
remainingPages = max(0, pageCount - currentPage)
remainingMinutes = remainingPages * estimatedMinutesPerPage
```

Future books start at page zero. Use `currentPage` for remaining progress, not cumulative `pagesRead`, which can include rereading.

Reuse `paceFor()` from `src/lib/utils/paceEstimate.ts`. It already chooses the book's own measured pace, then the reader's pooled pace on the same author, then the same fiction classification, then the full library. Those estimates use recorded lifetime totals; the rolling two-week window controls available reading time. Label these separately in the UI so "last 14 days" never appears to describe lifetime book pace.

Allow a positive manual minutes-per-page estimate per queue entry. It overrides the automatic value until cleared, and the row says "Your estimate." This lets the reader plan an unusually difficult book or plan before they have any reading history. Show the automatic value alongside the override in the editor.

Keep full precision throughout the calculation. Round only displayed values; reusing the existing rounded `minutesLeft()` result would accumulate rounding errors across the queue.

### Convert effort to dates

Assume the reader works through the queue in order, sharing one daily time budget across all books. Carry unused minutes into the next book on the same day. Multiple books already in progress are forecasts of priority, not independent schedules each receiving the full budget.

For today, available minutes are `max(0, dailyMinutes - recordedReadingMinutesToday)`. Give every following reading day the full daily budget. Use cumulative remaining minutes to assign expected start and finish dates. For example, a book that needs 45 minutes finishes tomorrow if 30 minutes remain today.

Subtract today's recorded reading across the whole library. Its effect on current pages is already reflected in remaining effort; subtracting it from today's budget prevents allocating the same time twice. Once today's budget is exhausted, the next forecast starts tomorrow. Label the dates as expected dates assuming the recent routine continues, not deadlines.

### Missing and sparse evidence

- No reading in the last 14 days: show remaining hours but no dates. Offer "Plan with ___ minutes/day" as an explicitly labeled manual scenario. Do not invent a default daily budget.
- Sparse recent activity: still divide by 14, and expose the reading-day and session counts. Mention that the estimate is based on limited recent activity.
- Missing pages or pace: keep the book in its chosen position, show the missing input, and leave its effort unknown. Earlier dates remain valid; this entry and all later entries have no complete finish forecast. Show known hours as a subtotal, never as the whole queue.
- Zero remaining pages: consumes no time. Completion state remains controlled by existing book logic.
- Initial loading or incomplete offline history: distinguish this from an empty history. Cached results must identify that they may be incomplete; do not turn an incomplete cache into a confident no-reading average.
- A running timer: indicate that its unsaved progress is not included.

The first version reports a central estimate and its assumptions. Statistical confidence bands would imply precision the current data does not establish. A manual daily-budget scenario is a more useful first addition.

## Fit with the existing codebase

The app currently defines Reading as `finished === false` in `Database.getBooks()`. Statistics also count every unfinished personal book as currently reading. Saving a wishlist directly into `users/{uid}/books` would therefore change existing lists, counts, and potentially public sharing projections.

Use separate private planning entries. A future entry becomes a personal book only when the reader chooses Start reading. This also permits unknown page counts without weakening the existing book and progress invariants.

### Proposed storage

```text
users/{uid}/readingPlanEntries/{entryId}
  kind: 'planned' | 'book'
  position: sortable rank
  manualMinutesPerPage: number | null
  createdAt, updatedAt

  when kind == 'planned':
    title
    optional catalog link, author metadata, cover, ISBN
    pageCount: positive integer | null

  when kind == 'book':
    entryId is the personal book ID
    title, progress, page count, and metadata come from that book

users/{uid}/readingPlans/default
  dailyMinutesOverride: positive number | null
  updatedAt
```

For a planned entry, reserve its ID as the eventual personal book ID. Starting it creates the personal book and converts the entry to `kind: 'book'` in one batch. Require enough metadata to satisfy existing book validation first. Reuse the existing catalog and author resolution flow when needed. Repeated submission must not create another personal book or reset progress.

Build the visible queue by joining saved entries with all unfinished personal books. An unfinished book without an entry gets an implicit queue row keyed by its book ID; save its position when the reader first orders it. Resolve a planned entry's existing catalog identity back to a matching personal book before adding a duplicate. Warn on an existing edition or ISBN match and let the reader select the existing entry; title alone is insufficient for automatic merging.

Use sortable ranks per entry so a normal move writes one document. Break equal ranks by entry ID for deterministic ordering, including concurrent offline moves. If the chosen rank representation requires rebalancing, make that an explicit, tested operation. Save independent fields with partial updates, and accept the last committed position for concurrent moves of the same entry. Avoid replacing the entire queue on every drag.

Implicit entries use a deterministic order after ranked entries. On the first reorder, materialize the affected implicit positions in the same batch as the move so the displayed order is preserved. Test a large initial library against write-batch limits; use a deterministic base rank scheme if materializing the entire initial library would exceed one batch.

Rules must restrict these collections to the owner with the same account requirements personal books have. Validate entry variants, allowed fields, positive overrides, rank and text sizes, and legal conversion from planned entry to book entry. Keep planning data out of public profiles and shared catalog projections. Verify that book deletion cannot leave a visible linked row.

Derive forecasts in the client from books, plan entries, and sessions. Store intentions and overrides, not calculated finish dates. No scheduled job or new external integration is needed.

### Implementation areas

| Area | Proposed work |
|---|---|
| Calculation | New `src/lib/utils/readingPlan.ts` for rolling budget, entry ordering, effort, cumulative dates, and year summaries; reuse `paceEstimate.ts` |
| Types and persistence | New plan interfaces, strict decoders, cached stores and batch writes in the Firebase layer |
| Reading history | Reuse decoding and daily grouping; compare the existing full-history store with a bounded query, expose snapshot state, and own the subscription on `/to-read` |
| UI | New `/to-read` route, queue rows, summary, timeline, estimate editor, and future-book add flow using existing catalog controls |
| Navigation | Update `Navbar.svelte`, its mobile layout, route prefetch list, and route/access coverage |
| Rules and lifecycle | Owner-only plan rules, atomic Start reading behavior, account deletion coverage, linked-book deletion behavior |
| Documentation | Update route, access, and data-flow maps and regenerate their images when implementation changes those surfaces |

Use existing history decoding and subscription infrastructure. Compare reusing the full-history store with a query bounded to the 14 completed reading days plus today before choosing the planner's source. The owner/type/createdAt index already exists; verify the exact query in emulator tests. A bounded listener must refresh its cutoff at the reading-day boundary. Either option must expose cache and confirmation state, avoid duplicate listeners, and release subscriptions on navigation. A new maintained aggregation system is unnecessary for the first version. Render ordinary keyed rows initially; consider virtualization only after measuring long queues.

## Delivery sequence

1. Implement pure forecasting and ordering functions, including an injectable clock, and verify the date arithmetic against fixed examples.
2. Add private storage, decoders, Rules, and queue lifecycle writes. Existing books enter through the derived join, so the feature needs no bulk backfill.
3. Build the page with add, edit, start, remove, keyboard reorder, drag reorder, and visible save state. Forecast updates should not wait for the network.
4. Add the timeline, year-boundary summary, source explanations, and manual daily-budget scenario.
5. Verify complete browser flows, offline persistence and reconnect, cross-device ordering, mobile interaction, and architecture documentation before release.

Deploy compatible Rules before a client starts writing the new collections. Keep the existing Reading and Finished flows working throughout the rollout. Older clients will not see future planning entries, but books started through the planner must be ordinary books they can read and update.

## Acceptance checks

- All unfinished personal books appear exactly once, with correct remaining progress, without adding fake reading sessions.
- A title-only future book saves successfully and does not affect currently-reading counts, reading statistics, or public profile output.
- Moving C ahead of A and B changes all affected dates immediately and survives reload. Equal total effort leaves the queue's final date unchanged.
- Seven 60-minute reading days and seven zero days produce a 30-minute daily budget.
- Page corrections change remaining effort without adding reading time. Editing or deleting a reading session updates both pace evidence and the recent budget.
- Today has only its unused budget; adjacent small books share a day. Test exact budget boundaries, leap years, daylight-saving transitions, and crossing December 31.
- A book with unknown effort prevents later complete date forecasts instead of being counted as zero hours.
- A zero recent budget produces no automatic completion dates, while an explicit manual scenario does.
- Start reading preserves identity and order, obeys existing validation, and is atomic and safe against duplicate submission. Finishing, reopening, and deleting a book produce the intended queue changes.
- Two devices can reorder different entries without replacing each other's entire queue. Save failures remain visible and the view reconciles with stored state.
- Touch and keyboard users can perform every reorder action. Dates and estimate sources are available without hover.
- Another user cannot read or mutate the plan, including when the owner has a public profile. Plan access follows the books rules exactly, tombstone included, matching the existing account lifecycle.
- Pointer-only reorder changes do not rescan reading history or recalculate book pace. Listener counts, initial load, and bundle growth are measured against the base revision.

Use focused unit tests for the forecast and ordering, emulator tests for Rules and atomic lifecycle writes, and browser tests for the complete planning flow. Follow the repository's normal checks and release validation when implementing.

## Later extensions

Revisit parallel reading lanes with explicit allocation of the shared time budget, planned holidays or weekday schedules, alternative saved queues, target-date scenarios, and measured forecast accuracy after actual completions. These should build on the same remaining-effort calculation. The first release uses one prioritized queue and one shared daily budget.
