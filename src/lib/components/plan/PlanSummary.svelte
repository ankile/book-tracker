<script lang="ts">
  // The plan's headline numbers and the sentence they add up to, with the
  // evidence behind the daily budget and the reader's scenario control.
  import BookSummary from '../BookSummary.svelte';
  import type { SnapshotState } from '../../firebase/db.ts';
  import type { PlanEntry, PlanSnapshot } from '../../interfaces/readingPlan.ts';
  import { PLAN_WINDOW_DAYS, type DailyBudget, type Schedule, type YearSummary } from '../../utils/readingPlan.ts';
  import { formatFullDate, formatHours, formatMonth } from '../../utils/planView.ts';

  let {
    budget, scenario, schedule, year, pagesLeft, rowCount, crossingTitle, historyState, planState, timerRunning, onscenario,
  }: {
    budget: DailyBudget;
    scenario: number | null;
    schedule: Schedule;
    year: YearSummary | null;
    pagesLeft: number;
    rowCount: number;
    crossingTitle: string | null;
    historyState: SnapshotState | undefined;
    planState: PlanSnapshot<PlanEntry[]> | undefined;
    timerRunning: boolean;
    onscenario: (minutes: number | null) => void;
  } = $props();

  const minutesPerDay = $derived(scenario ?? budget.minutesPerDay);
  const shortDate = (date: Date) => date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const window = $derived(`${shortDate(budget.windowStart)} – ${shortDate(budget.windowEnd)}`);

  const stats = $derived([
    {
      label: 'Reading per day',
      value: `${Math.round(minutesPerDay)} min`,
      hint: scenario === null
        ? `${window} · ${budget.readingDays} of ${PLAN_WINDOW_DAYS} days`
        : 'Your scenario',
    },
    { label: 'Pages left', value: pagesLeft.toLocaleString('en-US') + (schedule.unknownEntries > 0 ? ' +' : '') },
    {
      label: 'Hours left',
      value: formatHours(schedule.knownMinutes) + (schedule.unknownEntries > 0 ? ' +' : ''),
      hint: schedule.unknownEntries > 0
        ? `${schedule.unknownEntries} ${schedule.unknownEntries === 1 ? 'book needs' : 'books need'} a page count or pace`
        : undefined,
    },
    {
      label: 'Queue ends',
      value: schedule.end === null ? 'No forecast' : formatMonth(schedule.end),
      hint: schedule.end === null ? undefined : formatFullDate(schedule.end),
    },
  ]);

  const headline = $derived.by(() => {
    if (rowCount === 0) return '';
    if (minutesPerDay <= 0) {
      return `No reading recorded between ${window}. Set a daily scenario below to see dates.`;
    }
    if (!schedule.complete) {
      return `At ${Math.round(minutesPerDay)} minutes a day the known books take ${formatHours(schedule.knownMinutes)}; the queue's end needs every book's pages and pace.`;
    }
    const through = schedule.end === null ? '' : ` take you through ${formatMonth(schedule.end)}`;
    let sentence = `At ${Math.round(minutesPerDay)} minutes a day, these books${through}.`;
    if (year !== null) {
      sentence += year.endsThisYear
        ? ` That leaves about ${Math.round(year.spareHours ?? 0)} reading hours in ${year.year}.`
        : ` About ${Math.round(year.carriedHours ?? 0)} of those hours fall after December 31${crossingTitle === null ? '' : `; ${crossingTitle} crosses into ${year.year + 1}`}.`;
    }
    return sentence;
  });

  const evidence = $derived(scenario === null
    ? `Average of the ${PLAN_WINDOW_DAYS} completed reading days ${window}, days without reading included, from ${budget.sessions} saved ${budget.sessions === 1 ? 'session' : 'sessions'} across your library. Today's ${Math.round(budget.todayMinutes)} recorded minutes reduce today's budget and are not in the average. Sessions count on the day they were saved; a session that ran past the 3 a.m. boundary is not split. Book pace comes from lifetime evidence, not this window.`
    : `Your scenario replaces the measured ${Math.round(budget.minutesPerDay)} minutes a day (${window}). Today's ${Math.round(budget.todayMinutes)} recorded minutes still reduce today's budget.`);

  const historyNote = $derived.by(() => {
    if (historyState === undefined) return 'Loading reading history; the budget may still change.';
    if (historyState.hasPendingWrites) return 'A saved session is still waiting for the server; the budget includes it.';
    if (historyState.fromCache) return 'History shown from this device’s cache; it may be incomplete until the server confirms it.';
    return null;
  });

  const saveNote = $derived.by(() => {
    if (planState === undefined) return null;
    if (planState.hasPendingWrites) return 'Saving your plan…';
    if (planState.fromCache) return 'Plan shown from this device’s cache; not yet confirmed by the server.';
    return 'Plan saved.';
  });

  let scenarioInput = $state<number | null>(null);
  $effect(() => {
    scenarioInput = scenario;
  });
  const scenarioValid = $derived(typeof scenarioInput === 'number' && Number.isFinite(scenarioInput) && scenarioInput > 0 && scenarioInput <= 1440);
</script>

<style>
  .headline {
    margin: 0 0 0.75rem;
    font-size: 1.05rem;
    color: #253237;
    line-height: 1.5;
  }

  .evidence, .note {
    margin: 0.4rem 0 0;
    font-size: 0.8rem;
    color: #53636a;
    line-height: 1.5;
  }

  .note {
    color: #7a5a1a;
  }

  .scenario {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
    margin-top: 0.75rem;
  }

  .scenario label {
    font-size: 0.85rem;
    color: #53636a;
    font-weight: 600;
  }

  .scenario input {
    width: 6rem;
    min-height: 44px;
    padding: 0.4rem 0.6rem;
    border: 1px solid #ddd;
    border-radius: 4px;
    font-variant-numeric: tabular-nums;
  }

  .scenario input:focus {
    outline: none;
    border-color: #1b7179;
    box-shadow: 0 0 0 2px rgba(27, 113, 121, 0.15);
  }

  .scenario button {
    min-height: 44px;
    padding: 0.4rem 0.9rem;
    border: 1px solid #ccd4d4;
    border-radius: 6px;
    background: white;
    color: #1b7179;
    font-weight: 600;
    cursor: pointer;
  }

  .scenario button:disabled {
    color: #8a9599;
    cursor: not-allowed;
  }

  .scenario button:focus-visible {
    outline: 3px solid #1f6f78;
    outline-offset: 2px;
  }

  .save-state {
    margin: 0.75rem 0 0;
    font-size: 0.8rem;
    color: #53636a;
  }
</style>

<BookSummary label="Reading plan summary" testId="plan-summary" {stats}>
  {#if headline}<p class="headline" data-testid="plan-headline">{headline}</p>{/if}
  <p class="evidence">{evidence}</p>
  {#if historyNote}<p class="note" role="status">{historyNote}</p>{/if}
  {#if timerRunning}<p class="note">A reading timer is running; its unsaved progress is not included.</p>{/if}
  <form class="scenario" onsubmit={(event) => { event.preventDefault(); if (scenarioValid) onscenario(scenarioInput); }}>
    <label for="plan-scenario">Plan with</label>
    <input id="plan-scenario" type="number" inputmode="numeric" min="1" max="1440" step="1" bind:value={scenarioInput} placeholder={String(Math.round(budget.minutesPerDay))} />
    <span>minutes a day</span>
    <button type="submit" disabled={!scenarioValid}>Apply</button>
    {#if scenario !== null}
      <button type="button" onclick={() => onscenario(null)}>Use my recent pace</button>
    {/if}
  </form>
  {#if saveNote}<p class="save-state" role="status" data-testid="plan-save-state">{saveNote}</p>{/if}
</BookSummary>
