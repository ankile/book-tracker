<script lang="ts">
  import ModalCard from "$lib/components/ModalCard.svelte";
  import Input from "$lib/components/Input.svelte";
  import { validateCurrentPage } from "../utils/validation.ts";
  import type { Book } from "$lib/interfaces/book.ts";

  let {
    book, onupdateCurrentPage, oncloseModal,
  }: {
    book: Book;
    onupdateCurrentPage: (data: { id: string; currentPage: number; previousPage: number }) => void;
    oncloseModal: () => void;
  } = $props();

  let open = $derived(!!book);

  let inputPages = $state<number | null | undefined>(undefined);

  function updateCurrentPage() {
    const result = validateCurrentPage({
      inputPages,
      pageCount: book.pageCount,
    });

    if (!result.valid) {
      alert(result.message);
      return;
    }
    onupdateCurrentPage({
      id: book.id,
      currentPage: result.page,
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
      class="form-control"
      type="number"
      inputmode="numeric"
      bind:value={inputPages}
      placeholder="What page are you on" />
  </Input>
</ModalCard>
