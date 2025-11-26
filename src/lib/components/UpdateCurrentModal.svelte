<script>
  import ModalCard from "$lib/components/ModalCard.svelte";
  import Input from "$lib/components/Input.svelte";
  import { validateCurrentPage } from "../utils/validation";

  let { book, onupdateCurrentPage, oncloseModal } = $props();

  let open = $derived(!!book);

  let inputPages = $state(undefined);

  function updateCurrentPage() {
    const { valid, message } = validateCurrentPage({
      inputPages,
      pageCount: book.pageCount,
    });

    if (!valid) {
      alert(message);
      return;
    }
    onupdateCurrentPage({
      id: book.id,
      currentPage: Number.parseInt(inputPages),
      previousPage: book.currentPage,
    });
    oncloseModal();
  }
</script>

<ModalCard
  {open}
  onclose={() => oncloseModal()}
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
