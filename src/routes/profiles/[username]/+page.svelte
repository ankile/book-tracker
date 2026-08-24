<script>
  import { page } from '$app/state';
  import { user } from '$lib/firebase/auth.js';
  import { Database } from '$lib/firebase/db.js';
  import { formatTime } from '$lib/utils/format.js';
  import { joinPersonName } from '$lib/utils/authors.js';
  import ReadingHeatmap from '$lib/components/ReadingHeatmap.svelte';
  import SuperlativesRow from '$lib/components/SuperlativesRow.svelte';
  import BrandIcon from '$lib/components/BrandIcon.svelte';
  import StatCard from '$lib/components/StatCard.svelte';
  import StatGrid from '$lib/components/StatGrid.svelte';
  import { linkHref, linkDisplay, linkIcon, linkBrandIcon, linkTypeName } from '$lib/utils/links.js';
  import Icon from 'svelte-awesome';

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

    .handles {
      display: flex;
      justify-content: center;
      flex-wrap: wrap;
      gap: 0.75rem;
      margin-top: 1.25rem;

      .handle {
        display: inline-flex;
        align-items: center;
        gap: 0.65rem;
        min-width: 0;
        padding: 0.65rem 0.85rem;
        color: #333;
        text-align: left;
        text-decoration: none;
        background: #f7f7f7;
        border: 1px solid #e5e5e5;
        border-radius: 8px;
        transition: background 0.15s, border-color 0.15s, transform 0.15s;

        &:hover {
          color: #111;
          background: #fff;
          border-color: #bbb;
          transform: translateY(-1px);
        }

        .handle-copy {
          display: flex;
          flex-direction: column;
          min-width: 0;
          line-height: 1.15;
        }

        .handle-service {
          font-size: 0.72rem;
          font-weight: 700;
          color: #666;
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }

        .handle-value {
          max-width: 230px;
          margin-top: 0.15rem;
          overflow: hidden;
          font-size: 0.9rem;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
      }
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
      <h1>{joinPersonName(profile) || profile.username}</h1>
      <p class="subtitle">@{profile.username} · reading stats</p>
      {#if profile.links?.length > 0}
        <div class="handles">
          {#each profile.links as link}
            <a class="handle" href={linkHref(link)} target="_blank" rel="noopener noreferrer nofollow">
              {#if linkBrandIcon(link)}
                <BrandIcon icon={linkBrandIcon(link)} />
              {:else}
                <Icon data={linkIcon(link)} />
              {/if}
              <span class="handle-copy">
                <span class="handle-service">{linkTypeName(link)}</span>
                <span class="handle-value">{linkDisplay(link)}</span>
              </span>
            </a>
          {/each}
        </div>
      {/if}
      {#if !profile.public}
        <p class="private-note">Private. Only you can see this page.</p>
      {/if}
    </div>

    <StatGrid>
      <StatCard label="Books Read" value={profile.stats.finishedBooks} subtext="Completed books" />
      <StatCard label="Currently Reading" value={profile.stats.readingBooks} subtext="In progress" />
      <StatCard label="Authors" value={profile.stats.authors ?? '…'} subtext="Across their library" />
      <StatCard label="Total Time Read" value={`${profile.stats.totalTimeReadHours} hrs`} subtext={`${profile.stats.totalPagesRead.toLocaleString()} pages read`} />
      <StatCard label="Books Per Year" value={profile.stats.booksPerYear} subtext="Average rate" />
      <StatCard label="Avg. Time Per Book" value={formatTime(profile.stats.avgTimePerBook)} subtext="For finished books" />
      <StatCard label="Total Books" value={profile.stats.totalBooks} subtext="In their library" />
    </StatGrid>

    {#if profile.days?.length > 0}
      <ReadingHeatmap days={profile.days} />
    {/if}

    {#if profile.records}
      <SuperlativesRow published={profile.records} />
    {/if}

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
