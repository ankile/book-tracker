<script lang="ts">
  import { user } from '$lib/firebase/auth.ts';
  import { Database } from '$lib/firebase/db.ts';
  import NewBookModal from '$lib/components/NewBookModal.svelte';
  import { bookAuthors, formatAuthors } from '$lib/utils/authors.ts';
  import { groupByStatus } from '$lib/utils/metadataHealth.ts';
  import type { Author } from '$lib/interfaces/author.ts';
  import type { Book } from '$lib/interfaces/book.ts';

  let allBooks = $state<Book[] | undefined>(undefined);
  $effect(() => {
    if ($user) {
      const booksStore = Database.getAllBooks($user.uid);
      const unsubscribe = booksStore.subscribe((data) => (allBooks = data));
      return unsubscribe;
    }
  });

  let authorList = $state<Author[] | undefined>(undefined);
  $effect(() => {
    if ($user) {
      const authorsStore = Database.getAuthors($user.uid);
      const unsubscribe = authorsStore.subscribe((data) => (authorList = data));
      return unsubscribe;
    }
  });
  let authorMap = $derived(authorList === undefined ? null : new Map(authorList.map((a) => [a.id, a])));

  const groups = $derived(groupByStatus(allBooks ?? []));
  const total = $derived(groups.reduce((sum, group) => sum + group.books.length, 0));

  // Repairs go through the same edit modal the book list uses: its ISBN
  // field, Look up button (Open Library + Google Books) and save path are
  // exactly what fixing one of these books needs, so nothing is duplicated
  // here. The live snapshot drops the row as soon as the write applies.
  let editBook = $state<Book | null>(null);

  function authorNames(book: Book): string {
    const resolved = bookAuthors(book, authorMap);
    return resolved === null ? '' : formatAuthors(resolved);
  }
</script>

<style>
  .isbns-container {
    max-width: 900px;
    margin: 0 auto;
    padding: 0 1rem 2rem;
  }

  h1 {
    font-size: 1.6rem;
    margin: 1rem 0;
  }

  .hint {
    color: #666;
    font-size: 0.9rem;
    margin-bottom: 1.5rem;
  }

  .group {
    background: white;
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    padding: 1rem 1.5rem;
    margin-bottom: 1.5rem;
    overflow-x: auto;
  }

  .group-heading {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
  }

  h2 {
    font-size: 1.1rem;
    margin: 0;
  }

  .group-count {
    color: #666;
    font-size: 0.9rem;
  }

  .group-hint {
    color: #777;
    font-size: 0.85rem;
    margin: 0 0 0.75rem;
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }

  th,
  td {
    text-align: left;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid #eee;
  }

  th {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: #666;
  }

  tr:last-child td {
    border-bottom: none;
  }

  .author-cell {
    color: #666;
    font-size: 0.9rem;
  }

  .isbn-cell {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.9rem;
    color: #555;
  }

  .isbn-cell.empty {
    color: #999;
    font-style: italic;
    font-family: inherit;
  }

  .actions-cell {
    text-align: right;
    white-space: nowrap;
  }

  .row-action {
    background: none;
    border: none;
    color: #007bff;
    cursor: pointer;
    font-size: 0.9rem;
    text-decoration: underline;
    padding: 0 0.3rem;
  }

  .all-clear {
    color: #198754;
  }
</style>

<div class="isbns-container">
  <h1>Book metadata</h1>
  <p class="hint">
    Covers, genres and the fiction flag all come from a book's ISBN, so a
    missing or mistyped one leaves the book blank. Fix opens the same editor
    the book list uses — correct the ISBN, press Look up, then Update book.
  </p>

  {#if allBooks === undefined}
    <p>Loading…</p>
  {:else if total === 0}
    <p class="all-clear">Every book has a valid ISBN and a cover. Nothing to fix.</p>
  {:else}
    {#each groups as group (group.status)}
      <div class="group">
        <div class="group-heading">
          <h2>{group.label}</h2>
          <span class="group-count">{group.books.length} book{group.books.length === 1 ? '' : 's'}</span>
        </div>
        <p class="group-hint">
          {#if group.status === 'isbn-missing'}
            Nothing to look up yet — find the ISBN on the back cover or copyright page.
          {:else if group.status === 'isbn-invalid'}
            These fail the ISBN check digit, so they are typos rather than real ISBNs.
          {:else if group.status === 'no-metadata'}
            Valid ISBNs that neither Open Library nor Google Books knows — usually a
            local edition. Another edition's ISBN for the same book normally works.
          {:else}
            Everything but a cover image was found.
          {/if}
        </p>
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Author</th>
              <th>ISBN</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each group.books as book (book.id)}
              <tr>
                <td>{book.title}</td>
                <td class="author-cell">{authorNames(book)}</td>
                <td class:empty={!book.isbn} class="isbn-cell">{book.isbn || 'none'}</td>
                <td class="actions-cell">
                  <button type="button" class="row-action" onclick={() => (editBook = book)}>Fix</button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/each}
  {/if}
</div>

{#if editBook !== null && $user}
  <NewBookModal
    open={true}
    userId={$user.uid}
    book={editBook}
    onclose={() => (editBook = null)} />
{/if}
