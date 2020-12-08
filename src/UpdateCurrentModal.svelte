<script>
  import {
    Button,
    Modal,
    ModalBody,
    ModalFooter,
    ModalHeader,
    Label,
    Input,
  } from "sveltestrap";

  import { createEventDispatcher } from "svelte";

  import { validateCurrentPage } from "./utils/validation";

  export let book;

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
    });
    dispatch("closeModal");
  }

  function closeModal() {
    dispatch("closeModal");
  }

  function handleKeyDown(event) {
    if (event.key === "Enter") {
      updateCurrentPage();
    }
  }
</script>

<div on:keydown={handleKeyDown}>
  <Modal isOpen={!!book} {closeModal} toggle={closeModal}>
    <ModalHeader {closeModal}>{book.title}</ModalHeader>
    <ModalBody>
      <Label for="pages">Set current page</Label>
      <Input
        type="number"
        name="pages"
        id="pages"
        bind:value={inputPages}
        readonly={false}
        placeholder="What page are you on" />
    </ModalBody>
    <ModalFooter>
      <Button color="secondary" on:click={closeModal}>Cancel</Button>
      <Button color="primary" on:click={updateCurrentPage}>Update page</Button>
    </ModalFooter>
  </Modal>
</div>
