<script lang="ts">
  // Start reading a planned book: it becomes an ordinary personal book with
  // the entry's id and keeps its queue position, in one batch
  // (Database.startPlannedEntry). No timer starts and no time is recorded.
  import Input from '../Input.svelte';
  import ModalCard from '../ModalCard.svelte';
  import { Database } from '../../firebase/db.ts';
  import type { Author, AuthorChip } from '../../interfaces/author.ts';
  import type { PlannedEntry } from '../../interfaces/readingPlan.ts';
  import { resolveChip } from '../../utils/authors.ts';
  import { acceptReportedWrite } from '../../utils/offlineWrite.ts';
  import { validateBookPages } from '../../utils/validation.ts';

  let { userId, entry, authors, onclose }: {
    userId: string;
    entry: PlannedEntry | null;
    authors: Author[];
    onclose: () => void;
  } = $props();

  let pageCount = $state<number | null | undefined>(undefined);
  let currentPage = $state<number | null | undefined>(0);
  let error = $state('');
  let resolving = $state(false);
  let write = $state({ accepted: false });
  let seededFor: string | null = null;
  $effect(() => {
    if (entry === null) {
      seededFor = null;
      write.accepted = false;
      return;
    }
    if (seededFor === entry.id) return;
    seededFor = entry.id;
    pageCount = entry.pageCount ?? undefined;
    currentPage = 0;
    error = '';
  });

  // Saved authors with a catalog id become chips as they are; a typed name
  // resolves against the catalog now, and a still-new one is minted first.
  function chipsFor(planned: PlannedEntry): AuthorChip[] {
    return planned.authors.map((author) => (
      author.id === null ? resolveChip(author.name, authors) : { id: author.id, name: author.name }
    ));
  }

  async function start() {
    if (entry === null || resolving) return;
    const pages = validateBookPages({ pageCount, currentPage });
    if (!pages.valid) {
      error = pages.message;
      return;
    }
    let chips = chipsFor(entry);
    if (chips.some((chip) => chip.id !== null && 'unresolved' in chip)) {
      error = 'An author on this book no longer resolves. Edit the entry and choose a replacement first.';
      return;
    }
    if (chips.some((chip) => chip.id === null)) {
      if (!navigator.onLine) {
        error = 'Connect to create the new shared author, then try again.';
        return;
      }
      resolving = true;
      try {
        chips = await Database.resolveBookAuthors(chips);
      } catch (resolution) {
        error = resolution instanceof Error ? resolution.message : 'Could not create the shared author. Try again.';
        return;
      } finally {
        resolving = false;
      }
      if (entry === null) return;
    }
    const planned = entry;
    void acceptReportedWrite(
      write,
      () => Database.startPlannedEntry({
        userId,
        entry: planned,
        authorChips: chips,
        pageCount: pages.pageCount,
        currentPage: pages.currentPage,
      }),
      onclose,
      (failure) => { error = failure instanceof Error ? failure.message : String(failure); },
    );
  }
</script>

<style>
  .note {
    margin: 0 2em 0.75rem;
    font-size: 0.85rem;
    color: #53636a;
  }

  .error {
    margin: 0.5rem 2em 0;
    color: #d9534f;
    font-size: 0.85rem;
  }

  .space {
    height: 1em;
  }
</style>

<ModalCard
  open={entry !== null}
  header="Start reading"
  primaryText="Start reading"
  primaryDisabled={resolving || write.accepted}
  primaryAction={start}
  onclose={onclose}>
  {#if entry}
    <p class="note"><em>{entry.title}</em> becomes a book on your Reading list and keeps its place in the plan. No timer starts.</p>
    <Input label="Your edition's page count" inputId="start-page-count">
      <input id="start-page-count" class="form-control" type="number" inputmode="numeric" min="1" bind:value={pageCount} placeholder="How many pages are there?" />
    </Input>
    <div class="space"></div>
    <Input label="Current page" inputId="start-current-page">
      <input id="start-current-page" class="form-control" type="number" inputmode="numeric" min="0" bind:value={currentPage} />
    </Input>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  {/if}
</ModalCard>
