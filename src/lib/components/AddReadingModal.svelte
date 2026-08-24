<script lang="ts">
  import Input from "$lib/components/Input.svelte";
  import ModalCard from "$lib/components/ModalCard.svelte";
  import { validateReading } from "../utils/validation.ts";
  import type { Book } from "../interfaces/book.ts";

  let {
    book,
    initialTime = undefined,
    onaddReading,
    oncloseModal
  }: {
    book: Book;
    initialTime?: number;
    onaddReading: (data: { id: string; timeRead: number; currentPage: number; previousPage: number }) => void;
    oncloseModal: () => void;
  } = $props();

  // The modal is created fresh each time it opens, so capturing the
  // initial value here is intentional.
  // svelte-ignore state_referenced_locally
  let inputTime = $state<number | null | undefined>(initialTime);
  let inputPages = $state<number | null | undefined>(undefined);

  // Projected end page from this book's historical pace (pages per minute)
  // and the minutes entered. Shown only as a placeholder until the user
  // either saves (the guess becomes the value) or adjusts it with the
  // ± buttons (which materialize it into the field).
  const guessedPage = $derived.by(() => {
    if (!book.pagesRead || !book.timeRead) return undefined;
    if (typeof inputTime !== 'number' || !Number.isFinite(inputTime) || inputTime <= 0) return undefined;
    const projected = book.currentPage + Math.round(inputTime * (book.pagesRead / book.timeRead));
    return Math.min(projected, book.pageCount);
  });

  const fieldEmpty = $derived(inputPages === undefined || inputPages === null);
  const effectivePages = $derived(fieldEmpty ? guessedPage : inputPages);

  function adjustPage(delta: number) {
    const base = fieldEmpty ? guessedPage : inputPages;
    if (typeof base !== 'number') return;
    inputPages = Math.max(0, Math.min(book.pageCount, base + delta));
  }

  function addReading() {
    const result = validateReading({
      inputTime,
      inputPages: effectivePages,
      previousPage: book.currentPage,
      pageCount: book.pageCount,
    });

    if (!result.valid) {
      alert(result.message);
      return;
    }
    onaddReading({
      id: book.id,
      timeRead: result.time,
      currentPage: result.pages,
      previousPage: book.currentPage,
    });
    oncloseModal();
  }

  function closeModal() {
    oncloseModal();
  }
</script>

<style>
  .adjust-row {
    display: flex;
    gap: 0.5em;
    justify-content: flex-end;
    margin: 0 2em 0.5em;
  }
</style>

<ModalCard
  open={!!book}
  onclose={closeModal}
  primaryText="Add"
  primaryAction={addReading}
  header={book.title}>
  <Input label="Minutes read" inputId="inputTime">
    <input
      id="inputTime"
      class="form-control"
      placeholder="Minutes of reading"
      bind:value={inputTime}
      type="number"
      inputmode="numeric" />
  </Input>
  <div style="height: 8px;"></div>
  <Input label="Current page" inputId="inputPagesReading">
    <input
      id="inputPagesReading"
      class="form-control"
      type="number"
      inputmode="numeric"
      placeholder={guessedPage !== undefined ? String(guessedPage) : "What page are you on"}
      bind:value={inputPages} />
  </Input>
  {#if guessedPage !== undefined || !fieldEmpty}
    <div class="adjust-row">
      <button type="button" class="btn btn-sm btn-outline-secondary" onclick={() => adjustPage(-5)}>−5</button>
      <button type="button" class="btn btn-sm btn-outline-secondary" onclick={() => adjustPage(-1)}>−1</button>
      <button type="button" class="btn btn-sm btn-outline-secondary" onclick={() => adjustPage(1)}>+1</button>
      <button type="button" class="btn btn-sm btn-outline-secondary" onclick={() => adjustPage(5)}>+5</button>
    </div>
  {/if}
</ModalCard>
