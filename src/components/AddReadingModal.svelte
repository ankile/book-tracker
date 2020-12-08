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

  function handleKeyDown(event) {
    if (event.key === "Enter") {
      addReading();
    }
  }
</script>

<div on:keydown={handleKeyDown}>
  <Modal isOpen={!!book} {closeModal} toggle={closeModal}>
    <ModalHeader {closeModal}>{book.title}</ModalHeader>
    <ModalBody>
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
    </ModalBody>
    <ModalFooter>
      <Button color="secondary" on:click={closeModal}>Cancel</Button>
      <Button color="primary" on:click={addReading}>Add reading</Button>
    </ModalFooter>
  </Modal>
</div>
