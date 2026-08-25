<script lang="ts">
  import { page } from '$app/state';
  import { user } from '$lib/firebase/auth.ts';
  import { Database } from '$lib/firebase/db.ts';
  import { addError } from '$lib/stores/errors.ts';
  import { formatTime } from '$lib/utils/format.ts';
  import { joinPersonName } from '$lib/utils/authors.ts';
  import ReadingHeatmap from '$lib/components/ReadingHeatmap.svelte';
  import SuperlativesRow from '$lib/components/SuperlativesRow.svelte';
  import ProfileLinks from '$lib/components/ProfileLinks.svelte';
  import StatCard from '$lib/components/StatCard.svelte';
  import StatGrid from '$lib/components/StatGrid.svelte';
  import type { Profile } from '$lib/interfaces/profile.ts';

  const username = $derived(page.params.username ?? '');

  // undefined → loading, null → no such profile, or one this viewer may
  // not see (the rules make those indistinguishable on purpose). The fetch
  // waits for the auth session to finish restoring: whether a private
  // profile is readable depends on who is asking, and firing before the
  // token is back would deny the owner their own page.
  let profile = $state<Profile | null | undefined>(undefined);
  const profileTitle = $derived(
    profile
      ? `${joinPersonName(profile) || profile.username}'s reading profile | Book Tracker`
      : `${username} | Book Tracker`,
  );
  let profileLoadFailed = $state(false);
  $effect(() => {
    if ($user === undefined) return;
    const requestedUsername = username;
    let current = true;
    profile = undefined;
    profileLoadFailed = false;
    Database.getProfile(requestedUsername).then(
      (data) => {
        if (current) profile = data;
      },
      (error: unknown) => {
        if (!current) return;
        console.error(error);
        profileLoadFailed = true;
        addError(`Couldn't load @${requestedUsername}.`);
      },
    );
    return () => (current = false);
  });

  // The Hosting function fills this slot with indexable HTML before the
  // client starts. Keep it on screen through auth restoration and the
  // Firestore read, then reveal the interactive Svelte page. If the client
  // load fails, the server snapshot remains useful instead of becoming an
  // empty error state.
  $effect(() => {
    if (profile === undefined || profileLoadFailed) return;
    document.getElementById('profile-snapshot-slot')?.replaceChildren();
  });
</script>

<svelte:head>
  <title>{profileTitle}</title>
</svelte:head>

<style lang="scss">
  .profile-container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 2rem;
    text-align: left;
  }

  .profile-header {
    max-width: 820px;
    margin: 0 auto 2rem;
    padding: 2.25rem 2rem 2rem;
    text-align: center;
    background: white;
    border: 1px solid #e9e9e9;
    border-radius: 12px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.08);

    h1 {
      margin: 0;
      color: #333;
      font-size: clamp(1.8rem, 4vw, 2.35rem);
      font-weight: 700;
      letter-spacing: -0.025em;
      line-height: 1.15;
    }

    .subtitle {
      display: flex;
      justify-content: center;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.45rem;
      margin: 0.55rem 0 0;
      color: #6f6f6f;
      font-size: 0.95rem;
    }

    .private-note {
      font-size: 0.9rem;
      color: #997404;
      margin: 0.5rem 0 0 0;
    }

    .profile-links {
      margin-top: 1.4rem;
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
      padding: 1.75rem 1rem 1.5rem;

      h1 {
        font-size: 1.75rem;
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

{#if profileLoadFailed}
  <p class="status-message">This profile could not be loaded. Try again after reconnecting.</p>
{:else if profile === undefined}
  <p class="status-message">Loading…</p>
{:else if profile === null}
  <p class="status-message">No profile found for "{username}".</p>
{:else}
  <div class="profile-container">
    <div class="profile-header">
      <h1>{joinPersonName(profile) || profile.username}</h1>
      <p class="subtitle">@{profile.username}</p>
      {#if profile.links?.length > 0}
        <div class="profile-links">
          <ProfileLinks links={profile.links} />
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
