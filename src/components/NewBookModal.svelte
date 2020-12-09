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

  import { Database } from "../firebase/db";

  const dispatch = createEventDispatcher();

  export let open;
  export let userId;

  let author;
  let title;
  let pageCount;
  let currentPage = 1;
  let isbn;

  function addBook() {
    Database.addBook({
      userId,
      author,
      title,
      pageCount,
      currentPage,
      isbn,
    });
    dispatch("closeModal");
  }

  function closeModal() {
    dispatch("closeModal");
  }

  function handleKeyDown(event) {
    if (event.key === "Enter") {
      addBook();
    }
  }
</script>

<style>
  .space {
    height: 1em;
  }
</style>

<div on:keydown={handleKeyDown}>
  <Modal isOpen={open} {closeModal} toggle={closeModal}>
    <ModalHeader {closeModal}>Add new book</ModalHeader>
    <ModalBody style="text-align: left;">
      <Label class="label" for="author">Author</Label>
      <Input
        type="text"
        id="author"
        bind:value={author}
        readonly={false}
        placeholder="Name of author(s)" />
      <div class="space" />
      <Label class="label" for="title">Book title</Label>
      <Input
        type="text"
        id="title"
        bind:value={title}
        readonly={false}
        placeholder="Book title" />

      <div class="space" />
      <Label class="label" for="pageCount">Number of pages</Label>
      <Input
        type="number"
        id="pageCount"
        bind:value={pageCount}
        readonly={false}
        placeholder="How many pages are there?" />

      <div class="space" />
      <Label class="label" for="currentPage">Current page</Label>
      <Input
        type="number"
        id="currentPage"
        bind:value={currentPage}
        readonly={false}
        placeholder="Have you already started reading?" />

      <div class="space" />
      <Label class="label" for="isbn">ISBN number (optional)</Label>
      <Input
        type="text"
        id="isbn"
        bind:value={isbn}
        readonly={false}
        placeholder="ISBN" />
    </ModalBody>
    <ModalFooter>
      <Button color="secondary" on:click={closeModal}>Cancel</Button>
      <Button color="primary" on:click={addBook}>Add book</Button>
    </ModalFooter>
  </Modal>
</div>
