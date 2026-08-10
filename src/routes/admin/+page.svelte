<script>
  import { adminOverview } from '$lib/firebase/functions.js';
  import { addError } from '$lib/stores/errors.js';

  let overview = $state(null);
  let failed = $state(false);

  $effect(() => {
    adminOverview()
      .then((result) => (overview = result.data))
      .catch((error) => {
        failed = true;
        addError(`Couldn't load the admin overview (${error.code ?? error.message}).`);
      });
  });

  // A capped feed that looks complete is worse than one that admits it is
  // capped, so each budget that hit its limit is named explicitly.
  const truncation = $derived(
    [
      overview?.truncated?.app && `${overview.truncated.app} app events`,
      overview?.truncated?.anonymous &&
        `${overview.truncated.anonymous} anonymous sign-in failures`
    ].filter(Boolean)
  );

  // All times render in UTC: the sources mix ISO offsets and local-time
  // formatting would shift signups/activity across day boundaries.
  function utc(ms) {
    if (ms == null) return '—';
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  }

  function utcDay(ms) {
    if (ms == null) return '—';
    return new Date(ms).toISOString().slice(0, 10);
  }
</script>

<style lang="scss">
  .admin-container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 2rem;
    text-align: left;
  }

  h1 {
    font-size: 2rem;
    color: #333;
    margin-bottom: 1.5rem;
  }

  .card {
    background: white;
    padding: 2rem;
    border-radius: 5px;
    box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.2), 0 6px 20px 0 rgba(0, 0, 0, 0.19);
    margin-bottom: 2rem;

    h2 {
      font-size: 1.5rem;
      color: #333;
      margin: 0 0 0.25rem 0;
    }

    .card-subtext {
      font-size: 0.9rem;
      color: #999;
      margin-bottom: 1.5rem;
    }
  }

  .table-scroll {
    overflow-x: auto;
  }

  table {
    width: 100%;
    min-width: 720px;
    border-collapse: collapse;

    th,
    td {
      padding: 0.6rem 0.75rem;
      text-align: left;
      border-bottom: 1px solid #e0e0e0;
      white-space: nowrap;
    }

    th {
      font-size: 0.85rem;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-weight: 600;
    }

    td {
      font-size: 0.95rem;
      color: #333;
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
  .badge-unverified {
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
    color: #198754;
    font-size: 1.1rem;
    margin: 0;
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

<div class="admin-container">
  <h1>Admin overview</h1>

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
                <td>
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
        newest first. App events and anonymous sign-in failures are fetched
        under separate caps, so a flood of anonymous rows cannot push app
        errors out of view.
      </p>
      {#if truncation.length > 0}
        <p class="truncated">
          Showing the newest {truncation.join(' and ')} — older entries in
          this window are not listed.
        </p>
      {/if}
      {#if overview.issues.length === 0}
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
              {#each overview.issues as issue (issue.id)}
                <tr>
                  <td>{utc(issue.at)}</td>
                  <td>
                    {issue.email}
                    {#if !issue.emailVerified && issue.uid === null}
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
      <h2>Couldn't load the overview</h2>
      <p class="card-subtext">See the error banner above; reload to retry.</p>
    </div>
  {:else}
    <p class="loading">Loading…</p>
  {/if}
</div>
