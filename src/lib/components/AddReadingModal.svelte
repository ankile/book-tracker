<script lang="ts">
  import Input from "$lib/components/Input.svelte";
  import ModalCard from "$lib/components/ModalCard.svelte";
  import { validateReading } from "../utils/validation";
  import type { Book } from "../interfaces/book";

  let {
    book,
    onaddReading,
    oncloseModal
  }: {
    book: Book;
    onaddReading: (data: { id: string; timeRead: number; currentPage: number; previousPage: number }) => void;
    oncloseModal: () => void;
  } = $props();

  let inputTime = $state<number>(undefined);
  let inputPages = $state<number>(undefined);

  function addReading() {
    console.log(inputTime + inputPages);
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
      placeholder="Minutes of reading"
      bind:value={inputTime}
      type="number" />
  </Input>
  <div style="height: 8px;" />
  <Input label="Current page" inputId="inputPagesReading">
    <input
      id="inputPagesReading"
      type="number"
      placeholder="What page are you on"
      bind:value={inputPages} />
  </Input>
</ModalCard>
