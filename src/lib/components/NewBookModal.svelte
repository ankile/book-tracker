<script>
  import ModalCard from "$lib/components/ModalCard.svelte";
  import Input from "$lib/components/Input.svelte";

  import { Database } from "../firebase/db";

  let { open, userId, book = null, onclose } = $props();

  let author = $state(book ? book.author : "");
  let title = $state(book ? book.title : "");
  let pageCount = $state(book ? book.pageCount : undefined);
  let currentPage = $state(book ? book.currentPage : 1);
  let isbn = $state(book ? book.isbn : "");

  let isEditMode = $derived(!!book);

  function addBook() {
    Database.addBook({
      userId,
      author,
      title,
      pageCount,
      currentPage,
      isbn,
    });
    onclose();
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
    onclose();
  }

  function handleSubmit() {
    if (isEditMode) {
      updateBook();
    } else {
      addBook();
    }
  }

  function handleDelete() {
    const confirmed = confirm(`Are you sure you want to delete "${book.title}"? This will delete all reading sessions for this book.`);
    if (confirmed) {
      Database.deleteBook(userId, book.id);
      onclose();
    }
  }
</script>

<style>
  .space {
    height: 1em;
  }

  .delete-button {
    background: none;
    border: none;
    color: #d9534f;
    cursor: pointer;
    font-size: 0.9rem;
    text-decoration: underline;
    padding: 0;
    margin-top: 1rem;
  }

  .delete-button:hover {
    color: #c9302c;
  }
</style>

<ModalCard
  {open}
  onclose={() => onclose()}
  header={isEditMode ? 'Edit book' : 'Add new book'}
  primaryText={isEditMode ? 'Update book' : 'Add book'}
  primaryAction={handleSubmit}>
  <Input label="Author" inputId="author">
    <input id="author" class="form-control" type="text" bind:value={author} placeholder="Name of author(s)" />
  </Input>

  <div class="space" />

  <Input label="Book title" inputId="title">
    <input id="title" class="form-control" type="text" bind:value={title} placeholder="Book title" />
  </Input>

  <div class="space" />

  <Input label="Number of pages" inputId="pageCount">
    <input
      id="pageCount"
      class="form-control"
      type="number"
      bind:value={pageCount}
      placeholder="How many pages are there?" />
  </Input>

  <div class="space" />

  <Input label="Current page" inputId="currentPage">
    <input
      id="currentPage"
      class="form-control"
      type="number"
      bind:value={currentPage}
      placeholder="Have you already started reading?" />
  </Input>

  <div class="space" />

  <Input label="ISBN number (optional)" inputId="isbn">
    <input id="isbn" class="form-control" type="text" bind:value={isbn} placeholder="ISBN" />
  </Input>

  {#if isEditMode}
    <button class="delete-button" onclick={handleDelete}>
      Delete this book
    </button>
  {/if}
</ModalCard>
