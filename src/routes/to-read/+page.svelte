<script lang="ts">
  // The to-read queue and completion forecast (docs/to-read-plan.md). Three
  // reactive stages: the recent daily budget from session history, an
  // effort map keyed by row that rank changes never invalidate, and the
  // cumulative schedule for the order on screen, which is all a drag
  // recomputes. This route owns the history and plan listeners.
  import { user } from '$lib/firebase/auth.ts';
  import { Database, type PlanEntryWrite, type SnapshotState } from '$lib/firebase/db.ts';
  import type { Author } from '$lib/interfaces/author.ts';
  import type { Book } from '$lib/interfaces/book.ts';
  import type { BookUpdate } from '$lib/interfaces/reading.ts';
  import type { PlanEntry, PlanSnapshot, PlannedEntry, ReadingPlanSettings } from '$lib/interfaces/readingPlan.ts';
  import {
    RANK_STEP,
    dailyBudget,
    planMaterialize,
    planMove,
    scheduleQueue,
    yearSummary,
    type QueueRow,
    type RankWrite,
  } from '$lib/utils/readingPlan.ts';
  import { buildPlanRows, updateEffortMap, type EffortCacheEntry, type PlanRowView } from '$lib/utils/planView.ts';
  import PlanSummary from '$lib/components/plan/PlanSummary.svelte';
  import PlanQueue from '$lib/components/plan/PlanQueue.svelte';
  import PlanBookModal, { type PlannedEntryFields } from '$lib/components/plan/PlanBookModal.svelte';
  import StartReadingModal from '$lib/components/plan/StartReadingModal.svelte';
  import EstimateModal from '$lib/components/plan/EstimateModal.svelte';

  // Refreshed auth objects for the same account must not restart the
  // page-owned listeners, especially the full reading history.
  const userId = $derived($user?.uid);

  let allBooks = $state<Book[] | undefined>(undefined);
  $effect(() => {
    if (!userId) return;
    return Database.getAllBooks(userId).subscribe((books) => (allBooks = books));
  });
  // The Reading list's order seeds the position of books not yet placed.
  let readingBooks = $state<Book[]>([]);
  $effect(() => {
    if (!userId) return;
    return Database.getBooks(userId, false).subscribe((books) => (readingBooks = books));
  });
  let authorList = $state<Author[] | undefined>(undefined);
  $effect(() => {
    if (!userId) return;
    return Database.getAuthors().subscribe((authors) => (authorList = authors));
  });
  const authorMap = $derived(authorList === undefined ? null : new Map(authorList.map((author) => [author.id, author])));

  let allSessions = $state<BookUpdate[] | undefined>(undefined);
  $effect(() => {
    if (!userId) return;
    return Database.getAllReadingSessions(userId).subscribe((sessions) => (allSessions = sessions));
  });
  let historyState = $state<SnapshotState | undefined>(undefined);
  $effect(() => {
    if (!userId) return;
    return Database.getReadingHistoryState(userId).subscribe((state) => (historyState = state));
  });
  let plan = $state<PlanSnapshot<PlanEntry[]> | undefined>(undefined);
  $effect(() => {
    if (!userId) return;
    return Database.getReadingPlan(userId).subscribe((snapshot) => (plan = snapshot));
  });
  let settings = $state<ReadingPlanSettings | null | undefined>(undefined);
  $effect(() => {
    if (!userId) return;
    return Database.getReadingPlanSettings(userId).subscribe((value) => (settings = value));
  });

  // The clock: once a minute and on resume, so the reading-day boundary
  // and a day change while the tab was hidden both rebuild the window.
  let now = $state(new Date());
  $effect(() => {
    const tick = () => (now = new Date());
    const interval = window.setInterval(tick, 60_000);
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  });

  // Stage 1: the measured budget, or the reader's scenario in its place.
  const budget = $derived(dailyBudget(allSessions ?? [], now));
  const scenario = $derived(settings?.dailyMinutesOverride ?? null);
  const effectiveBudget = $derived({
    minutesPerDay: scenario ?? budget.minutesPerDay,
    todayMinutes: budget.todayMinutes,
  });

  // The stored queue.
  const rows = $derived(buildPlanRows(plan?.value ?? [], readingBooks, authorMap));
  const rowsById = $derived(new Map(rows.map((row) => [row.id, row])));

  // Stage 2: effort per row, memoised on its inputs (planView.ts).
  let effortCache: ReadonlyMap<string, EffortCacheEntry> = new Map();
  const effortMap = $derived.by(() => {
    const { map } = updateEffortMap(effortCache, rows, allBooks ?? []);
    effortCache = map;
    return map;
  });

  // The order on screen: the stored order, or the reader's in-progress or
  // just-dropped order until the store catches up. Rows the store has
  // since dropped disappear; new ones append.
  let previewOrder = $state<string[] | null>(null);
  const visibleRows = $derived.by(() => {
    if (previewOrder === null) return rows;
    const seen = new Set<string>();
    const ordered: PlanRowView[] = [];
    for (const id of previewOrder) {
      const row = rowsById.get(id);
      if (row === undefined) continue;
      seen.add(id);
      ordered.push(row);
    }
    return [...ordered, ...rows.filter((row) => !seen.has(row.id))];
  });
  $effect(() => {
    if (previewOrder === null) return;
    const stored = rows.map((row) => row.id);
    if (stored.length === previewOrder.length && stored.every((id, index) => id === previewOrder?.[index])) {
      previewOrder = null;
    }
  });

  // Stage 3: the schedule for the order on screen.
  const schedule = $derived(scheduleQueue(
    visibleRows.map((row) => ({ id: row.id, effort: effortMap.get(row.id)!.effort })),
    effectiveBudget,
    now,
  ));
  const year = $derived(yearSummary(schedule, effectiveBudget, now));
  const pagesLeft = $derived(visibleRows.reduce((sum, row) => sum + (effortMap.get(row.id)?.effort.remainingPages ?? 0), 0));

  const queueRows = (): QueueRow[] => rows.map((row) => ({ id: row.id, kind: row.kind, rank: row.rank }));
  const toWrites = (writes: readonly RankWrite[]): PlanEntryWrite[] => writes.map((write) => (
    rowsById.get(write.id)?.rank === null
      ? { id: write.id, create: true, rank: write.rank, manualMinutesPerPage: null }
      : { id: write.id, create: false, rank: write.rank }
  ));

  // Persist a move. The preview keeps the dropped order on screen until the
  // store confirms it; a rejection restores the stored order and the global
  // banner explains it (Database.reportWriteFailures).
  function move(id: string, to: number) {
    const stored = queueRows();
    const fromStored = stored.findIndex((row) => row.id === id);
    if (!userId || fromStored < 0 || fromStored === to) {
      previewOrder = null;
      return;
    }
    const moved = planMove(stored, fromStored, to);
    previewOrder = moved.order.map((row) => row.id);
    void Database.writePlanEntries({ userId, writes: toWrites(moved.writes) }).catch(() => {
      previewOrder = null;
    });
  }

  let addModal = $state(false);
  let editEntry = $state<PlannedEntry | null>(null);
  let startEntry = $state<PlannedEntry | null>(null);
  let estimateRow = $state<PlanRowView | null>(null);

  // A new intention lands below everything, including books not yet placed.
  function addPlanned(fields: PlannedEntryFields): Promise<void> {
    if (!userId) throw new Error('Sign in to plan books.');
    const stored = queueRows();
    const last = stored.at(-1);
    const positionWrites = last === undefined ? [] : planMaterialize(stored, last.id);
    const highest = Math.max(0, ...stored.map((row) => row.rank ?? 0), ...positionWrites.map((write) => write.rank));
    return Database.addPlannedEntry({ userId, rank: highest + RANK_STEP, positionWrites: toWrites(positionWrites), ...fields });
  }

  function updatePlanned(fields: PlannedEntryFields): Promise<void> {
    if (!userId || editEntry === null) throw new Error('No planned book is being edited.');
    return Database.updatePlannedEntry({ userId, entryId: editEntry.id, ...fields });
  }

  function remove(row: PlanRowView) {
    if (!userId || row.entry?.kind !== 'planned') return;
    if (!confirm(`Remove "${row.title}" from your plan?`)) return;
    void Database.removePlannedEntry({ userId, entryId: row.id, title: row.title });
  }

  // A manual estimate on a book not yet placed positions it first, in the
  // same batch, so the estimate has a document to live on.
  function saveEstimate(value: number | null) {
    const row = estimateRow;
    estimateRow = null;
    if (!userId || row === null) return;
    const writes = toWrites(planMaterialize(queueRows(), row.id));
    const own = writes.find((write) => write.id === row.id);
    if (own !== undefined) own.manualMinutesPerPage = value;
    else writes.push({ id: row.id, create: false, manualMinutesPerPage: value });
    void Database.writePlanEntries({ userId, writes });
  }

  function saveScenario(value: number | null) {
    if (!userId) return;
    void Database.setReadingPlanScenario({ userId, dailyMinutesOverride: value });
  }

  const loading = $derived(allBooks === undefined || plan === undefined || allSessions === undefined);
</script>

<style>
  .page {
    width: min(100%, 1100px);
    margin: 0 auto;
    padding: 0 1rem 3rem;
    text-align: left;
  }

  .heading {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
    margin: 0.5rem 0 1rem;
  }

  h1 {
    font-size: 1.6rem;
    margin: 0;
  }

  .add {
    min-height: 44px;
    padding: 0.5rem 1.1rem;
    border: 0;
    border-radius: 8px;
    background: #1b7179;
    color: white;
    font-weight: 600;
    cursor: pointer;
  }

  .add:focus-visible {
    outline: 3px solid #1f6f78;
    outline-offset: 2px;
  }

  .loading, .empty {
    color: #53636a;
    padding: 2rem 0;
  }
</style>

{#if $user}
  <div class="page">
    <div class="heading">
      <h1>To read</h1>
      <button type="button" class="add" onclick={() => (addModal = true)}>+ Add to plan</button>
    </div>
    {#if loading}
      <p class="loading" role="status">Loading your plan…</p>
    {:else}
      <PlanSummary
        {budget}
        {scenario}
        {schedule}
        {year}
        {pagesLeft}
        rowCount={visibleRows.length}
        crossingTitle={year?.crossingEntryId ? rowsById.get(year.crossingEntryId)?.title ?? null : null}
        {historyState}
        planState={plan}
        timerRunning={visibleRows.some((row) => row.timerRunning)}
        onscenario={saveScenario}
      />
      {#if visibleRows.length === 0}
        <p class="empty">Nothing planned yet. Add a book you mean to read, or start one from the Reading list.</p>
      {:else}
        <PlanQueue
          rows={visibleRows}
          {schedule}
          onpreview={(order) => (previewOrder = order)}
          onmove={move}
          onstart={(row) => (startEntry = row.entry?.kind === 'planned' ? row.entry : null)}
          onedit={(row) => (editEntry = row.entry?.kind === 'planned' ? row.entry : null)}
          onremove={remove}
          onestimate={(row) => (estimateRow = row)}
        />
      {/if}
    {/if}
  </div>

  <PlanBookModal
    open={addModal || editEntry !== null}
    userId={$user.uid}
    entry={editEntry}
    plannedEntries={(plan?.value ?? []).filter((entry): entry is PlannedEntry => entry.kind === 'planned')}
    onsave={editEntry === null ? addPlanned : updatePlanned}
    onclose={() => { addModal = false; editEntry = null; }}
  />
  <StartReadingModal
    userId={$user.uid}
    entry={startEntry}
    authors={authorList ?? []}
    onclose={() => (startEntry = null)}
  />
  <EstimateModal
    row={estimateRow}
    effort={estimateRow === null ? null : effortMap.get(estimateRow.id)?.effort ?? null}
    onsave={saveEstimate}
    onclose={() => (estimateRow = null)}
  />
{/if}
