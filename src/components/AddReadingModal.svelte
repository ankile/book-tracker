<script>
  import Input from "../components/Input.svelte";

  import { createEventDispatcher } from "svelte";
  import ModalCard from "../components/ModalCard.svelte";
  import { validateReading } from "../utils/validation";

  export let book;

  let inputTime;
  let inputPages;

  const dispatch = createEventDispatcher();

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
    dispatch("addReading", {
      id: book.id,
      timeRead: Number.parseInt(inputTime),
      currentPage: Number.parseInt(inputPages),
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
  <Input label="Minutes read">
    <input
      placeholder="Minutes of reading"
      bind:value={inputTime}
      type="number" />
  </Input>
  <div style="height: 8px;" />
  <Input label="Current page">
    <input
      type="number"
      placeholder="What page are you on"
      bind:value={inputPages} />
  </Input>
</ModalCard>
