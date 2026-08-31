<script lang="ts">
  import { user } from '$lib/firebase/auth.ts';
  import { Database } from '$lib/firebase/db.ts';
  import type { Book } from '$lib/interfaces/book.ts';
  import BookList from '$lib/components/BookList.svelte';
  import NewBookModal from '$lib/components/NewBookModal.svelte';

  // A brand-new account lands here on an empty list with no way in except
  // the button on /me. Offer the first book right here — but only once the
  // library has actually loaded and holds no book at all, finished or not:
  // the store is undefined until the first snapshot, and a flash of "add
  // your first book" over a loading list would be wrong for everyone else.
  let allBooks = $state<Book[] | undefined>(undefined);
  $effect(() => {
    const current = $user;
    if (!current) return;
    const booksStore = Database.getAllBooks(current.uid);
    return booksStore.subscribe((books) => (allBooks = books));
  });
  const libraryEmpty = $derived(allBooks !== undefined && allBooks.length === 0);
  let firstBookModal = $state(false);
</script>

<style>
  .first-book {
    max-width: 700px;
    margin: 2rem auto;
    text-align: center;
  }

  .first-book p {
    margin-bottom: 1rem;
  }
</style>

{#if $user}
  {#if libraryEmpty}
    <div class="first-book">
      <p>Your library is empty.</p>
      <button type="button" class="btn btn-dark" onclick={() => (firstBookModal = true)}>
        Add your first book
      </button>
    </div>
  {/if}
  <NewBookModal open={firstBookModal} onclose={() => (firstBookModal = false)} userId={$user.uid} />
  <BookList finished={false} userId={$user.uid} />
{/if}
