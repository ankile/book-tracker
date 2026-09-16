# To-read queue and completion forecast

Status: proposed, September 15, 2026. This document plans the feature; it does not implement it.

## PR workflow

Use the draft PR on `feature/to-read-planner` to refine this plan, then implement and validate the feature on the same branch when ready. Keep this document and the full plan in the PR description synchronized as decisions change.

- Planning: resolve product and storage decisions through PR review and update the plan.
- Implementation: add focused commits for calculation, persistence, and UI, following the delivery sequence below.
- Testing: record the checks run and their results in the PR, including forecast tests, emulator coverage, and complete browser flows.
- Preview: once there is an implementation, provide a branch preview and record its URL or local launch instructions in the PR. Use isolated test data and emulator-backed services for validation. Preview hosting and backend configuration still need to be set up; this planning PR does not create a running preview.
- Completion: make the PR ready for review after implementation, testing, and preview verification.

Related work: [PR #52](https://github.com/ankile/book-tracker/pull/52) proposes a book finish prediction engine and uncertainty view. Before implementation, review overlap and decide which calculation and presentation pieces to share. This plan starts from `master` and does not depend on that unmerged branch.

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
- Remove a future entry with an undo action. Removing an intention must not delete an existing personal book or its history. Currently reading books remain included while unfinished.
- Finished books leave the forecast automatically. Retain their position metadata so reopening an unfinished book can restore its place. A deleted personal book must disappear without becoming a future entry again.

### Summary and timeline

At the top, show recent reading minutes per day, reading days out of 14, total remaining pages and hours, and the expected end of the queue. Example copy: "At 30 minutes a day, these books take you through December 2026."

Below that, show a compact timeline with month and year boundaries. Book segments represent remaining time, so a difficult 200-page book can occupy more space than a quick 400-page book. Keep the ordered list as the primary interaction on small screens.

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

Rules must restrict these collections to the owner and enforce the existing account requirements for writes. Validate entry variants, allowed fields, positive overrides, rank and text sizes, and legal conversion from planned entry to book entry. Keep planning data out of public profiles and shared catalog projections. Verify account deletion removes it, and book deletion cannot leave a visible linked row.

Derive forecasts in the client from books, plan entries, and sessions. Store intentions and overrides, not calculated finish dates. No scheduled job or new external integration is needed.

### Implementation areas

| Area | Proposed work |
|---|---|
| Calculation | New `src/lib/utils/readingPlan.ts` for rolling budget, entry ordering, effort, cumulative dates, and year summaries; reuse `paceEstimate.ts` |
| Types and persistence | New plan interfaces, strict decoders, cached stores and batch writes in the Firebase layer |
| Reading history | Reuse `Database.getAllReadingSessions()` and daily grouping conventions; own the subscription on `/to-read` and share it with existing consumers |
| UI | New `/to-read` route, queue rows, summary, timeline, estimate editor, and future-book add flow using existing catalog controls |
| Navigation | Update `Navbar.svelte`, its mobile layout, route prefetch list, and route/access coverage |
| Rules and lifecycle | Owner-only plan rules, atomic Start reading behavior, account deletion coverage, linked-book deletion behavior |
| Documentation | Update route, access, and data-flow maps and regenerate their images when implementation changes those surfaces |

For the first release, reuse the existing history subscription rather than creating a second aggregation system. Measure the planner's history load. Revisit a bounded 14-day query or maintained daily totals if full-history reads become costly. Planned entries should load once per planner visit, with client-side rendering limited to visible rows when long queues justify it.

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
- Another user cannot read or mutate the plan, including when the owner has a public profile. Account deletion removes planning data.

Use focused unit tests for the forecast and ordering, emulator tests for Rules and atomic lifecycle writes, and browser tests for the complete planning flow. Follow the repository's normal checks and release validation when implementing.

## Later extensions

Revisit parallel reading lanes with explicit allocation of the shared time budget, planned holidays or weekday schedules, alternative saved queues, target-date scenarios, and measured forecast accuracy after actual completions. These should build on the same remaining-effort calculation. The first release uses one prioritized queue and one shared daily budget.
