<script>
  import { createEventDispatcher } from "svelte";

  import ModalCard from "../components/ModalCard.svelte";
  import Input from "../components/Input.svelte";

  import { Database } from "../firebase/db";

  const dispatch = createEventDispatcher();

  export let open;
  export let userId;
  export let book = null;

  let author = book ? book.author : "";
  let title = book ? book.title : "";
  let pageCount = book ? book.pageCount : undefined;
  let currentPage = book ? book.currentPage : 1;
  let isbn = book ? book.isbn : "";

  $: isEditMode = !!book;

  function addBook() {
    Database.addBook({
      userId,
      author,
      title,
      pageCount,
      currentPage,
      isbn,
    });
    dispatch("close");
  }

  function updateBook() {
    Database.updateBook({
      userId,
      bookId: book.id,
      author,
      title,
      pageCount,
      isbn,
    });
    dispatch("close");
  }

  function handleSubmit() {
    if (isEditMode) {
      updateBook();
    } else {
      addBook();
    }
  }
</script>

<style>
  .space {
    height: 1em;
  }
</style>

<ModalCard
  {open}
  on:close={() => dispatch('close')}
  header={isEditMode ? 'Edit book' : 'Add new book'}
  primaryText={isEditMode ? 'Update book' : 'Add book'}
  primaryAction={handleSubmit}>
  <Input label="Author">
    <input type="text" bind:value={author} placeholder="Name of author(s)" />
  </Input>

  <div class="space" />

  <Input label="Book title">
    <input type="text" bind:value={title} placeholder="Book title" />
  </Input>

  <div class="space" />

  <Input label="Number of pages">
    <input
      type="number"
      bind:value={pageCount}
      placeholder="How many pages are there?" />
  </Input>

  <div class="space" />

  <Input label="Current page">
    <input
      type="number"
      bind:value={currentPage}
      placeholder="Have you already started reading?" />
  </Input>

  <div class="space" />

  <Input label="ISBN number (optional)">
    <input type="text" bind:value={isbn} placeholder="ISBN" />
  </Input>
</ModalCard>
