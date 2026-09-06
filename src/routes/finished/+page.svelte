<script lang="ts">
  import { user } from '$lib/firebase/auth.ts';
  import BookList from '$lib/components/BookList.svelte';
  import BookSummary from '$lib/components/BookSummary.svelte';
  import { Database } from '$lib/firebase/db.ts';
  import { formatReadingTime } from '$lib/utils/format.ts';
  import { finishedDateOf } from '$lib/utils/finished.ts';
  import { repairableBookAuthors, joinAuthors } from '$lib/utils/authors.ts';
  import type { Author } from '$lib/interfaces/author.ts';
  import type { Book } from '$lib/interfaces/book.ts';

  let sortBy = $state('finishedAt'); // 'finishedAt', 'pageCount', 'timeRead', 'title'
  let filterYear = $state('all'); // 'all', '2020', '2021', etc.
  let searchTerm = $state(''); // Search filter

  let allBooks = $state<Book[]>([]);

  $effect(() => {
    if ($user) {
      const booksStore = Database.getBooks($user.uid, true);
      const unsubscribe = booksStore.subscribe((data) => {
        allBooks = data;
      });
      return unsubscribe;
    }
  });

  // The years books were finished in (finishedAt, never updatedAt: that
  // moves on every metadata edit).
  let availableYears = $derived.by(() => {
    const years = new Set(allBooks.map((book) => finishedDateOf(book).getFullYear()));
    return Array.from(years).sort((a, b) => b - a); // Descending
  });

  // Author docs for resolving each book's authorIds into searchable names.
  let authorList = $state<Author[] | undefined>(undefined);
  $effect(() => {
    if ($user) {
      const authorsStore = Database.getAuthors();
      const unsubscribe = authorsStore.subscribe((data) => (authorList = data));
      return unsubscribe;
    }
  });
  let authorMap = $derived(authorList === undefined ? null : new Map(authorList.map((a) => [a.id, a])));

  // Filter books by search term (title or author)
  let searchedBooks = $derived.by(() => {
    if (!searchTerm.trim()) return allBooks;
    const term = searchTerm.toLowerCase();
    return allBooks.filter(book => {
      const title = (book.title || '').toLowerCase();
      const authors = repairableBookAuthors(book, authorMap);
      const authorText = authors ? joinAuthors(authors.map((a) => a.name)).toLowerCase() : '';
      return title.includes(term) || authorText.includes(term);
    });
  });

  // Filter books by year
  let filteredBooks = $derived.by(() => {
    if (filterYear === 'all') return searchedBooks;
    return searchedBooks.filter((book) => finishedDateOf(book).getFullYear() === parseInt(filterYear));
  });

  // Sort books
  let sortedBooks = $derived.by(() => {
    const books = [...filteredBooks];
    switch (sortBy) {
      case 'pageCount':
        return books.sort((a, b) => (b.pageCount || 0) - (a.pageCount || 0));
      case 'timeRead':
        return books.sort((a, b) => (b.timeRead || 0) - (a.timeRead || 0));
      case 'title':
        return books.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
      case 'finishedAt':
      default:
        return books.sort((a, b) => finishedDateOf(b).getTime() - finishedDateOf(a).getTime());
    }
  });

  // Calculate summary stats
  let stats = $derived.by(() => {
    const count = filteredBooks.length;
    const totalPages = filteredBooks.reduce((sum, book) => sum + (book.pageCount || 0), 0);
    const totalTime = filteredBooks.reduce((sum, book) => sum + (book.timeRead || 0), 0);
    return { count, totalPages, totalTime };
  });
</script>

<style>
  .filters {
    display: flex;
    gap: 1.5rem;
    flex-wrap: wrap;
    align-items: center;
  }

  .filter-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .filter-label {
    font-size: 0.85rem;
    color: #53636a;
    font-weight: 600;
  }

  select, input[type="text"] {
    padding: 0.5rem 0.75rem;
    border: 1px solid #ddd;
    border-radius: 4px;
    font-size: 0.95rem;
    background: white;
  }

  select {
    cursor: pointer;
  }

  input[type="text"] {
    width: 100%;
    min-width: 0;
  }

  select:hover, input[type="text"]:hover {
    border-color: #999;
  }

  select:focus, input[type="text"]:focus {
    outline: none;
    border-color: #1b7179;
    box-shadow: 0 0 0 2px rgba(27, 113, 121, 0.15);
  }
  @media (max-width: 770px) {
    .filters { align-items: stretch; gap: 1rem; }
    .filter-group { flex: 1 1 140px; min-width: 0; }
    .filter-group:first-child { flex-basis: 100%; }
    .filter-group:nth-child(2) { flex: 2 1 170px; }
    .filter-group:nth-child(3) { flex: 1 1 110px; }
    select { width: 100%; }
  }
</style>

{#if $user}
  <BookList finished={true} userId={$user.uid} books={sortedBooks}>
    {#snippet header()}
      <BookSummary
        label="Finished books summary"
        testId="finished-summary"
        stats={[
          { label: 'Books finished', value: stats.count + (stats.count === 1 ? ' book' : ' books') },
          { label: 'Total pages', value: stats.totalPages.toLocaleString() },
          { label: 'Time read', value: formatReadingTime(stats.totalTime) },
        ]}
      >
        <div class="filters">
          <div class="filter-group">
            <label class="filter-label" for="search-input">Search</label>
            <input
              id="search-input"
              type="text"
              placeholder="Title or author..."
              bind:value={searchTerm}
            />
          </div>

          <div class="filter-group">
            <label class="filter-label" for="sort-select">Sort by</label>
            <select id="sort-select" bind:value={sortBy}>
              <option value="finishedAt">Recently Finished</option>
              <option value="title">Title (A-Z)</option>
              <option value="pageCount">Length (Pages)</option>
              <option value="timeRead">Time Spent</option>
            </select>
          </div>

          <div class="filter-group">
            <label class="filter-label" for="year-select">Year</label>
            <select id="year-select" bind:value={filterYear}>
              <option value="all">All Years</option>
              {#each availableYears as year}
                <option value={year.toString()}>{year}</option>
              {/each}
            </select>
          </div>
        </div>
      </BookSummary>
    {/snippet}
  </BookList>
{/if}
