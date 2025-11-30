<script>
  import { user } from '$lib/firebase/auth.js';
  import BookList from '$lib/components/BookList.svelte';
  import { Database } from '$lib/firebase/db.js';
  import { formatTime } from '$lib/utils/format.js';

  let sortBy = $state('updatedAt'); // 'updatedAt', 'pageCount', 'timeRead', 'title'
  let filterYear = $state('all'); // 'all', '2020', '2021', etc.
  let searchTerm = $state(''); // Search filter

  let allBooks = $state([]);

  $effect(() => {
    if ($user) {
      const booksStore = Database.getBooks($user.uid, true);
      return booksStore.subscribe((data) => {
        allBooks = data;
      });
    }
  });

  // Get available years from books
  let availableYears = $derived.by(() => {
    const years = new Set();
    allBooks.forEach(book => {
      if (book.updatedAt?.toDate) {
        years.add(book.updatedAt.toDate().getFullYear());
      }
    });
    return Array.from(years).sort((a, b) => b - a); // Descending
  });

  // Filter books by search term (title or author)
  let searchedBooks = $derived.by(() => {
    if (!searchTerm.trim()) return allBooks;
    const term = searchTerm.toLowerCase();
    return allBooks.filter(book => {
      const title = (book.title || '').toLowerCase();
      const author = (book.author || '').toLowerCase();
      return title.includes(term) || author.includes(term);
    });
  });

  // Filter books by year
  let filteredBooks = $derived.by(() => {
    if (filterYear === 'all') return searchedBooks;
    return searchedBooks.filter(book => {
      if (!book.updatedAt?.toDate) return false;
      return book.updatedAt.toDate().getFullYear() === parseInt(filterYear);
    });
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
      case 'updatedAt':
      default:
        return books.sort((a, b) => {
          const aTime = a.updatedAt?.toDate?.()?.getTime() || 0;
          const bTime = b.updatedAt?.toDate?.()?.getTime() || 0;
          return bTime - aTime;
        });
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
  .controls {
    max-width: 1200px;
    margin: 0 auto 2rem;
    padding: 1.5rem 2rem;
    background: white;
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  }

  .stats {
    display: flex;
    gap: 2rem;
    margin-bottom: 1.5rem;
    flex-wrap: wrap;
  }

  .stat {
    display: flex;
    flex-direction: column;
  }

  .stat-label {
    font-size: 0.85rem;
    color: #666;
    text-transform: uppercase;
    font-weight: 600;
    margin-bottom: 0.25rem;
  }

  .stat-value {
    font-size: 1.5rem;
    font-weight: 700;
    color: #333;
  }

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
    color: #666;
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
    min-width: 200px;
  }

  select:hover, input[type="text"]:hover {
    border-color: #999;
  }

  select:focus, input[type="text"]:focus {
    outline: none;
    border-color: #007bff;
    box-shadow: 0 0 0 2px rgba(0, 123, 255, 0.1);
  }
</style>

{#if $user}
  <div class="controls">
    <div class="stats">
      <div class="stat">
        <span class="stat-label">Books Finished</span>
        <span class="stat-value">{stats.count}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Total Pages</span>
        <span class="stat-value">{stats.totalPages.toLocaleString()}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Total Time</span>
        <span class="stat-value">{formatTime(stats.totalTime)}</span>
      </div>
    </div>

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
          <option value="updatedAt">Recently Finished</option>
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
  </div>

  <BookList finished={true} userId={$user.uid} books={sortedBooks} />
{/if}
