<script lang="ts">
  import Input from "../components/Input.svelte";

  import { createEventDispatcher } from "svelte";
  import ModalCard from "../components/ModalCard.svelte";
  import { validateReading } from "../utils/validation";
  import type { Book } from "../interfaces/book";

  export let book: Book;

  let inputTime: number;
  let inputPages: number;

  const dispatch = createEventDispatcher();

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
    dispatch("addReading", {
      id: book.id,
      timeRead: inputTime,
      currentPage: inputPages,
      previousPage: book.currentPage,
    });
    dispatch("closeModal");
  }

  function closeModal() {
    dispatch("closeModal");
  }
</script>

<ModalCard
  open={!!book}
  on:close={closeModal}
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
