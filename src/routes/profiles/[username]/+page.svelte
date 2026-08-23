<script>
  import { page } from '$app/state';
  import { user } from '$lib/firebase/auth.js';
  import { Database } from '$lib/firebase/db.js';
  import { formatTime } from '$lib/utils/format.js';

  const username = $derived(page.params.username);

  // undefined → loading, null → no such profile, or one this viewer may
  // not see (the rules make those indistinguishable on purpose). The fetch
  // waits for the auth session to finish restoring: whether a private
  // profile is readable depends on who is asking, and firing before the
  // token is back would deny the owner their own page.
  let profile = $state(undefined);
  $effect(() => {
    if ($user === undefined) return;
    profile = undefined;
    Database.getProfile(username).then((data) => (profile = data));
  });
</script>

<svelte:head>
  <title>{username} — Book Tracker</title>
</svelte:head>

<style lang="scss">
  .profile-container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 2rem;
    text-align: left;
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
    }

    .subtitle {
      font-size: 1rem;
      color: #666;
      margin: 0;
    }

    .private-note {
      font-size: 0.9rem;
      color: #997404;
      margin: 0.5rem 0 0 0;
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

    .table-scroll {
      overflow-x: auto;
    }

    table {
      width: 100%;
      min-width: 360px;
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
  }

  .status-message {
    text-align: center;
    padding: 4rem 2rem;
    color: #666;
    font-size: 1.1rem;
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
    }

    .stats-grid {
      grid-template-columns: 1fr;
    }

    .stat-card .stat-value {
      font-size: 2rem;
    }

    .books-by-year {
      padding: 1.25rem;

      table {
        th, td {
          padding: 0.5rem;
        }

        td {
          font-size: 1rem;
        }
      }
    }
  }
</style>

{#if profile === undefined}
  <p class="status-message">Loading…</p>
{:else if profile === null}
  <p class="status-message">No profile found for "{username}".</p>
{:else}
  <div class="profile-container">
    <div class="profile-header">
      <h1>{profile.displayName || profile.username}</h1>
      <p class="subtitle">@{profile.username} — reading stats</p>
      {#if !profile.public}
        <p class="private-note">Private — only you can see this page.</p>
      {/if}
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Books Read</div>
        <div class="stat-value">{profile.stats.finishedBooks}</div>
        <div class="stat-subtext">Completed books</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Currently Reading</div>
        <div class="stat-value">{profile.stats.readingBooks}</div>
        <div class="stat-subtext">In progress</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Total Time Read</div>
        <div class="stat-value">{profile.stats.totalTimeReadHours} hrs</div>
        <div class="stat-subtext">{profile.stats.totalPagesRead.toLocaleString()} pages read</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Books Per Year</div>
        <div class="stat-value">{profile.stats.booksPerYear}</div>
        <div class="stat-subtext">Average rate</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Avg. Time Per Book</div>
        <div class="stat-value">{formatTime(profile.stats.avgTimePerBook)}</div>
        <div class="stat-subtext">For finished books</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Total Books</div>
        <div class="stat-value">{profile.stats.totalBooks}</div>
        <div class="stat-subtext">In their library</div>
      </div>
    </div>

    {#if profile.years.length > 0}
      <div class="books-by-year">
        <h2>Books by Year</h2>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Year</th>
                <th>Books</th>
                <th>Hours</th>
                <th>Pages</th>
              </tr>
            </thead>
            <tbody>
              {#each profile.years as { year, count, hours, pages }}
                <tr>
                  <td>{year}</td>
                  <td>{count}</td>
                  <td>{hours}</td>
                  <td>{pages.toLocaleString()}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/if}
  </div>
{/if}
