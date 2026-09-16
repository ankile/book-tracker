<script lang="ts">
  // A reader-supplied minutes-per-page estimate for one queued book. It
  // overrides the automatic pace until cleared; the automatic value stays
  // visible beside it.
  import Input from '../Input.svelte';
  import ModalCard from '../ModalCard.svelte';
  import type { PlanEffort } from '../../utils/readingPlan.ts';
  import { effortSourceLabel, formatPace, type PlanRowView } from '../../utils/planView.ts';

  let { row, effort, onsave, onclose }: {
    row: PlanRowView | null;
    effort: PlanEffort | null;
    onsave: (minutesPerPage: number | null) => void;
    onclose: () => void;
  } = $props();

  let value = $state<number | null | undefined>(undefined);
  let error = $state('');
  let seededFor: string | null = null;
  $effect(() => {
    if (row === null) {
      seededFor = null;
      return;
    }
    if (seededFor === row.id) return;
    seededFor = row.id;
    value = row.manualMinutesPerPage ?? undefined;
    error = '';
  });

  function save() {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1000) {
      error = 'Enter minutes per page as a positive number up to 1000.';
      return;
    }
    onsave(value);
  }
</script>

<style>
  .automatic {
    margin: 0 2em;
    font-size: 0.85rem;
    color: #53636a;
  }

  .error {
    margin: 0.5rem 2em 0;
    color: #d9534f;
    font-size: 0.85rem;
  }

  .clear {
    margin: 1rem 2em 0;
    background: none;
    border: none;
    color: #1b7179;
    text-decoration: underline;
    cursor: pointer;
    padding: 0;
    min-height: 44px;
  }
</style>

<ModalCard
  open={row !== null}
  header="Your estimate"
  primaryText="Save estimate"
  primaryAction={save}
  onclose={onclose}>
  {#if row}
    <Input label="Minutes per page for {row.title}" inputId="plan-estimate">
      <input id="plan-estimate" class="form-control" type="number" inputmode="decimal" min="0.1" max="1000" step="0.1" bind:value placeholder="e.g. 2.5" />
    </Input>
    <p class="automatic">
      {#if effort?.automaticPace}
        Automatic: {formatPace(effort.automaticPace.minutesPerPage)} ({effortSourceLabel({ ...effort, source: effort.automaticPace.source })}).
      {:else}
        No automatic pace yet; your estimate is the only evidence.
      {/if}
    </p>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if row.manualMinutesPerPage !== null}
      <button type="button" class="clear" onclick={() => onsave(null)}>Clear my estimate</button>
    {/if}
  {/if}
</ModalCard>
