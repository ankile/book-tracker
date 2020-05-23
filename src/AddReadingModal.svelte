<script>
  import {
    Button,
    Modal,
    ModalBody,
    ModalFooter,
    ModalHeader,
    Label,
    Input
  } from "sveltestrap";

  import { createEventDispatcher } from "svelte";

  export let book;

  let inputTime;
  let inputPages;

  const dispatch = createEventDispatcher();

  function addReading() {
    dispatch("addReading", {
      id: book.id,
      timeRead: Number.parseInt(inputTime),
      currentPage: Number.parseInt(inputPages),
      previousPage: book.currentPage
    });
    dispatch("closeModal");
  }

  function closeModal() {
    dispatch("closeModal");
  }
</script>

<div>
  <Modal isOpen={!!book} {closeModal}>
    <ModalHeader {closeModal}>{book.title}</ModalHeader>
    <ModalBody>
      <Label for="time">Time in minutes</Label>
      <Input
        type="number"
        name="time"
        id="time"
        bind:value={inputTime}
        placeholder="Minutes of reading" />
      <Label for="exampleEmail">Pages read</Label>
      <Input
        type="numbers"
        name="pages"
        id="pages"
        bind:value={inputPages}
        placeholder="Number of pages read" />
    </ModalBody>
    <ModalFooter>
      <Button color="primary" on:click={addReading}>Add reading</Button>
      <Button color="secondary" on:click={closeModal}>Cancel</Button>
    </ModalFooter>
  </Modal>
</div>
