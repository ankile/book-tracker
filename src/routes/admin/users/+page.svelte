<script lang="ts">
  import '$lib/components/admin/admin.css';
  import { onMount } from 'svelte';
  import AdminHeader from '$lib/components/admin/AdminHeader.svelte';
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

<svelte:head><title>Accounts and issues · Book Tracker</title></svelte:head>

<main class="admin-console">
  <AdminHeader active="accounts">
    {#snippet status()}
      {#if loadedAt !== null}<span>As of {utc(loadedAt)} UTC</span>{/if}
      <button type="button" disabled={refreshing} onclick={() => void load(true)}>{refreshing && overview ? 'Refreshing…' : refreshing ? 'Loading…' : 'Refresh'}</button>
    {/snippet}
  </AdminHeader>
  <div class="page-title">
    <div>
      <h1>Accounts and issues</h1>
      <p class="lead">Every account with its activity, and the warnings and errors the app has reported. Read from the server when this page opens, never prefetched.</p>
    </div>
  </div>

  {#if overview}
    <section class="card" aria-labelledby="users-heading">
      <h2 id="users-heading">Users <span>{overview.users.length}</span></h2>
      <p>
        Sorted by last active (the newest of sign-in, book edit and reading
        session). Last read counts reading sessions only. All times UTC.
      </p>
      <div class="table-scroll">
        <table class="compact">
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
                    <span class="badge warn">{u.anomaly}</span>
                  {/if}
                </td>
                <td class="numeric">{utcDay(u.signedUpAt)}</td>
                <td class="numeric">{utc(u.lastSignInAt)}</td>
                <td class="numeric">{utc(u.lastActiveAt)}</td>
                <td class="numeric">{utc(u.lastReadAt)}</td>
                <td class="numeric">{u.books}</td>
                <td class="numeric">{u.finishedBooks}</td>
                <td class="numeric">{u.readingSessions}</td>
                <td class="numeric">{u.pagesRead.toLocaleString()}</td>
                <td class="numeric">{Math.round(u.timeRead / 60)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <section class="card" aria-labelledby="issues-heading">
      <h2 id="issues-heading">Recent issues <span>{overview.issues.length}</span></h2>
      <p>
        Warnings and errors from the last {overview.issueWindowDays} days,
        newest first. {#if caps}Each account is read separately and shows at most
          {caps.perAccount} rows, and the feed cut is shared evenly between
          accounts, so one account's volume never hides another's while
          the accounts with rows fit the feed.{/if} Anonymous rows are no longer written;
        the ones still listed predate that change and drop out of this
        window as it moves (the rows themselves expire with the 90-day
        retention).
      </p>
      {#if feedNotes.length > 0}
        <div class="notice warning">
          <strong>Incomplete feed:</strong>
          <ul>
            {#each feedNotes as note}
              <li>{note}.</li>
            {/each}
          </ul>
        </div>
      {/if}
      {#if overview.issues.length === 0 && readFailed}
        <div class="notice error">Nothing could be shown for this window — see above.</div>
      {:else if overview.issues.length === 0}
        <p class="empty">No warnings or errors — all clear.</p>
      {:else}
        <div class="table-scroll">
          <table class="compact">
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
                  <td class="numeric">
                    {utcSeconds(issue.at)}
                    {#if count > 1}<span class="badge help" title={`${count} identical rows, the earliest at ${utcSeconds(earliestAt)} UTC`}>×{count} since {utcSeconds(earliestAt).slice(11)}</span>{/if}
                  </td>
                  <td>
                    {issue.email}
                    {#if issue.malformed}
                      <span class="badge bad">malformed row</span>
                    {:else if !issue.emailVerified && issue.uid === null}
                      <span class="badge help" title="Self-reported by an unauthenticated client; not tied to any account">unverified</span>
                    {/if}
                  </td>
                  <td>{issue.event}</td>
                  <td><span class="badge {issue.level}">{issue.level}</span></td>
                  <td>{issue.code ?? '—'}</td>
                  <td class="message">{issue.message}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>
  {:else if failed}
    <section class="card">
      <h2>Couldn't load the accounts</h2>
      <p>See the error banner above; Refresh retries.</p>
    </section>
  {:else}
    <section class="card loading" aria-live="polite">
      <p>Loading the accounts and the issue feed from the server…</p>
    </section>
  {/if}
</main>
