<script>
  // Top authors by total reading hours across their books. A multi-author
  // book credits each listed author fully (see authorLeaderboard).
  import { authorLeaderboard } from '$lib/utils/sessions.js';

  let { books = [], authors = [] } = $props();

  const rows = $derived(authorLeaderboard(books, authors).slice(0, 8));
</script>

<style>
  .section {
    background: white;
    padding: 2rem;
    border-radius: 5px;
    box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.2), 0 6px 20px 0 rgba(0, 0, 0, 0.19);
    margin-bottom: 2rem;
  }

  h2 {
    font-size: 1.5rem;
    color: #333;
    margin: 0 0 1.5rem 0;
  }

  .table-scroll {
    overflow-x: auto;
  }

  table {
    width: 100%;
    min-width: 420px;
    border-collapse: collapse;
  }

  th,
  td {
    padding: 0.6rem 0.75rem;
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
    font-size: 1rem;
    color: #333;
  }

  td.numeric,
  th.numeric {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  tr:last-child td {
    border-bottom: none;
  }

  tr:hover {
    background-color: #f9f9f9;
  }

  @media (max-width: 768px) {
    .section {
      padding: 1.25rem;
    }

    th,
    td {
      padding: 0.5rem;
    }
  }
</style>

{#if rows.length > 0}
  <div class="section">
    <h2>Top Authors</h2>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Author</th>
            <th class="numeric">Books</th>
            <th class="numeric">Finished</th>
            <th class="numeric">Pages</th>
            <th class="numeric">Hours</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row}
            <tr>
              <td>{row.name}</td>
              <td class="numeric">{row.books}</td>
              <td class="numeric">{row.finishedBooks}</td>
              <td class="numeric">{row.pages.toLocaleString()}</td>
              <td class="numeric">{Math.round(row.minutes / 60)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
{/if}
