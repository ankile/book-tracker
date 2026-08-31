<script lang="ts">
  import { user } from '$lib/firebase/auth.ts';
  import { Database } from '$lib/firebase/db.ts';
  import {
    bookAuthorReferenceCounts,
    selectableAuthors,
  } from '$lib/utils/authors.ts';
  import type { Author } from '$lib/interfaces/author.ts';
  import type { Book } from '$lib/interfaces/book.ts';

  let authorList = $state<Author[] | undefined>(undefined);
  $effect(() => {
    if ($user) {
      const authorsStore = Database.getAuthors();
      const unsubscribe = authorsStore.subscribe((data) => (authorList = data));
      return unsubscribe;
    }
  });

  let allBooks = $state<Book[] | undefined>(undefined);
  $effect(() => {
    if ($user) {
      const booksStore = Database.getAllBooks($user.uid);
      const unsubscribe = booksStore.subscribe((data) => (allBooks = data));
      return unsubscribe;
    }
  });

  const sortKey = (author: Author) => `${author.sortName} ${author.name}`.toLowerCase();
  const authorMap = $derived(new Map((authorList ?? []).map((author) => [author.id, author])));

  // The catalog holds every author anyone has added; this page is about the
  // reader's own shelf, so only the authors their books reference are listed.
  const bookCounts = $derived(bookAuthorReferenceCounts(allBooks ?? [], authorMap));
  const authors = $derived(
    selectableAuthors(authorList ?? [])
      .filter((author) => bookCounts.has(author.id))
      .toSorted((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0)),
  );
</script>

<style>
  .authors-container {
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

  .authors-card {
    background: white;
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    padding: 1rem 1.5rem;
    overflow-x: auto;
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

  .kind,
  .sort-name {
    color: #666;
    font-size: 0.9rem;
  }

  .count {
    text-align: right;
  }

</style>

<div class="authors-container">
  <h1>Authors</h1>
  <p class="hint">
    The authors your books reference. The records themselves are shared across
    Book Tracker, and catalog administrators manage names, alternate spellings,
    and merges.
  </p>

  {#if authorList === undefined || allBooks === undefined}
    <p>Loading…</p>
  {:else if authors.length === 0}
    <p>No authors yet — they appear as you add books.</p>
  {:else}
    <div class="authors-card">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Kind</th>
            <th>Sort name</th>
            <th class="count">Books</th>
          </tr>
        </thead>
        <tbody>
          {#each authors as author (author.id)}
            {@const count = bookCounts.get(author.id) ?? 0}
            <tr>
              <td>{author.name}</td>
              <td class="kind">{author.kind}</td>
              <td class="sort-name">{author.sortName}</td>
              <td class="count">{count}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
