# Fable 5.1 review of the To-read plan

Requested through the Claude CLI with model `claude-fable-5-1` and high effort. The CLI's initialization and result metadata confirm this reviewer model. The reviewer had only Read, Glob, and Grep tools and did not modify the repository. Reviewed baseline: `974203c074d48137bbbf406902de8097226321a2`.

## Assessment before adopting recommendations

The response below is preserved as returned. It is advisory input, not an approved replacement plan. The revised [feature plan](../to-read-plan.md) incorporates the verified design and performance constraints.

- Adopt compact rows, expandable details, existing teal colors and lighter summary-card styling, explicit drag interaction and focus behavior, cached effort calculations, and measured bundle cost.
- Keep catalog search, the timeline, and undo in the proposed scope. Deferring them is Fable's scope recommendation, not a user decision. Keep all unfinished books included as requested; pausing a book remains a possible future option.
- Do not adopt the claim that an arbitrary queue always fits one batch. A test with 450 entries does not establish an upper bound. Ordering must also work with larger libraries and concurrent edits, without lost positions or partial renumbering.
- Keep cache completeness as a requirement. Browser online state does not prove that a Firestore snapshot is complete or current. The data layer needs to expose the relevant snapshot state; a simple offline notice cannot replace that work.
- Measure the build before deciding whether to change a budget. The 368.1 KiB figure is a historical test comment. It does not prove that every implementation will fail the current budget, and route splitting does not reduce the test's total-across-chunks measurement.
- The dashboard forecast uses a rolling 30 times 24-hour window and duration arithmetic, not midnight-aligned days as the review states. The verified issue is its independent per-book allocation, which differs from the queue's single shared budget.
- The deletion finding is verified: existing account deletion tombstones content and revokes access rather than purging personal content. Match that lifecycle for planning records and test the access boundary. Do not introduce a site-wide deletion-policy change in this feature.
- The reviewer could not access PR #52. Its overlap suggestions are conditional. Its statement about absent local refs was not established with git, which the reviewer could not run.
- Wireframes are illustrative. Do not show Start reading on a book already in progress, or Remove from plan on a currently reading book while mandatory inclusion is the policy. Unknown effort should produce an explicitly incomplete forecast, not a final queue-end date with an ambiguous plus sign.
- Proposed timing targets and bundle increments are hypotheses to measure, not test results. Avoid fragile wall-clock assertions in ordinary unit tests; benchmark representative data and test calculation dependencies separately.
- Firestore supports both `existsAfter` and `getAfter`; validate the atomic conversion against the existing Rules patterns and emulator tests. See the [official Rules reference](https://firebase.google.com/docs/reference/rules/rules.firestore).

## Full reviewer response

I could not open PR #52: this session has no network or git access and the worktree has no local ref for it, so the overlap answer below is conditional. Nothing else in this review is inferred from a running UI, a build, or a profiler. The bundle figure comes from the comment in the budget test, not from a build I ran.

## Findings

Severity: H = changes architecture or blocks release, M = should be settled before implementation, L = polish.

| # | Sev | Finding and evidence | Impact | Plan amendment |
|---|---|---|---|---|
| 1 | H | The bundle budget has almost no headroom. `tests/bundle-budget.test.ts:81-84` records the last measured build at 368.1 KiB against a 370 KiB cap. The test sums every chunk, so route splitting cannot help the total. | Any implementation fails the test on the first build. | Add a "Bundle" paragraph (text below). Raise the total only by the measured increment plus 2 KiB, and keep the largest-chunk cap by importing nothing new into shared chunks. |
| 2 | H | Ordering rules contradict each other. Plan lines 28 and 145-149: new planned entries go "at the bottom" with an explicit rank, while unranked in-progress books sort "after ranked entries". A new planned entry would therefore land above unranked books. "Stable order" is never defined. | Reordering behaves differently before and after the first move. | Replace the implicit-entry paragraphs with the single policy in the architecture section below. |
| 3 | H | The app already ships a different forecast. `src/lib/utils/sessions.ts:461-507` projects each book independently with the full budget over a 30-day window at midnight boundaries, and `ProgressSection.svelte` shows it on the dashboard as "On deck". The plan's 14-day sequential forecast will disagree with it on the same day. | Two dates for one book with no explanation. | State in the plan that release 1 labels the dashboard list as "each book on its own" or hides it, and that a later change makes the dashboard consume the queue forecast. |
| 4 | H | "Account deletion removes planning data" cannot be true. `functions/src/index.ts:165-199` tombstones and deletes credentials only, and `tests/account-deletion-emulator.test.ts:123` is titled "removes nothing". Access is denied afterwards by `accountLive()` in the rules. | An acceptance check that no implementation can pass. | Reword: "After account deletion the plan is unreadable and unwritable because the account is tombstoned; deletion removes no plan documents, matching every other collection." |
| 5 | H | Start reading needs pieces that do not exist. `Database.addBook` mints its own id (`db.ts:894`), `NewBookModal` has no prefill or writer prop, and a rule that checks the book exists during the conversion must use `existsAfter` because both writes are in one batch. | Either a copied modal or a non-atomic start. | `bookForm.ts` already routes writes through a `BookWriter` interface. Add a `writer` prop and a `draft` prop to the modal, and a planner writer that composes the fixed-id book create with the entry conversion. |
| 6 | H | Reading history load and recompute are not separated. `paceFor` filters the whole library per call (`paceEstimate.ts:44-57`) and `BookList` calls it inside the each block. A drag that reruns the same derived chain rescans history on every pointer move. | Jank on long queues, and "pointer movement must not rescan" is unverifiable as written. | Add the three-layer derived structure below to the plan. |
| 7 | M | Mobile navigation is hard-coded to three links: `Navbar.svelte:100` uses a three-column grid at 720px and shrinks fonts at 360px. A fourth link at 360px leaves roughly 68px of text width per link, so "Dashboard" is at risk of overflow. | Wrapped or clipped nav on small phones. | Change to four columns, reduce link padding at 360px, and decide the labels. |
| 8 | M | The catalog search logic the plan wants to reuse lives inside `NewBookModal.svelte:202-294` as effects and handlers, not in a utility. `catalogClient.ts` only has request builders and decoders. | Copying it duplicates a delicate flow that the catalog e2e covers; adding a "plan mode" to the modal creates the oversized component the brief warns about. | Release 1 add dialog uses ISBN lookup plus manual entry only. Catalog linking happens at Start reading through the existing modal. Catalog search in the planner is a follow-up that first extracts the effect into a rune module. |
| 9 | M | The timeline as specified needs proportional segments, month and year ticks, overflow handling for many small books, and an interruption at unknown effort. None of that exists; the only chart primitives are dashboard bar and line helpers. | Largest single UI cost with the least verified need. | Ship year-boundary divider rows in the list instead; keep the bar for a later release. |
| 10 | M | "Cached results must identify that they may be incomplete" is not achievable with the current stores. `diagnosticSnapshot.ts:31-32` records `fromCache` for diagnostics only and stores emit plain arrays with an `undefined` loading sentinel. | An acceptance criterion with no data path. | Keep the sentinel semantics the dashboard uses. Show an offline notice from `navigator.onLine` as `BookList` does. Drop the incomplete-cache distinction from release 1. |
| 11 | M | Mandatory inclusion pushes stalled books into the forecast. The Reading list already segregates books unread for 60 days under a dusty divider (`BookList.svelte:61,772`). A stalled book in position 2 delays every later date. | Forecasts the reader does not believe. | Initial order puts dusty books last. Decide whether a "paused" state is needed. |
| 12 | M | Planned-entry authors. Book rules verify each author id with a document read (`validBookAuthorAt`). Repeating that on a private planning document costs rule budget for no shared-data benefit. | Slower, larger rules. | Store up to six author ids on planned entries without existence checks. New authors are resolved at add time via the existing `resolveBookAuthors`, offline refused with the modal's existing message. |
| 13 | M | Reorder accessibility has no precedent in the app. No drag code, no dnd dependency, one reduced-motion rule in `LaunchScreen.svelte`, and hover-only tooltips in `BookSummary.svelte:21`. | Must be designed, not copied. | Adopt the interaction spec below. |
| 14 | M | Book deletion leaves a `kind: 'book'` entry behind. `Database.deleteBook` deletes only the book, and older clients will keep doing that. | Orphan rows or a phantom future entry. | Join ignores entries with no matching book, and the new client's delete batch also deletes the entry. |
| 15 | L | Removal with undo needs a toast that does not exist; the app uses `confirm()` everywhere. | Small new component. | Release 1 uses confirm; undo is a follow-up or a user choice. |
| 16 | L | Route bookkeeping: `app-prefetch.ts:5` route list, `Footer.svelte:137` links, `docs/architecture/site-access.ts` rows, and the route table in the architecture README. | Stale maps and no code preload. | List these explicitly under Navigation. |
| 17 | L | Rank representation is unspecified. | Rebalancing ambiguity. | Doubles with midpoint insertion and a whole-queue renumber in the same batch when a gap drops below a threshold. The queue always fits one batch. |

On design language, here is what the code actually establishes, with the inconsistencies stated rather than smoothed over.

- **No tokens.** Custom properties exist only in the admin stylesheet. Colors are literal hex in every component. Bootstrap 5.3 CSS is global and supplies the grid, form controls, progress bar, and alert classes.
- **Two card styles.** Heavy cards with radius 5px and a double drop shadow in `BookList`, `StatCard`, `ModalCard`, and the dashboard. A light card with a hairline border, radius 8px, and a faint shadow in `BookSummary`. The planner should use the light card for the summary and for the queue container.
- **Teal family, not one teal.** Navbar 294f52 with 6f9b9d and edf5f5. Accent 1b7179 for progress and focus, 35686a for cover focus and the log pill, 2f666b for dashboard primary buttons, 1f6f78 for the shared button focus ring, cadetblue for the shared primary button, and a Bootstrap blue lookup button in the add-book modal. Reuse 2f666b for actions and 1b7179 for focus and progress; do not add another.
- **Status colors** are Bootstrap semantic: 198754 start, dc3545 stop, b42318 error text. Gray text at 8a9599 marks a borrowed pace; do not use it for essential text until a contrast check is done.
- **Typography.** Row text is em-scaled: authors and titles at 1.5em on desktop, 1em on mobile, labels uppercase and gray. Summary labels are 0.8rem uppercase 600 and values 1.5rem bold with tabular numerals. Titles are italic in the list, the dashboard table, and the progress section. Keep italic titles and tabular numerals.
- **Buttons.** At least six styles: navbar pill, nav link, shared `Button.svelte`, dashboard primary and secondary and quiet and danger, mobile action pills, catalog panel outline. The dashboard set is duplicated verbatim in `TimeTrackingSettings.svelte`. The planner should use the dashboard set for row actions and the mobile pills for the bottom-of-row actions on phones.
- **Dialogs.** Native dialog with a 400px card, primary and secondary buttons centered, fields with 2em side margins through `Input.svelte`, and an error banner inside the dialog. Reuse unchanged.
- **Row anatomy** on Reading: 56px cover, label over value in four right-aligned stat columns, action column above 770px, progress bar, pill actions below 770px, with the desktop and mobile split done in JavaScript via window width. The planner should do this split in CSS.
- **Widths and breakpoints.** Navbar content 1100px, dashboard 1200px, list rows inside the Bootstrap container with 3em margins. Breakpoints at 720, 768, 770, 520, and 360px. Use 770 and 360 to match the lists and navbar.
- **Focus.** White outline on the navbar, 2px teal on covers, 3px teal on shared buttons, a soft ring on toggles, and Bootstrap defaults on inputs. Use the 3px teal ring for handles and row buttons.
- **Status labels.** One pill pattern exists, the dashboard visibility badge with a leading dot. Extract it as a small badge component for Reading, New to your plan, Your estimate, and Pages unknown.
- **Dates and durations.** Full dates use en-US short month with year. Month plus year uses `formatMonthYear`. Durations use "12h 5m" in summaries and "HH:MM" in list columns. Use the summary form on the planner.

## Layouts, interaction, and states

**Desktop, 771px and up.** Same container as Reading. Summary in a light card, then one add button, then the queue as one light card with compact rows. Rows have a handle, position, cover, title and author, badge, remaining effort, and expected finish, with a disclosure for details.

```text
To read
┌──────────────────────────────────────────────────────────────────────┐
│ RECENT PACE      READING DAYS    LEFT IN QUEUE       QUEUE ENDS      │
│ 31 min a day     9 of 14         1,240 pages · 52h   Dec 2026        │
│ Sep 2 – Sep 15                                       6h to spare     │
│ At 31 minutes a day, these books take you through December 2026.     │
│ ─────────────────────────────────────────────────────────────────    │
│ Plan with [ 45 ] minutes a day   Use my recent pace   How this works │
└──────────────────────────────────────────────────────────────────────┘
                                                        [ + Add to plan ]
┌──────────────────────────────────────────────────────────────────────┐
│ ⠿ 1 [cover] The Name of the Wind      ● Reading   210 pp · 8h        │
│             Patrick Rothfuss                      Oct 2026        ▾  │
├──────────────────────────────────────────────────────────────────────┤
│ ⠿ 2 [cover] Golden Son                ● Reading   430 pp · 12h       │
│             Pierce Brown                          Nov 2026        ▴  │
│   Start Oct 5, 2026 · Finish Nov 14, 2026 · Page 14 of 444           │
│   1.69 min per page · from this book's sessions   [Edit estimate]    │
│   [Move up] [Move down] [Move to position: 2 ]  [Remove from plan]   │
├─────────────────────────────── 2027 ─────────────────────────────────┤
│ ⠿ 3 [cover] Anna Karenina             Planned     864 pp · about 43h │
│             Leo Tolstoy                           Feb 2027        ▾  │
├──────────────────────────────────────────────────────────────────────┤
│ ⠿ 4 [ A ]   A Book With Only A Title  Planned     Pages unknown      │
│             New to your plan                      No date         ▾  │
│   Add a page count to forecast this book and the ones after it.      │
│   [Add page count]  [Start reading]  [Remove from plan]              │
└──────────────────────────────────────────────────────────────────────┘
```

**Mobile, 770px and below.** Summary stats in two columns as `BookSummary` already does. Rows stack the numbers under the title. Details open the same panel with pill buttons.

```text
┌──────────────────────────────┐
│ RECENT PACE    READING DAYS  │
│ 31 min a day   9 of 14       │
│ LEFT           QUEUE ENDS    │
│ 52h            Dec 2026      │
│ At 31 minutes a day, these   │
│ books take you through       │
│ December 2026.               │
│ Plan with [45] min a day     │
└──────────────────────────────┘
        [ + Add to plan ]
┌──────────────────────────────┐
│ ⠿ [cv] The Name of the Wind  │
│        Rothfuss · Reading    │
│        8h left · Oct 2026  ▾ │
├──────────────────────────────┤
│ ⠿ [cv] Golden Son            │
│        Brown · Reading       │
│        12h left · Nov 2026 ▴ │
│   Start Oct 5 · Finish       │
│   Nov 14, 2026 · Page 14/444 │
│   1.69 min/page · this book  │
│   (Move up)(Move down)       │
│   (Edit estimate)            │
│   (Start reading)(Remove)    │
└──────────────────────────────┘
```

Default row fields: handle, position, cover, title, author, status badge, pages left, hours left, expected finish as month and year. Details: exact start and finish dates, current page, minutes per page with its source, the move controls, edit estimate, start reading, remove. Pace source and dates therefore never depend on hover.

**Add to plan** is a 400px dialog: title required, authors via the existing chips input, page count optional, ISBN with the existing look-up button. An ISBN or edition match against the library shows "You already have Anna Karenina in your library" with a "Use that book" action that scrolls to its row. **Edit estimate** is a dialog with "Automatic: 2.4 min per page, from your other fiction", a "Your estimate" field, a Clear link, and a live line "At 3.0 minutes per page this book needs about 43h". **Start reading** opens the existing add-book modal with header "Start reading" and primary "Start reading", prefilled from the entry. **How this works** is a disclosure under the summary with this copy:

```text
Daily time: 31 min a day is 434 minutes recorded Sep 2 – Sep 15 divided by 14.
Days with no reading count as zero. Today is not included; 12 of today's
31 minutes are still available.
Book time: pages left × minutes per page, from this book's own sessions or,
failing that, your other books by the same author, the same kind, or your
whole library.
The queue is read in order, one book at a time, sharing the same daily time.
Sessions count on the reading day they were saved; days change at 3 a.m.
A running timer is not counted until its session is saved.
```

**Reordering.** Pointer: pointer events on the handle only, with `touch-action: none` on the handle so the rest of the row still scrolls. Activation after 6px of movement. The dragged row gets a transform and reduced opacity; other rows shift with a short transition that is disabled under reduced motion. The drop target is the row whose vertical midpoint the pointer has crossed, shown by a 2px teal line. Escape, pointercancel, or release outside the list restores the previous order without writing. Keyboard: the handle is a button labelled "Reorder The Name of the Wind, position 1 of 8". Space or Enter grabs, arrow keys move by one, Home and End move to the ends, Space or Enter drops and writes, Escape cancels. Move up and Move down buttons and a Move to position input live in the details panel for people who never discover the grab pattern. Focus: after any move, refocus the same handle on the next tick, because a keyed row that moves in the DOM should be assumed to lose focus. Announcements: one polite live region on the page, updated only on drop, keyboard move, or cancel, with "Golden Son moved to position 3 of 8. Expected finish November 2026." Nothing is announced during pointer movement. Save failure: writes are fire-and-forget like every other write, so a rejected batch rolls the local cache back and the listener restores the stored order; the live region then says "Order not saved. Showing the saved order." and the global banner shows the reason.

**States and messages.**

- Loading: "Loading your plan" in a polite region until both books and entries have delivered a snapshot.
- Empty: "Nothing planned yet. Add a book you intend to read, or start one from Reading."
- Title only: badge "Pages unknown", note "Add a page count to forecast this book and the ones after it." Later rows show "No date" and the summary end reads "Dec 2026 + unknown".
- No pace anywhere: "No reading pace yet. Set minutes per page to forecast this book."
- Zero budget: summary "No reading recorded Sep 2 – Sep 15. Hours are shown; dates need a daily budget." with the Plan-with field focused.
- Sparse history: hint under Recent pace, "Based on 2 sessions on 2 of 14 days."
- Manual budget: badge "Scenario: 45 min a day" with "Use my recent pace". Manual pace: row note "Your estimate: 3.0 min per page".
- Offline: page notice "Offline. Showing your last synced plan; changes save when you reconnect."
- Active timer: row note "Timer running. Unsaved time is not included."
- Error: global banner plus the live-region sentence above.
- Long queue: year divider rows and a summary "Queue ends Mar 2029, about 2.5 years." No virtualization.

**Timeline.** Do not ship the bar in release 1. Year divider rows inside the list already answer "which book crosses into next year" and remain readable at any length. If a bar is added later: a CSS flex row with segments proportional to remaining minutes, a minimum segment width with overflow collapsed into "+4 more", month ticks only for the current year, one bar per year for longer queues, and a hatched terminal segment labelled "unknown from here" where effort is missing.

## Architecture, scope, and decisions

**Ordering and rank policy, exact.** Every entry sorts by rank ascending, ties by entry id ascending. Rank is a double. A book with no entry document is an implicit row. Implicit rows sort after all ranked rows by last-read time descending, then created time descending, then id, which reproduces the Reading list and puts dusty books last. Any write that changes order, meaning add, move, or move-to-position, also writes ranks for every implicit row in the same batch in their displayed order, so after the first interaction there are no implicit rows. New planned entries get the maximum rank plus 1024. A move writes the midpoint between neighbours. When the gap is below one millionth, the batch renumbers the whole queue in steps of 1024; the queue is bounded by unfinished books plus planned entries and always fits one batch, which a test asserts at 450 rows. A finished book's entry stays with its rank and is hidden; reopening shows it at that rank. An entry of kind book with no matching book is ignored by the join and deleted by the new client's book-delete batch. Duplicates are checked by ISBN and by edition id before creating a planned entry; a title match is only a warning.

**Derived layers, so a drag touches only the last one.**

1. `dayTotals` from the history store through the existing `aggregateSessionsByDay`, then `budget` from `dayTotals` and the current reading-day key. Recomputes when history or the day changes.
2. `effortById` from books, entries, library, and overrides: a map from entry id to pages left, pace, source, and minutes, using `paceFor` once per row. Recomputes on book or entry changes, never on drag.
3. `schedule` from the order array of ids, `effortById`, `budget`, and today's remaining minutes: one linear pass producing start and finish day keys and the year summary. During a drag only the order array changes, so only this pass runs.

**History source.** Reuse the all-history store for release 1. Both a bounded query and the full store are answered from the same persistent cache with the same completeness blindness, and the `owner, type, createdAt` composite index already exists so a bounded query would need no index. The bounded query has a real cost the plan does not mention: its cutoff is fixed at creation, so it must be re-issued at the 3 a.m. boundary, and a separate query label loses the shared lifecycle the prefetch test protects. The full store must be owned by the planner page, exactly as the dashboard owns it, and the prefetch test should gain a case that visiting `/to-read` opens history once and leaving releases it. Revisit a bounded query only if the decode of the history snapshot measures above roughly 50 ms on the reference library.

**Reuse map.** Reuse unchanged: `BookSummary` for the summary card, `ModalCard`, `Input`, `AuthorInput`, `paceFor` and `paceNote`, `aggregateSessionsByDay` and the day-boundary helpers, `formatMonthYear` and `formatReadingTime`, `validateBookTitle` and `validateBookPages`, `lookupIsbnSources` and `normalizeIsbn`, `acceptReportedWrite`, the cached-store and diagnostic-snapshot pattern, `repairableBookAuthors` and `formatAuthors`, and the global error banner. Extract small pieces: a cover component from the two identical cover branches in the list, a badge component from the dashboard visibility pill, and the dashboard button styles into one shared stylesheet since they are already copied once. Minimal changes to existing components: a `draft` and a `writer` prop on the add-book modal, an optional fixed id path inside `Database.addBook` shared with the planner writer, and the entry delete inside `deleteBook`. Keep separate and untouched: `BookList`, `ReadingSummary`, `ProgressSection`, and the catalog search effects. New: `src/lib/utils/readingPlan.ts` for the pure functions above and the rank helpers, `src/lib/utils/reorder.ts` for keyboard and pointer state as a plain testable module, `src/lib/interfaces/readingPlan.ts`, two decoders, five database methods, a page, a row component, an add dialog, and an estimate dialog.

**Data flow.** Page subscribes to books, entries, plan settings, authors, and history. The join produces the order array and the loading sentinel. Layers 1 to 3 run as above. Row actions call database methods that enqueue batches; the listeners echo the local cache immediately and the derived chain rerenders. No calculated date is stored.

**Rules.** Owner-only read and write on both collections with the existing account checks. Planned entry shape: title up to 500, page count positive integer or null, manual pace positive and at most 60, rank a finite number, up to six author ids without existence reads, cover URL https and at most 2048, ISBN at most 32, optional work and edition ids. Conversion to kind book requires `existsAfter` on the book path with the same id and clears the planned fields. Settings document: override positive or null.

**Bundle.** Estimated, not measured: about 9 to 12 KiB compressed for calculation, persistence, rules-side decoders, page and rows, two dialogs, and the reorder module without any dependency. The plan should say that the budget is raised once, in the implementation commit, by the measured increment plus 2 KiB, with a comment in the test in the existing style, and that the largest chunk stays untouched because nothing new enters the Firestore or layout chunks. No drag library, no chart library, no state library, no virtualization.

**PR #52 overlap, conditional.** If it contains a recent-minutes-per-day helper or a per-book effort helper, share exactly those two pure functions and nothing else. Do not adopt an uncertainty model or independent per-book scheduling; the queue's one shared daily budget is the product. If it changes the dashboard projection, the disagreement in finding 3 becomes the point of coordination.

**Release 1 scope.** Route, nav link with the four-column mobile fix, footer link, prefetch entry, and access-map rows. Queue of all unfinished books plus planned entries with the rank policy. Pointer and keyboard reordering with the move buttons. Summary card with recent pace, reading days, remaining pages and hours, queue end, the manual daily-budget scenario, and the assumptions disclosure. Rows with details, year dividers, estimate editor, add dialog with ISBN lookup and duplicate check, Start reading through the existing modal with the planner writer, removal with confirm. Rules, decoders, and tests. Deferred: timeline bar, catalog search inside the planner, undo toast, pausing a stalled book.

**Acceptance checks and test plan.** Reference sizes: 60 queue rows, 300 library books, 10,000 history documents. Unit: the schedule pass for 200 rows stays under 20 ms in Node; `paceFor` is called at most once per row per book change, verified with a counting double; fixed-date cases for today's remaining budget, adjacent small books sharing a day, a leap day, both daylight-saving transitions, December 31, unknown effort stopping later dates, seven 60-minute days averaging 30, rank midpoint and renumber. Rules emulator: owner-only, shapes, conversion with a fixed id, rejected second start, cross-user denial with a public profile. Store lifecycle: the prefetch test gains the planner case. Browser: add a planned title, reorder by keyboard, reload and confirm order, start reading and see it on Reading with the same order, remove. Accessibility, manual: keyboard-only completion of every action, one announcement per move with a screen reader, focus retained on the handle, 44px targets, reduced motion honoured, and a contrast check on any gray text before copying the borrowed-pace gray.

**Exact plan replacements.** Replace the two "Implicit entries" paragraphs with the rank policy paragraph above. Replace "Verify account deletion removes it" with the sentence in finding 4. Replace the "Summary and timeline" section's second and third paragraphs with: "Below the summary, the list shows a divider row wherever the expected finish crosses December 31, labelled with the new year, so the book that carries over is the first row under the divider. If the queue fits this year, the summary shows the spare reading hours; otherwise it shows the hours carried into the next year. A proportional timeline bar is a later extension." Add under "Fit with the existing codebase": "The dashboard's On deck list projects each book independently over 30 days. Release 1 labels it 'each book on its own time' and a later change makes it consume the queue forecast." Add under "Implementation areas": "Bundle: raise the total budget once by the measured increment plus 2 KiB; the largest chunk is unchanged." Replace "Cached results must identify that they may be incomplete" with "Loading is the undefined sentinel the dashboard uses; offline is shown from the browser's online state."

**Choices that need your preference**, separate from the engineering decisions above.

1. Year dividers only in release 1, or the timeline bar as well.
2. Add dialog with ISBN lookup and manual entry only, or catalog search extracted from the add-book modal first.
3. Removal with confirm, or an undo toast.
4. Whether an in-progress book can be paused out of the forecast while staying in the list.
5. Compact rows in one card, or one heavy card per book like Reading.
6. Nav labels on small phones: keep "Dashboard" with tighter padding, or shorten it.
7. Whether the dashboard On deck list should switch to the queue forecast now or later.
