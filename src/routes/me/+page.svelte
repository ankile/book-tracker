<script>
  import { user, signOut } from '$lib/firebase/auth.js';
  import { goto } from '$app/navigation';
  import NewBookModal from '$lib/components/NewBookModal.svelte';
  import { Database } from '$lib/firebase/db.js';
  import { formatTime } from '$lib/utils/format.js';

  let newBookModal = $state(false);

  async function handleSignOut() {
    await signOut();
    goto('/', { replaceState: true });
  }

  const toggleModal = () => (newBookModal = !newBookModal);
  const closeModal = () => (newBookModal = false);

  // Get all books for statistics
  let allBooks = $state([]);
  $effect(() => {
    if ($user) {
      const booksStore = Database.getAllBooks($user.uid);
      return booksStore.subscribe((books) => {
        allBooks = books;
      });
    }
  });

  // Calculate statistics
  const stats = $derived(() => {
    const finishedBooks = allBooks.filter(b => b.finished);
    const readingBooks = allBooks.filter(b => !b.finished);
    const totalTimeRead = allBooks.reduce((sum, book) => sum + (book.timeRead || 0), 0);
    const totalPagesRead = allBooks.reduce((sum, book) => sum + (book.pagesRead || 0), 0);

    // Calculate books per year (from first book created date)
    let booksPerYear = 0;
    if (finishedBooks.length > 0) {
      const dates = finishedBooks
        .map(b => b.createdAt?.toDate?.() || new Date())
        .sort((a, b) => a - b);
      const firstBook = dates[0];
      const yearsSinceFirst = (new Date() - firstBook) / (1000 * 60 * 60 * 24 * 365);
      booksPerYear = yearsSinceFirst > 0 ? (finishedBooks.length / yearsSinceFirst).toFixed(1) : 0;
    }

    // Average time per finished book
    const avgTimePerBook = finishedBooks.length > 0
      ? Math.round(finishedBooks.reduce((sum, b) => sum + (b.timeRead || 0), 0) / finishedBooks.length)
      : 0;

    // Round total time read to nearest hour
    const totalTimeReadHours = Math.round(totalTimeRead / 60);

    return {
      totalBooks: allBooks.length,
      finishedBooks: finishedBooks.length,
      readingBooks: readingBooks.length,
      totalTimeRead,
      totalTimeReadHours,
      totalPagesRead,
      booksPerYear,
      avgTimePerBook,
    };
  });

  // Calculate books per year breakdown for table
  const booksByYear = $derived(() => {
    const finishedBooks = allBooks.filter(b => b.finished);
    const yearData = {};

    finishedBooks.forEach(book => {
      const date = book.createdAt?.toDate?.();
      if (date) {
        const year = date.getFullYear();
        if (!yearData[year]) {
          yearData[year] = {
            count: 0,
            totalTimeRead: 0,
            totalPages: 0,
            longestBook: null,
          };
        }

        yearData[year].count += 1;
        yearData[year].totalTimeRead += book.timeRead || 0;
        yearData[year].totalPages += book.pagesRead || 0;

        // Track longest book
        if (!yearData[year].longestBook || book.pageCount > yearData[year].longestBook.pageCount) {
          yearData[year].longestBook = book;
        }
      }
    });

    return Object.entries(yearData)
      .sort(([a], [b]) => b - a)
      .map(([year, data]) => ({
        year,
        count: data.count,
        totalTimeRead: data.totalTimeRead,
        totalPages: data.totalPages,
        longestBook: data.longestBook,
      }));
  });

  // Extract username from email
  const username = $derived($user ? $user.email.split('@')[0] : '');
</script>

<style lang="scss">
  .profile-container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 2rem;
  }

  .profile-header {
    text-align: center;
    padding: 2rem;
    background: white;
    border-radius: 5px;
    margin-bottom: 2rem;
    box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.2), 0 6px 20px 0 rgba(0, 0, 0, 0.19);

    h1 {
      font-size: 2rem;
      margin: 0 0 0.5rem 0;
      color: #333;
      text-transform: capitalize;
    }

    .email {
      font-size: 1rem;
      color: #666;
    }
  }

  .actions {
    display: flex;
    gap: 1rem;
    justify-content: center;
    flex-wrap: wrap;
    margin-bottom: 2rem;

    button {
      min-width: 200px;
      border: none;
      background: white;
      padding: 1rem 2rem;
      font-size: 1rem;
      font-weight: 600;
      color: #333;
      box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.2), 0 6px 20px 0 rgba(0, 0, 0, 0.19);
      border-radius: 5px;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;

      &:hover {
        transform: translateY(-2px);
        box-shadow: 0 6px 12px 0 rgba(0, 0, 0, 0.25), 0 8px 24px 0 rgba(0, 0, 0, 0.22);
      }
    }
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 1.5rem;
    margin-bottom: 2rem;
  }

  .stat-card {
    background: white;
    padding: 2rem;
    border-radius: 5px;
    box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.2), 0 6px 20px 0 rgba(0, 0, 0, 0.19);
    transition: transform 0.2s, box-shadow 0.2s;
    text-decoration: none;
    color: inherit;
    display: block;

    &:hover {
      transform: translateY(-4px);
      box-shadow: 0 6px 12px 0 rgba(0, 0, 0, 0.25), 0 8px 24px 0 rgba(0, 0, 0, 0.22);
    }

    &.clickable {
      cursor: pointer;
    }

    .stat-label {
      font-size: 0.9rem;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 0.5rem;
      font-weight: 600;
    }

    .stat-value {
      font-size: 2.5rem;
      font-weight: 700;
      color: #333;
      margin: 0;
    }

    .stat-subtext {
      font-size: 0.85rem;
      color: #999;
      margin-top: 0.25rem;
    }
  }

  .books-by-year {
    background: white;
    padding: 2rem;
    border-radius: 5px;
    box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.2), 0 6px 20px 0 rgba(0, 0, 0, 0.19);

    h2 {
      font-size: 1.5rem;
      color: #333;
      margin: 0 0 1.5rem 0;
    }

    table {
      width: 100%;
      border-collapse: collapse;

      th, td {
        padding: 0.75rem;
        text-align: left;
        border-bottom: 1px solid #e0e0e0;
      }

      th {
        font-size: 0.9rem;
        color: #666;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        font-weight: 600;
      }

      td {
        font-size: 1.1rem;
        color: #333;
      }

      tr:last-child td {
        border-bottom: none;
      }

      tr:hover {
        background-color: #f9f9f9;
      }
    }

    .book-info {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .book-title {
      font-style: italic;
      color: #555;
    }

    .book-pages {
      font-size: 0.9rem;
      color: #999;
    }
  }

  @media (max-width: 768px) {
    .profile-container {
      padding: 1rem;
    }

    .profile-header {
      padding: 1.5rem 1rem;

      h1 {
        font-size: 1.5rem;
      }

      .email {
        font-size: 0.9rem;
      }
    }

    .stats-grid {
      grid-template-columns: 1fr;
    }

    .stat-card .stat-value {
      font-size: 2rem;
    }

    .actions button {
      width: 100%;
    }
  }
</style>

{#if $user}
  <NewBookModal open={newBookModal} onclose={closeModal} userId={$user.uid} />

  <div class="profile-container">
    <div class="profile-header">
      <h1>Welcome back, {username}!</h1>
      <p class="email">{$user.email}</p>
    </div>

    <div class="actions">
      <button onclick={toggleModal}>Add New Book</button>
      <button onclick={handleSignOut}>Sign Out</button>
    </div>

    <div class="stats-grid">
      <a href="/finished" class="stat-card clickable">
        <div class="stat-label">Books Read</div>
        <div class="stat-value">{stats().finishedBooks}</div>
        <div class="stat-subtext">Completed books</div>
      </a>

      <a href="/" class="stat-card clickable">
        <div class="stat-label">Currently Reading</div>
        <div class="stat-value">{stats().readingBooks}</div>
        <div class="stat-subtext">In progress</div>
      </a>

      <div class="stat-card">
        <div class="stat-label">Total Time Read</div>
        <div class="stat-value">{stats().totalTimeReadHours} hrs</div>
        <div class="stat-subtext">{stats().totalPagesRead.toLocaleString()} pages read</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Books Per Year</div>
        <div class="stat-value">{stats().booksPerYear}</div>
        <div class="stat-subtext">Average rate</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Avg. Time Per Book</div>
        <div class="stat-value">{formatTime(stats().avgTimePerBook)}</div>
        <div class="stat-subtext">For finished books</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Total Books</div>
        <div class="stat-value">{stats().totalBooks}</div>
        <div class="stat-subtext">In your library</div>
      </div>
    </div>

    {#if booksByYear().length > 0}
      <div class="books-by-year">
        <h2>Books by Year</h2>
        <table>
          <thead>
            <tr>
              <th>Year</th>
              <th>Books</th>
              <th>Hours</th>
              <th>Pages</th>
              <th>Longest Book</th>
            </tr>
          </thead>
          <tbody>
            {#each booksByYear() as { year, count, totalTimeRead, totalPages, longestBook }}
              <tr>
                <td>{year}</td>
                <td>{count}</td>
                <td>{Math.round(totalTimeRead / 60)}</td>
                <td>{totalPages.toLocaleString()}</td>
                <td>
                  {#if longestBook}
                    <span class="book-info">
                      <span class="book-title">{longestBook.title}</span>
                      <span class="book-pages">({longestBook.pageCount} pages)</span>
                    </span>
                  {:else}
                    -
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
{/if}
