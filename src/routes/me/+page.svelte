<script>
  import { user, signOut } from '$lib/firebase/auth.js';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import NewBookModal from '$lib/components/NewBookModal.svelte';
  import ReadingHeatmap from '$lib/components/ReadingHeatmap.svelte';
  import SuperlativesRow from '$lib/components/SuperlativesRow.svelte';
  import SpeedSection from '$lib/components/SpeedSection.svelte';
  import ClockSection from '$lib/components/ClockSection.svelte';
  import CadenceSection from '$lib/components/CadenceSection.svelte';
  import ProgressSection from '$lib/components/ProgressSection.svelte';
  import AuthorLeaderboardSection from '$lib/components/AuthorLeaderboardSection.svelte';
  import { Database } from '$lib/firebase/db.js';
  import { togglSaveToken } from '$lib/firebase/functions.js';
  import { formatTime, formatDateRange, formatMonthYear } from '$lib/utils/format.js';
  import {
    computeStats,
    computeBooksByYear,
    aggregateSessionsByDay,
    buildProfilePayload,
    profilePayloadEqual,
    USERNAME_PATTERN,
  } from '$lib/utils/stats.js';
  import { buildBookTimelines, finishedAtByBook, monthlyAggregates } from '$lib/utils/sessions.js';
  import { LINK_TYPES, MAX_PROFILE_LINKS, linkIcon, linkTypeName } from '$lib/utils/links.js';
  import Icon from 'svelte-awesome';

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

  // All update docs ('reading' sessions plus page-only 'update'
  // corrections), for the heatmap, the published profile, and the session
  // analytics; undefined until the first snapshot (same loading sentinel
  // as allBooks, and for the same reason).
  let allSessions = $state(undefined);
  $effect(() => {
    if ($user) {
      const sessionsStore = Database.getAllReadingSessions($user.uid);
      const unsubscribe = sessionsStore.subscribe((sessions) => {
        allSessions = sessions;
      });
      return () => {
        unsubscribe();
        sessionsStore.unsubscribe();
      };
    }
  });
  // aggregateSessionsByDay filters to reading-only itself, so the heatmap
  // and published day totals ignore the page-only 'update' docs the
  // widened listener now carries.
  const sessionDays = $derived(aggregateSessionsByDay(allSessions ?? []));

  // Session-derived finish dates (a book finishes at its last update of
  // any type): feed the per-year table, the card ranges, and the published
  // payload, so a book read across a year boundary counts in the year it
  // was actually finished. timelines and months are computed once here and
  // passed to the sections — each is a full pass over ~3.5k session docs.
  const timelines = $derived(buildBookTimelines(allSessions ?? []));
  const finishedAt = $derived(finishedAtByBook(allBooks ?? [], timelines));
  const months = $derived(monthlyAggregates(allSessions ?? []));

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
  const stats = $derived(computeStats(allBooks ?? [], finishedAt));
  const booksByYear = $derived(computeBooksByYear(allBooks ?? [], finishedAt));

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

  // Profile-edit form. Seeded from the loaded profile exactly once: the
  // stat-sync effect below rewrites the doc while the page is open, and
  // reseeding on every listener echo would stomp in-progress typing. With
  // no profile yet, the slug defaults to the email prefix (sanitized to
  // the slug charset) so there's always something sensible to start from.
  let profileGivenName = $state('');
  let profileFamilyName = $state('');
  let profileSlug = $state('');
  let profileFormSeeded = $state(false);
  $effect(() => {
    if (!profileFormSeeded && myProfile !== undefined && $user) {
      profileGivenName = myProfile?.givenName ?? '';
      profileFamilyName = myProfile?.familyName ?? '';
      profileSlug = myProfile?.username
        ?? username.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30);
      profileFormSeeded = true;
    }
  });

  let profileError = $state('');
  let profileSaved = $state(false);
  let savingProfile = $state(false);
  let linkCopied = $state(false);

  const profileUrl = $derived(myProfile ? `${page.url.origin}/profiles/${myProfile.username}` : '');

  async function saveProfile() {
    const chosenSlug = profileSlug.trim().toLowerCase();
    const chosenGiven = profileGivenName.trim().replace(/\s+/g, ' ').slice(0, 50);
    const chosenFamily = profileFamilyName.trim().replace(/\s+/g, ' ').slice(0, 50);
    if (!USERNAME_PATTERN.test(chosenSlug)) {
      profileError = 'Profile slug: 3–30 characters, lowercase letters, numbers, and dashes.';
      return;
    }
    savingProfile = true;
    profileError = '';
    profileSaved = false;
    const names = { givenName: chosenGiven, familyName: chosenFamily };
    try {
      if (!myProfile) {
        // Born private: the page is only ever opened to the world by the
        // explicit visibility checkbox below.
        await Database.createProfile({
          userId: $user.uid, username: chosenSlug, ...names, links: [],
          isPublic: false, ...buildProfilePayload(allBooks, sessionDays, finishedAt),
        });
      } else if (chosenSlug === myProfile.username) {
        await Database.updateProfile({
          userId: $user.uid, username: chosenSlug, ...names,
          links: myProfile.links ?? [], isPublic: myProfile.public,
          ...buildProfilePayload(allBooks, sessionDays, finishedAt),
        });
      } else {
        await Database.renameProfile({
          userId: $user.uid, oldUsername: myProfile.username, newUsername: chosenSlug,
          ...names, links: myProfile.links ?? [], isPublic: myProfile.public,
          ...buildProfilePayload(allBooks, sessionDays, finishedAt),
        });
      }
      profileGivenName = chosenGiven;
      profileFamilyName = chosenFamily;
      profileSlug = chosenSlug;
      profileSaved = true;
      setTimeout(() => (profileSaved = false), 2000);
    } catch (error) {
      // The rules turn "slug taken" into permission-denied (create on an
      // existing doc evaluates as an update of someone else's doc).
      profileError = error.code === 'permission-denied'
        ? `"${chosenSlug}" is already taken.`
        : error.message;
    } finally {
      savingProfile = false;
    }
  }

  async function deleteProfile() {
    savingProfile = true;
    await Database.deleteProfile({ userId: $user.uid, username: myProfile.username });
    savingProfile = false;
  }

  // Full-doc rewrite from the current profile plus fresh stats; overrides
  // carry the one field an immediate-write control (visibility checkbox,
  // handle add/remove) is changing.
  function persistProfile(overrides = {}) {
    return Database.updateProfile({
      userId: $user.uid,
      username: myProfile.username,
      givenName: myProfile.givenName ?? '',
      familyName: myProfile.familyName ?? '',
      links: myProfile.links ?? [],
      isPublic: myProfile.public,
      ...buildProfilePayload(allBooks, sessionDays, finishedAt),
      ...overrides,
    });
  }

  function setProfileVisibility(isPublic) {
    persistProfile({ isPublic });
  }

  // Handle editor: the plus opens the picker, choosing a platform reveals
  // the value field, Add writes immediately (like the visibility checkbox).
  let linkPickerOpen = $state(false);
  let newLinkType = $state('');
  let newLinkLabel = $state('');
  let newLinkValue = $state('');

  function addLink() {
    const value = newLinkValue.trim().slice(0, 200);
    if (!value) return;
    const link = { type: newLinkType, value };
    if (newLinkType === 'other' && newLinkLabel.trim()) {
      link.label = newLinkLabel.trim().slice(0, 50);
    }
    persistProfile({ links: [...(myProfile.links ?? []), link] });
    linkPickerOpen = false;
    newLinkType = '';
    newLinkLabel = '';
    newLinkValue = '';
  }

  function removeLink(index) {
    persistProfile({ links: (myProfile.links ?? []).filter((_, i) => i !== index) });
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
    if (!$user || !myProfile || allBooks === undefined || allSessions === undefined) return;
    const payload = buildProfilePayload(allBooks, sessionDays, finishedAt);
    if (profilePayloadEqual(myProfile, payload)) return;
    persistProfile();
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

  // The <details> element itself is the card: the summary is its header
  // row and the sections expand inside the same box, so opening it grows
  // the card instead of conjuring disconnected boxes below it.
  .settings {
    background: white;
    border-radius: 5px;
    box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.2), 0 6px 20px 0 rgba(0, 0, 0, 0.19);
    margin-bottom: 2rem;

    summary {
      padding: 1rem 2rem;
      font-size: 1rem;
      font-weight: 600;
      color: #333;
      cursor: pointer;
      user-select: none;
    }

    .settings-body {
      padding: 0 2rem 2rem;
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

  // Flat sections inside the settings card, divided by hairlines (the
  // first line separates the summary row from the body).
  .toggl-card {
    border-top: 1px solid #e0e0e0;
    padding: 1.5rem 0 2rem;

    &:last-child {
      padding-bottom: 0;
    }

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
      margin-top: 1rem;

      a {
        font-size: 1.1rem;
        word-break: break-all;
      }
    }

    .share-error {
      color: #dc3545;
      margin: 0.75rem 0 0 0;
    }

    .handles {
      margin-top: 1rem;

      .handle-row {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.35rem 0;
        color: #333;

        .handle-name {
          font-weight: 600;
        }

        .handle-value {
          color: #666;
          overflow-wrap: anywhere;
        }

        .handle-remove {
          border: none;
          background: none;
          color: #dc3545;
          font-size: 1.2rem;
          line-height: 1;
          cursor: pointer;
          padding: 0 0.25rem;
        }
      }

      .handle-add {
        display: flex;
        gap: 0.75rem;
        flex-wrap: wrap;
        margin-top: 0.5rem;

        select, input {
          flex: 1;
          min-width: 160px;
        }
      }

      .handle-add button,
      .handle-plus {
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

      .handle-plus {
        margin-top: 0.5rem;
      }
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
      min-width: 640px;
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

    .books-by-year {
      padding: 1.25rem;
    }

    .settings {
      summary {
        padding: 1rem 1.25rem;
      }

      .settings-body {
        padding: 0 1.25rem 1.25rem;
      }
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
      <h1>Welcome back, {myProfile?.givenName || username}!</h1>
      <p class="email">{$user.email}</p>
    </div>

    <div class="actions">
      <button onclick={toggleModal}>Add New Book</button>
      <button onclick={handleSignOut}>Sign Out</button>
    </div>

    <details class="settings">
      <summary>Settings</summary>
      <div class="settings-body">
        <div class="toggl-card share-card">
          <h2>Profile</h2>
          {#if myProfile}
            {#if myProfile.public}
              <p class="toggl-status connected">
                Public — anyone with the link can see your reading stats (no
                book titles). Stats refresh whenever you open this page.
              </p>
            {:else}
              <p class="toggl-status">
                Private — only you can see your profile page while signed
                in. Check the box below to make it publicly available.
              </p>
            {/if}
          {:else if myProfile === null}
            <p class="toggl-status">
              Set your name and pick a profile slug (the last part of your
              profile page's link) to create your profile page. The page
              starts private (visible only to you) until you make it
              public. Only aggregate numbers are published — never your
              book titles or reading sessions.
            </p>
          {/if}
          <form
            onsubmit={(event) => {
              event.preventDefault();
              saveProfile();
            }}>
            <input
              type="text"
              class="form-control"
              placeholder="First name"
              maxlength="50"
              bind:value={profileGivenName} />
            <input
              type="text"
              class="form-control"
              placeholder="Last name"
              maxlength="50"
              bind:value={profileFamilyName} />
            <input
              type="text"
              class="form-control"
              placeholder="Profile slug"
              bind:value={profileSlug} />
            <button type="submit" disabled={savingProfile || !profileSlug || allBooks === undefined || allSessions === undefined}>
              {myProfile ? (profileSaved ? 'Saved!' : 'Save') : 'Create Profile'}
            </button>
          </form>
          {#if profileError}
            <p class="share-error">{profileError}</p>
          {/if}
          {#if myProfile}
            <div class="profile-link">
              <a href={profileUrl} target="_blank" rel="noopener">{profileUrl}</a>
            </div>
            <div class="handles">
              {#each myProfile.links ?? [] as link, i}
                <div class="handle-row">
                  <Icon data={linkIcon(link)} />
                  <span class="handle-name">{linkTypeName(link)}</span>
                  <span class="handle-value">{link.value}</span>
                  <button
                    type="button"
                    class="handle-remove"
                    aria-label="Remove {linkTypeName(link)}"
                    onclick={() => removeLink(i)}>×</button>
                </div>
              {/each}
              {#if linkPickerOpen}
                <div class="handle-add">
                  <select class="form-control" bind:value={newLinkType}>
                    <option value="" disabled>Choose platform…</option>
                    {#each LINK_TYPES as linkType}
                      <option value={linkType.type}>{linkType.name}</option>
                    {/each}
                  </select>
                  {#if newLinkType === 'other'}
                    <input
                      type="text"
                      class="form-control"
                      placeholder="Label (e.g. Blog)"
                      maxlength="50"
                      bind:value={newLinkLabel} />
                  {/if}
                  {#if newLinkType}
                    <input
                      type="text"
                      class="form-control"
                      placeholder="Link or handle"
                      maxlength="200"
                      bind:value={newLinkValue} />
                    <button type="button" onclick={addLink} disabled={!newLinkValue.trim()}>
                      Add
                    </button>
                  {/if}
                  <button type="button" onclick={() => (linkPickerOpen = false)}>Cancel</button>
                </div>
              {:else if (myProfile.links ?? []).length < MAX_PROFILE_LINKS}
                <button type="button" class="handle-plus" onclick={() => (linkPickerOpen = true)}>
                  + Add handle
                </button>
              {/if}
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
              <button type="button" onclick={deleteProfile} disabled={savingProfile}>
                Delete Profile
              </button>
            </div>
          {/if}
        </div>

        <div class="toggl-card">
          <h2>Toggl Track</h2>
          {#if userDoc?.toggl}
            <p class="toggl-status connected">
              Connected — timers log to your "Reading" project in Toggl.
            </p>
          {:else}
            <p class="toggl-status">
              Paste your Toggl API token (found under Profile settings in
              Toggl) to start reading timers from your book list. Requires a
              Toggl project named "Reading".
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
      </div>
    </details>

    <div class="stats-grid">
      <a href="/finished" class="stat-card clickable">
        <div class="stat-label">Books Read</div>
        <div class="stat-value">{stats.finishedBooks}</div>
        <div class="stat-subtext">
          {stats.firstFinishedAt
            ? formatDateRange(stats.firstFinishedAt, stats.lastFinishedAt)
            : 'Completed books'}
        </div>
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
        <div class="stat-subtext">
          {stats.totalPagesRead.toLocaleString()} pages{stats.firstBookAddedAt
            ? ` since ${formatMonthYear(stats.firstBookAddedAt)}`
            : ' read'}
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Books Per Year</div>
        <div class="stat-value">{stats.booksPerYear}</div>
        <div class="stat-subtext">
          {stats.firstFinishedAt
            ? formatDateRange(stats.firstFinishedAt, new Date())
            : 'Average rate'}
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Avg. Time Per Book</div>
        <div class="stat-value">{formatTime(stats.avgTimePerBook)}</div>
        <div class="stat-subtext">Across {stats.finishedBooks} finished books</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Total Books</div>
        <div class="stat-value">{stats.totalBooks}</div>
        <div class="stat-subtext">
          {stats.firstBookAddedAt
            ? `First added ${formatMonthYear(stats.firstBookAddedAt)}`
            : 'In your library'}
        </div>
      </div>
    </div>

    <SuperlativesRow sessions={allSessions ?? []} books={allBooks ?? []} {timelines} />
    <SpeedSection sessions={allSessions ?? []} books={allBooks ?? []} {months} />
    <ClockSection sessions={allSessions ?? []} />
    <CadenceSection {months} />
    <ProgressSection sessions={allSessions ?? []} books={allBooks ?? []} {timelines} />
    <AuthorLeaderboardSection books={allBooks ?? []} authors={authorList ?? []} />

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
              <th>Authors</th>
              <th>Longest Book</th>
              <th>Shortest Book</th>
            </tr>
          </thead>
          <tbody>
            {#each booksByYear as { year, count, totalTimeRead, totalPages, longestBook, shortestBook, uniqueAuthors, newAuthors }}
              <tr>
                <td>{year}</td>
                <td>{count}</td>
                <td>{Math.round(totalTimeRead / 60)}</td>
                <td>{totalPages.toLocaleString()}</td>
                <td>{uniqueAuthors} ({newAuthors} new)</td>
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
                <td>
                  {#if shortestBook}
                    <span class="book-info">
                      <span class="book-title">{shortestBook.title}</span>
                      <span class="book-pages">({shortestBook.pageCount} pages)</span>
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

    <ReadingHeatmap days={sessionDays} />
  </div>
{/if}
