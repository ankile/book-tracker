<script>
  import { Label, Input } from "sveltestrap";

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
  <Label for="time">Time read this session (in minutes)</Label>
  <Input
    type="number"
    name="time"
    id="time"
    bind:value={inputTime}
    readonly={false}
    placeholder="Minutes of reading" />

  <Label for="pages">Current page</Label>
  <Input
    type="number"
    name="pages"
    id="pages"
    bind:value={inputPages}
    readonly={false}
    placeholder="What page are you on" />
</ModalCard>
