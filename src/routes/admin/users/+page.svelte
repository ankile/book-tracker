<script lang="ts">
  import { onMount } from 'svelte';
  import { feedNotes as feedNotesFor, readFailed as readFailedFor } from '$lib/utils/adminFeed.ts';
  import { groupIssues } from '$lib/utils/adminFeed.ts';
  import { overviewCache } from '$lib/admin.ts';
  import type { AdminOverview } from '$lib/firebase/functions.ts';
  import { addError } from '$lib/stores/errors.ts';

  // Accounts and issues are server-only on purpose: the Auth user list and
  // the issue log are Admin-SDK data, so this page runs its callable when
  // it is opened and never as a prefetch. The last answer is kept for the
  // session and shown at once; a fresh one loads behind it unless the
  // cached one is under a minute old.
  const cached = overviewCache.read();
  let overview = $state<AdminOverview | null>(cached.value);
  let loadedAt = $state<number | null>(cached.loadedAt);
  let refreshing = $state(false);
  let failed = $state(false);

  async function load(force: boolean): Promise<void> {
    refreshing = true;
    try {
      overview = await overviewCache.fetch(force);
      loadedAt = overviewCache.read().loadedAt;
      failed = false;
    } catch (error) {
      failed = overview === null;
      addError(`Couldn't load the admin overview (${error instanceof Error ? error.message : String(error)}).`);
    } finally {
      refreshing = false;
    }
  }

  // Runs once: the decision reads loadedAt, which load writes, so an
  // effect here re-ran itself after every load.
  const FRESH_MS = 60_000;
  onMount(() => {
    const age = loadedAt === null ? Infinity : Date.now() - loadedAt;
    void load(age > FRESH_MS);
  });

  // The caps block is read through one guarded derived value so a server
  // that predates it (a rollback of admin-overview while Hosting stays
  // current) degrades to no note instead of a render error. What the
  // notes say, and when an empty feed is a failure rather than a calm,
  // live in $lib/utils/adminFeed.ts where they are tested.
  const caps = $derived(overview?.issueCaps ?? null);
  const feedNotes = $derived(feedNotesFor(caps));
  const readFailed = $derived(readFailedFor(caps));
  const issueGroups = $derived(groupIssues(overview?.issues ?? []));

  // All times render in UTC: the sources mix ISO offsets and local-time
  // formatting would shift signups/activity across day boundaries.
  function utc(ms: number | null) {
    if (ms == null) return '—';
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  }

  function utcDay(ms: number | null) {
    if (ms == null) return '—';
    return new Date(ms).toISOString().slice(0, 10);
  }

  // The feed keeps seconds: repeated failures a few seconds apart are
  // otherwise indistinguishable rows.
  function utcSeconds(ms: number) {
    return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  }
</script>

<style lang="scss">
  .admin-container {
    max-width: 1280px;
    margin: 0 auto;
    padding: 2rem;
    text-align: left;
    color: #273331;
  }

  h1 {
    margin: 0.5rem 0;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin: -0.75rem 0 1.5rem;
  }

  .toolbar small { color: #697572; }

  .toolbar button {
    font: inherit;
    padding: 0.3rem 0.7rem;
    border: 1px solid #49736d;
    border-radius: 4px;
    background: white;
    color: #244f49;
    cursor: pointer;
  }

  .toolbar button:disabled { opacity: 0.55; cursor: default; }

  nav {
    font-size: 0.95rem;
    color: #64706d;
  }

  nav a { color: #24635a; }
  nav strong { color: #244f49; }

  .card {
    background: white;
    padding: 1.25rem;
    border-radius: 7px;
    box-shadow: 0 2px 10px #0002;
    margin: 1.25rem 0;

    h2 {
      font-size: 1.5rem;
      margin: 0 0 0.25rem 0;
    }

    .card-subtext {
      font-size: 0.9rem;
      color: #64706d;
      margin-bottom: 1.25rem;
    }
  }

  .table-scroll {
    overflow-x: auto;
  }

  /* Ten columns must fit the 1280px container without a hidden horizontal
     scroll: compact cells, and the email column truncates with the full
     address on hover. Narrow screens still scroll the wrapper. */
  table {
    width: 100%;
    border-collapse: collapse;

    th,
    td {
      padding: 0.5rem 0.55rem;
      text-align: left;
      border-bottom: 1px solid #dfe5e3;
      white-space: nowrap;
    }

    th {
      font-size: 0.76rem;
      color: #697572;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-weight: 600;
    }

    td {
      font-size: 0.9rem;
      color: #273331;
    }

    td.email {
      max-width: 230px;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    tr:last-child td {
      border-bottom: none;
    }

    tr:hover {
      background-color: #f9f9f9;
    }
  }

  td.message {
    white-space: normal;
    min-width: 240px;
    color: #555;
  }

  .badge-anomaly,
  .badge-unverified,
  .badge-malformed {
    display: inline-block;
    margin-left: 0.5rem;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    background: #fff3cd;
    color: #664d03;
    font-size: 0.75rem;
    font-weight: 600;
  }

  .badge-unverified {
    background: #e9ecef;
    color: #495057;
    cursor: help;
  }

  .badge-malformed {
    background: #f8d7da;
    color: #842029;
  }

  .truncated {
    margin: -0.75rem 0 1.25rem 0;
    padding: 0.5rem 0.75rem;
    border-radius: 4px;
    background: #fff3cd;
    color: #664d03;
    font-size: 0.9rem;
  }

  .level {
    display: inline-block;
    padding: 0.1rem 0.5rem;
    border-radius: 4px;
    font-size: 0.8rem;
    font-weight: 700;
    text-transform: uppercase;

    &.warn {
      background: #fff3cd;
      color: #664d03;
    }

    &.error {
      background: #f8d7da;
      color: #842029;
    }
  }

  .empty {
    color: #3d6d58;
    font-size: 1.1rem;
    margin: 0;
  }

  .repeat {
    display: inline-block;
    margin-left: 0.4rem;
    padding: 0.05rem 0.4rem;
    border-radius: 4px;
    background: #e9ecef;
    color: #495057;
    font-size: 0.75rem;
    font-weight: 600;
    white-space: nowrap;
  }
  .unreadable {
    color: #b02a37;
    font-size: 1.1rem;
  }

  .loading {
    color: #999;
    padding: 2rem;
  }

  @media (max-width: 768px) {
    .admin-container {
      padding: 1rem;
    }

    .card {
      padding: 1.25rem;
    }
  }
</style>

<svelte:head><title>Accounts and issues · Book Tracker</title></svelte:head>

<div class="admin-container">
  <nav><a href="/admin">Catalog</a> · <strong>Accounts and issues</strong></nav>
  <h1>Accounts and issues</h1>
  <p class="toolbar">
    <button type="button" disabled={refreshing} onclick={() => void load(true)}>{refreshing && overview ? 'Refreshing…' : refreshing ? 'Loading…' : 'Refresh'}</button>
    {#if loadedAt !== null}<small>as of {utc(loadedAt)} UTC</small>{/if}
  </p>

  {#if overview}
    <div class="card">
      <h2>Users</h2>
      <p class="card-subtext">
        {overview.users.length}
        {overview.users.length === 1 ? 'user' : 'users'}, sorted by last
        active (the newest of sign-in, book edit and reading session). Last
        read counts reading sessions only. All times UTC.
      </p>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Signed up</th>
              <th>Last sign-in</th>
              <th>Last active</th>
              <th>Last read</th>
              <th>Books</th>
              <th>Finished</th>
              <th>Sessions</th>
              <th>Pages</th>
              <th>Hours</th>
            </tr>
          </thead>
          <tbody>
            {#each overview.users as u (u.uid)}
              <tr>
                <td class="email" title={u.email ?? u.uid}>
                  {u.email ?? u.uid}
                  {#if u.anomaly}
                    <span class="badge-anomaly">{u.anomaly}</span>
                  {/if}
                </td>
                <td>{utcDay(u.signedUpAt)}</td>
                <td>{utc(u.lastSignInAt)}</td>
                <td>{utc(u.lastActiveAt)}</td>
                <td>{utc(u.lastReadAt)}</td>
                <td>{u.books}</td>
                <td>{u.finishedBooks}</td>
                <td>{u.readingSessions}</td>
                <td>{u.pagesRead.toLocaleString()}</td>
                <td>{Math.round(u.timeRead / 60)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <h2>Recent issues</h2>
      <p class="card-subtext">
        Warnings and errors from the last {overview.issueWindowDays} days,
        newest first.{#if caps}
          Each account is read separately and shows at most
          {caps.perAccount} rows, and the feed cut is shared evenly between
          accounts, so one account's volume never hides another's while
          the accounts with rows fit the feed.{/if} Anonymous rows are no longer written;
        the ones still listed predate that change and drop out of this
        window as it moves (the rows themselves expire with the 90-day
        retention).
      </p>
      {#if feedNotes.length > 0}
        <div class="truncated">
          <strong>Incomplete feed:</strong>
          <ul>
            {#each feedNotes as note}
              <li>{note}.</li>
            {/each}
          </ul>
        </div>
      {/if}
      {#if overview.issues.length === 0 && readFailed}
        <p class="unreadable">Nothing could be shown for this window — see above.</p>
      {:else if overview.issues.length === 0}
        <p class="empty">No warnings or errors — all clear.</p>
      {:else}
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>User</th>
                <th>Event</th>
                <th>Level</th>
                <th>Code</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {#each issueGroups as {row: issue, count, earliestAt} (issue.id)}
                <tr>
                  <td>
                    {utcSeconds(issue.at)}
                    {#if count > 1}<span class="repeat" title={`${count} identical rows, the earliest at ${utcSeconds(earliestAt)} UTC`}>×{count} since {utcSeconds(earliestAt).slice(11)}</span>{/if}
                  </td>
                  <td>
                    {issue.email}
                    {#if issue.malformed}
                      <span class="badge-malformed">malformed row</span>
                    {:else if !issue.emailVerified && issue.uid === null}
                      <span class="badge-unverified" title="Self-reported by an unauthenticated client; not tied to any account">unverified</span>
                    {/if}
                  </td>
                  <td>{issue.event}</td>
                  <td><span class="level {issue.level}">{issue.level}</span></td>
                  <td>{issue.code ?? '—'}</td>
                  <td class="message">{issue.message}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  {:else if failed}
    <div class="card">
      <h2>Couldn't load the accounts</h2>
      <p class="card-subtext">See the error banner above; Refresh retries.</p>
    </div>
  {:else}
    <p class="loading">Loading…</p>
  {/if}
</div>
