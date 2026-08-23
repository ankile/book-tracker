<script>
  import { user, signOut } from '$lib/firebase/auth.js';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import NewBookModal from '$lib/components/NewBookModal.svelte';
  import ReadingHeatmap from '$lib/components/ReadingHeatmap.svelte';
  import { Database } from '$lib/firebase/db.js';
  import { togglSaveToken } from '$lib/firebase/functions.js';
  import { formatTime } from '$lib/utils/format.js';
  import {
    computeStats,
    computeBooksByYear,
    buildProfilePayload,
    profilePayloadEqual,
    USERNAME_PATTERN,
  } from '$lib/utils/stats.js';

  let newBookModal = $state(false);

  async function handleSignOut() {
    await signOut();
    goto('/', { replaceState: true });
  }

  const toggleModal = () => (newBookModal = !newBookModal);
  const closeModal = () => (newBookModal = false);

  // Get all books for statistics; undefined until the first snapshot (the
  // profile sync below must not run against the pre-snapshot empty list).
  let allBooks = $state(undefined);
  $effect(() => {
    if ($user) {
      const booksStore = Database.getAllBooks($user.uid);
      const unsubscribe = booksStore.subscribe((books) => {
        allBooks = books;
      });
      return () => {
        unsubscribe();
        booksStore.unsubscribe();
      };
    }
  });

  // Author docs, for the Authors management card's count.
  let authorList = $state(undefined);
  $effect(() => {
    if ($user) {
      const authorsStore = Database.getAuthors($user.uid);
      const unsubscribe = authorsStore.subscribe((data) => (authorList = data));
      return () => {
        unsubscribe();
        authorsStore.unsubscribe();
      };
    }
  });

  // User document (for the Toggl connection status)
  let userDoc = $state(null);
  $effect(() => {
    if ($user) {
      const userStore = Database.getUser($user.uid);
      const unsubscribe = userStore.subscribe((data) => {
        userDoc = data;
      });
      return () => {
        unsubscribe();
        userStore.unsubscribe();
      };
    }
  });

  let togglToken = $state('');
  let savingToken = $state(false);

  async function saveTogglToken() {
    savingToken = true;
    try {
      await togglSaveToken({ token: togglToken });
      togglToken = '';
    } catch (error) {
      alert(error.message);
    } finally {
      savingToken = false;
    }
  }

  // Statistics (shared with the public-profile payload, see utils/stats.js)
  const stats = $derived(computeStats(allBooks ?? []));
  const booksByYear = $derived(computeBooksByYear(allBooks ?? []));

  // Extract username from email
  const username = $derived($user ? $user.email.split('@')[0] : '');

  // Public profile: undefined → loading, null → none enabled.
  let myProfile = $state(undefined);
  $effect(() => {
    if ($user) {
      const profileStore = Database.getMyProfile($user.uid);
      const unsubscribe = profileStore.subscribe((data) => (myProfile = data));
      return () => {
        unsubscribe();
        profileStore.unsubscribe();
      };
    }
  });

  let profileUsername = $state('');
  let profileError = $state('');
  let savingProfile = $state(false);
  let linkCopied = $state(false);

  const profileUrl = $derived(myProfile ? `${page.url.origin}/profiles/${myProfile.username}` : '');

  async function enableProfile() {
    const chosen = profileUsername.trim().toLowerCase();
    if (!USERNAME_PATTERN.test(chosen)) {
      profileError = '3–30 characters: lowercase letters, numbers, and dashes.';
      return;
    }
    savingProfile = true;
    profileError = '';
    try {
      // Born private: the page is only ever opened to the world by the
      // explicit visibility checkbox below.
      await Database.createProfile({ userId: $user.uid, username: chosen, isPublic: false, ...buildProfilePayload(allBooks) });
      profileUsername = '';
    } catch (error) {
      // The rules turn "username taken" into permission-denied (create on
      // an existing doc evaluates as an update of someone else's doc).
      profileError = error.code === 'permission-denied'
        ? `"${chosen}" is already taken.`
        : error.message;
    } finally {
      savingProfile = false;
    }
  }

  async function disableProfile() {
    savingProfile = true;
    await Database.deleteProfile({ userId: $user.uid, username: myProfile.username });
    savingProfile = false;
  }

  function setProfileVisibility(isPublic) {
    Database.updateProfile({ userId: $user.uid, username: myProfile.username, isPublic, ...buildProfilePayload(allBooks) });
  }

  async function copyProfileLink() {
    await navigator.clipboard.writeText(profileUrl);
    linkCopied = true;
    setTimeout(() => (linkCopied = false), 2000);
  }

  // Keep the published doc in step with live stats: whenever this page
  // recomputes and the public copy differs, overwrite it. The equality
  // check excludes updatedAt, so the listener echo of our own write reads
  // as clean and the effect settles instead of looping.
  $effect(() => {
    if (!$user || !myProfile || allBooks === undefined) return;
    const payload = buildProfilePayload(allBooks);
    if (profilePayloadEqual(myProfile, payload)) return;
    Database.updateProfile({ userId: $user.uid, username: myProfile.username, isPublic: myProfile.public, ...payload });
  });
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

  .toggl-card {
    background: white;
    padding: 2rem;
    border-radius: 5px;
    box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.2), 0 6px 20px 0 rgba(0, 0, 0, 0.19);
    margin-bottom: 2rem;

    h2 {
      font-size: 1.5rem;
      color: #333;
      margin: 0 0 1rem 0;
    }

    .toggl-status {
      color: #666;
      margin-bottom: 1rem;

      &.connected {
        color: #198754;
      }
    }

    form {
      display: flex;
      gap: 1rem;
      flex-wrap: wrap;

      input {
        flex: 1;
        min-width: 200px;
      }

      button {
        border: none;
        background: white;
        padding: 0.5rem 1.5rem;
        font-weight: 600;
        color: #333;
        box-shadow: 0 2px 4px 0 rgba(0, 0, 0, 0.2);
        border-radius: 5px;
        cursor: pointer;

        &:disabled {
          opacity: 0.5;
          cursor: default;
        }
      }
    }
  }

  .share-card {
    .profile-link {
      display: flex;
      align-items: center;
      gap: 1rem;
      flex-wrap: wrap;

      a {
        font-size: 1.1rem;
        word-break: break-all;
      }
    }

    .share-error {
      color: #dc3545;
      margin: 0.75rem 0 0 0;
    }

    .share-visibility {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-top: 1rem;
      color: #333;
      cursor: pointer;

      input {
        width: 1.1rem;
        height: 1.1rem;
        cursor: pointer;
      }
    }

    .share-actions {
      display: flex;
      gap: 1rem;
      margin-top: 1rem;

      button {
        border: none;
        background: white;
        padding: 0.5rem 1.5rem;
        font-weight: 600;
        color: #333;
        box-shadow: 0 2px 4px 0 rgba(0, 0, 0, 0.2);
        border-radius: 5px;
        cursor: pointer;

        &:disabled {
          opacity: 0.5;
          cursor: default;
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
      min-width: 480px;
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

    .toggl-card,
    .books-by-year {
      padding: 1.25rem;
    }

    .books-by-year table {
      th, td {
        padding: 0.5rem;
      }

      td {
        font-size: 1rem;
      }
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
        <div class="stat-value">{stats.finishedBooks}</div>
        <div class="stat-subtext">Completed books</div>
      </a>

      <a href="/" class="stat-card clickable">
        <div class="stat-label">Currently Reading</div>
        <div class="stat-value">{stats.readingBooks}</div>
        <div class="stat-subtext">In progress</div>
      </a>

      <a href="/authors" class="stat-card clickable">
        <div class="stat-label">Authors</div>
        <div class="stat-value">{authorList?.length ?? '…'}</div>
        <div class="stat-subtext">Rename, merge, sort names</div>
      </a>

      <div class="stat-card">
        <div class="stat-label">Total Time Read</div>
        <div class="stat-value">{stats.totalTimeReadHours} hrs</div>
        <div class="stat-subtext">{stats.totalPagesRead.toLocaleString()} pages read</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Books Per Year</div>
        <div class="stat-value">{stats.booksPerYear}</div>
        <div class="stat-subtext">Average rate</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Avg. Time Per Book</div>
        <div class="stat-value">{formatTime(stats.avgTimePerBook)}</div>
        <div class="stat-subtext">For finished books</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Total Books</div>
        <div class="stat-value">{stats.totalBooks}</div>
        <div class="stat-subtext">In your library</div>
      </div>
    </div>

    <div class="toggl-card">
      <h2>Toggl Track</h2>
      {#if userDoc?.toggl}
        <p class="toggl-status connected">
          Connected — timers log to your "Reading" project in Toggl.
        </p>
      {:else}
        <p class="toggl-status">
          Paste your Toggl API token (found under Profile settings in Toggl) to
          start reading timers from your book list. Requires a Toggl project
          named "Reading".
        </p>
      {/if}
      <form
        onsubmit={(event) => {
          event.preventDefault();
          saveTogglToken();
        }}>
        <input
          type="password"
          class="form-control"
          placeholder="Toggl API token"
          bind:value={togglToken} />
        <button type="submit" disabled={savingToken || !togglToken}>
          {userDoc?.toggl ? 'Replace Token' : 'Connect'}
        </button>
      </form>
    </div>

    <div class="toggl-card share-card">
      <h2>Public Profile</h2>
      {#if myProfile}
        {#if myProfile.public}
          <p class="toggl-status connected">
            Public — anyone with the link can see your reading stats (no
            book titles). Stats refresh whenever you open this page.
          </p>
        {:else}
          <p class="toggl-status">
            Private — only you can see your profile page while signed in.
            Check the box below to make it publicly available.
          </p>
        {/if}
        <div class="profile-link">
          <a href={profileUrl} target="_blank" rel="noopener">{profileUrl}</a>
        </div>
        <label class="share-visibility">
          <input
            type="checkbox"
            checked={myProfile.public}
            onchange={(event) => setProfileVisibility(event.currentTarget.checked)} />
          Make my profile publicly available
        </label>
        <div class="share-actions">
          <button type="button" onclick={copyProfileLink}>
            {linkCopied ? 'Copied!' : 'Copy Link'}
          </button>
          <button type="button" onclick={disableProfile} disabled={savingProfile}>
            Delete Profile
          </button>
        </div>
      {:else if myProfile === null}
        <p class="toggl-status">
          Pick a username to get a link to your reading stats. The page
          starts private (visible only to you) until you make it public.
          Only aggregate numbers are published — never your book titles or
          reading sessions.
        </p>
        <form
          onsubmit={(event) => {
            event.preventDefault();
            enableProfile();
          }}>
          <input
            type="text"
            class="form-control"
            placeholder="username"
            bind:value={profileUsername} />
          <button type="submit" disabled={savingProfile || !profileUsername || allBooks === undefined}>
            Enable
          </button>
        </form>
        {#if profileError}
          <p class="share-error">{profileError}</p>
        {/if}
      {/if}
    </div>

    {#if booksByYear.length > 0}
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
              <th>Longest Book</th>
            </tr>
          </thead>
          <tbody>
            {#each booksByYear as { year, count, totalTimeRead, totalPages, longestBook }}
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
      </div>
    {/if}

    <ReadingHeatmap userId={$user.uid} />
  </div>
{/if}
