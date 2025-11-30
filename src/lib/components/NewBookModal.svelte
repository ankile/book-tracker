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
  let isLookingUp = $state(false);
  let lookupError = $state("");

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

  async function lookupISBN() {
    if (!isbn.trim()) {
      lookupError = "Please enter an ISBN first";
      return;
    }

    isLookingUp = true;
    lookupError = "";

    try {
      const response = await fetch(
        `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn.trim()}&format=json&jscmd=data`
      );

      if (!response.ok) {
        throw new Error("Network error");
      }

      const data = await response.json();
      const bookData = data[`ISBN:${isbn.trim()}`];

      if (!bookData) {
        lookupError = "No book found for this ISBN";
        return;
      }

      // Auto-fill fields (always overwrite when looking up)
      if (bookData.title) {
        title = bookData.title;
      }

      if (bookData.authors && bookData.authors.length > 0) {
        author = bookData.authors.map(a => a.name).join(", ");
      }

      if (bookData.number_of_pages) {
        pageCount = bookData.number_of_pages;
      }

    } catch (error) {
      lookupError = "Failed to look up ISBN. Please try again.";
      console.error("ISBN lookup error:", error);
    } finally {
      isLookingUp = false;
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

  .isbn-container {
    display: flex;
    gap: 0.5rem;
    align-items: flex-start;
  }

  .isbn-input-wrapper {
    flex: 1;
  }

  .lookup-button {
    padding: 0.375rem 0.75rem;
    background-color: #007bff;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.9rem;
    white-space: nowrap;
    height: fit-content;
    margin-top: 1.6rem;
  }

  .lookup-button:hover:not(:disabled) {
    background-color: #0056b3;
  }

  .lookup-button:disabled {
    background-color: #6c757d;
    cursor: not-allowed;
  }

  .lookup-error {
    color: #d9534f;
    font-size: 0.85rem;
    margin-top: 0.25rem;
  }

  .lookup-success {
    color: #5cb85c;
    font-size: 0.85rem;
    margin-top: 0.25rem;
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

  <div class="isbn-container">
    <div class="isbn-input-wrapper">
      <Input label="ISBN number (optional)" inputId="isbn">
        <input id="isbn" class="form-control" type="text" bind:value={isbn} placeholder="ISBN" />
      </Input>
    </div>
    <button
      class="lookup-button"
      onclick={lookupISBN}
      disabled={isLookingUp || !isbn.trim()}>
      {isLookingUp ? 'Looking up...' : 'Look up'}
    </button>
  </div>

  {#if lookupError}
    <div class="lookup-error">{lookupError}</div>
  {/if}

  {#if isEditMode}
    <button class="delete-button" onclick={handleDelete}>
      Delete this book
    </button>
  {/if}
</ModalCard>
