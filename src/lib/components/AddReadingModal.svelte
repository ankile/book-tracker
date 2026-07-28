<script lang="ts">
  import Input from "$lib/components/Input.svelte";
  import ModalCard from "$lib/components/ModalCard.svelte";
  import { validateReading } from "../utils/validation";
  import type { Book } from "../interfaces/book";

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
  let inputTime = $state<number>(initialTime);
  let inputPages = $state<number>(undefined);

  function addReading() {
    const { valid, message } = validateReading({
      inputTime,
      inputPages,
      previousPage: book.currentPage,
      pageCount: book.pageCount,
    });

    if (!valid) {
      alert(message);
      return;
    }
    onaddReading({
      id: book.id,
      timeRead: inputTime,
      currentPage: inputPages,
      previousPage: book.currentPage,
    });
    oncloseModal();
  }

  function closeModal() {
    oncloseModal();
  }
</script>

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
      placeholder="What page are you on"
      bind:value={inputPages} />
  </Input>
</ModalCard>
