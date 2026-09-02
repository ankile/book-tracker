<script lang="ts">
  import type { PickerOption } from '$lib/utils/adminCatalogView.ts';

  // One catalog record chosen from many: a search box over the options
  // and the matches as rows that say enough to tell two apart (title,
  // authors, id, counts, date). In single mode the choice replaces the box
  // with the chosen row and a Change button; in add mode every choice is
  // handed to the parent (a list of sources, of authors) and the box stays.
  // Records that cannot be chosen (the current work, a source, an alias)
  // are excluded by the parent, not greyed out.
  interface Props {
    label: string;
    hint?: string;
    options: readonly PickerOption[];
    value?: string;
    exclude?: readonly string[];
    // What an empty choice means in single mode ("Blank unlinks the books").
    blankMeans?: string;
    add?: boolean;
    onpick?: (id: string) => void;
  }

  let {
    label, hint = '', options, value = $bindable(''), exclude = [], blankMeans = '', add = false, onpick,
  }: Props = $props();

  const SHOWN = 25;
  let query = $state('');
  const excluded = $derived(new Set(exclude));
  const chosen = $derived(add ? null : options.find((option) => option.id === value) ?? null);
  const matches = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    const pool = options.filter((option) => !excluded.has(option.id));
    return needle === '' ? pool : pool.filter((option) => option.search.includes(needle));
  });
  const shown = $derived(matches.slice(0, SHOWN));

  function pick(option: PickerOption): void {
    query = '';
    if (add) {
      onpick?.(option.id);
    } else {
      value = option.id;
    }
  }
</script>

<div class="picker">
  <div class="picker-label">{label}{#if hint}<small>{hint}</small>{/if}</div>
  {#if !add && value !== ''}
    <div class="picked" role="group" aria-label={label}>
      <div class="row-text">
        {#if chosen !== null}
          <strong>{chosen.title}</strong><small>{chosen.detail}</small><small>{chosen.meta}</small>
        {:else}
          <strong>{value}</strong><small>Not in the catalog scan; check the id.</small>
        {/if}
      </div>
      <button type="button" onclick={() => (value = '')}>Change</button>
    </div>
  {:else}
    {#if blankMeans}<p class="blank">{blankMeans}</p>{/if}
    <input type="search" aria-label={label} placeholder="Type a title, name, id or ISBN" bind:value={query} autocomplete="off" />
    <ul class="picker-list">
      {#each shown as option (option.id)}
        <li>
          <button type="button" onclick={() => pick(option)}>
            <strong>{option.title}</strong><small>{option.detail}</small><small>{option.meta}</small>
          </button>
        </li>
      {:else}
        <li class="note">{query.trim() === '' ? 'Nothing to choose from.' : 'No match.'}</li>
      {/each}
      {#if matches.length > shown.length}
        <li class="note">{matches.length - shown.length} more; keep typing to narrow it down.</li>
      {/if}
    </ul>
  {/if}
</div>

<style>
  /* A picker takes a whole row of the dialog's form grid: its list needs
     the width, and two side by side read as one. */
  .picker {
    display: grid;
    grid-column: 1 / -1;
    gap: 0.3rem;
    min-width: 0;
  }

  .picker-label {
    display: grid;
    gap: 0.15rem;
    color: #3f4d4a;
    font-size: 0.86rem;
    font-weight: 650;
  }

  .picker-label small,
  .blank {
    color: #6b7673;
    font-size: 0.8rem;
    font-weight: 400;
  }

  .blank {
    margin: 0;
  }

  .picked {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.55rem 0.75rem;
    background: #f5f8f8;
    border: 1px solid #d3dad8;
    border-radius: 9px;
  }

  .row-text {
    display: grid;
    gap: 0.1rem;
    min-width: 0;
  }

  .row-text strong {
    font-weight: 650;
  }

  .row-text small,
  .picker .picker-list small {
    display: block;
    color: #6b7673;
    font-size: 0.8rem;
    overflow-wrap: anywhere;
  }

  .picker-list {
    max-height: 13rem;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
    border: 1px solid #d3dad8;
    border-radius: 9px;
  }

  .picker-list li + li {
    border-top: 1px solid #e4e9e7;
  }

  /* The console's button rule centres a grid's column with justify-content;
     one full-width column, aligned to the start, keeps every line flush. */
  .picker .picker-list button {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    justify-content: start;
    justify-items: start;
    gap: 0.1rem;
    width: 100%;
    min-height: auto;
    padding: 0.45rem 0.75rem;
    text-align: left;
    background: white;
    border: 0;
    border-radius: 0;
  }

  .picker .picker-list button:hover {
    background: #eef4f4;
  }

  .picker .picker-list button strong {
    font-weight: 650;
  }

  .note {
    padding: 0.55rem 0.75rem;
    color: #6b7673;
    font-size: 0.86rem;
  }
</style>
