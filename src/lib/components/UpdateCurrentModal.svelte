<script>
  import { createEventDispatcher } from "svelte";

  import ModalCard from "../components/ModalCard.svelte";
  import Input from "../components/Input.svelte";
  import { validateCurrentPage } from "../utils/validation";

  export let book;

  $: open = !!book;

  let inputPages;

  const dispatch = createEventDispatcher();

  function updateCurrentPage() {
    const { valid, message } = validateCurrentPage({
      inputPages,
      pageCount: book.pageCount,
    });

    if (!valid) {
      alert(message);
      return;
    }
    dispatch("updateCurrentPage", {
      id: book.id,
      currentPage: Number.parseInt(inputPages),
      previousPage: book.currentPage,
    });
    dispatch("closeModal");
  }
</script>

<ModalCard
  {open}
  on:close={() => dispatch('closeModal')}
  header={book.title}
  primaryAction={updateCurrentPage}
  primaryText="Update page">
  <Input label="Set current page" inputId="inputPages">
    <input
      id="inputPages"
      type="number"
      bind:value={inputPages}
      placeholder="What page are you on" />
  </Input>
</ModalCard>
