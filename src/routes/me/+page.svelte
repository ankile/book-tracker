<script lang="ts">
  import { user, signOut } from '$lib/firebase/auth.ts';
  import { page } from '$app/state';
  import ReadingHeatmap from '$lib/components/ReadingHeatmap.svelte';
  import SuperlativesRow from '$lib/components/SuperlativesRow.svelte';
  import SpeedSection from '$lib/components/SpeedSection.svelte';
  import ClockSection from '$lib/components/ClockSection.svelte';
  import CadenceSection from '$lib/components/CadenceSection.svelte';
  import ProgressSection from '$lib/components/ProgressSection.svelte';
  import AuthorLeaderboardSection from '$lib/components/AuthorLeaderboardSection.svelte';
  import ProfileLinks from '$lib/components/ProfileLinks.svelte';
  import StatCard from '$lib/components/StatCard.svelte';
  import StatGrid from '$lib/components/StatGrid.svelte';
  import { Database, type BookSharingSettings } from '$lib/firebase/db.ts';
  import { togglClearToken, togglSaveToken } from '$lib/firebase/functions.ts';
  import { formatTime, formatDateRange, formatMonthYear } from '$lib/utils/format.ts';
  import { countIsbnProblems } from '$lib/utils/metadataHealth.ts';
  import {
    effectiveBookAuthorIds,
    readableBookAuthorIds,
    selectableAuthors,
  } from '$lib/utils/authors.ts';
  import {
    computeStats,
    computeBooksByYear,
    aggregateSessionsByDay,
    buildProfilePayload,
    profilePayloadEqual,
    USERNAME_PATTERN,
  } from '$lib/utils/stats.ts';
  import {
    buildBookTimelines,
    computeMomentum,
    computeSuperlatives,
    monthlyAggregates,
  } from '$lib/utils/sessions.ts';
  import { LINK_TYPES, MAX_PROFILE_LINKS } from '$lib/utils/links.ts';
  import { acceptReportedWrite } from '$lib/utils/offlineWrite.ts';
  import { FirebaseError } from 'firebase/app';
  import type { Author } from '$lib/interfaces/author.ts';
  import type { Book } from '$lib/interfaces/book.ts';
  import type {
    Profile,
    ProfileDiscovery,
    ProfileLink,
    ProfileLinkType,
    ProfileRecords,
  } from '$lib/interfaces/profile.ts';
  import type { BookUpdate } from '$lib/interfaces/reading.ts';
  import type { UserDocument } from '$lib/firebase/decoders.ts';

  async function handleSignOut() {
    // signOut ends with a clean reload onto the front page (SEC-004:
    // the local Firestore mirror is dropped), so no goto here.
    await signOut();
  }

  // Get all books for statistics; undefined until the first snapshot (the
  // profile sync below must not run against the pre-snapshot empty list).
  let allBooks = $state<Book[] | undefined>(undefined);
  $effect(() => {
    if ($user) {
      const booksStore = Database.getAllBooks($user.uid);
      const unsubscribe = booksStore.subscribe((books) => {
        allBooks = books;
      });
      return unsubscribe;
    }
  });

  // Author docs, for analytics identity and the management-card count.
  let authorList = $state<Author[] | undefined>(undefined);
  $effect(() => {
    if ($user) {
      const authorsStore = Database.getAuthors();
      const unsubscribe = authorsStore.subscribe((data) => (authorList = data));
      return unsubscribe;
    }
  });

  // Analytics need a total authorIds array. Legacy books derive it only
  // from their authoritative embedded author records; a lone legacy name
  // has no stable author identity and therefore contributes no author id.
  const analyticsBooks = $derived.by(() => {
    const authorMap = new Map((authorList ?? []).map((author) => [author.id, author]));
    return (allBooks ?? []).map((book) => {
      return {
        ...book,
        // Aggregate counts retain a raw dangling id instead of undercounting;
        // named analytics such as the leaderboard omit it because there is no
        // selectable author row to supply a name.
        authorIds: authorList === undefined
          ? effectiveBookAuthorIds(book)
          : readableBookAuthorIds(book, authorMap),
      };
    });
  });

  // All update docs ('reading' sessions plus page-only 'update'
  // corrections), for the heatmap, the published profile, and the session
  // analytics; undefined until the first snapshot (same loading sentinel
  // as allBooks, and for the same reason).
  let allSessions = $state<BookUpdate[] | undefined>(undefined);
  $effect(() => {
    if ($user) {
      const sessionsStore = Database.getAllReadingSessions($user.uid);
      const unsubscribe = sessionsStore.subscribe((sessions) => {
        allSessions = sessions;
      });
      return unsubscribe;
    }
  });
  // aggregateSessionsByDay filters to reading-only itself, so the heatmap
  // and published day totals ignore the page-only 'update' docs the
  // widened listener now carries.
  const sessionDays = $derived(aggregateSessionsByDay(allSessions ?? []));

  // Finish dates come from each book's own finishedAt stamp (finishedDateOf
  // in utils/stats.ts), never from its sessions. timelines and months are
  // computed once here and passed to the sections — each is a full pass
  // over ~3.5k session docs.
  const timelines = $derived(buildBookTimelines(allSessions ?? []));
  const months = $derived(monthlyAggregates(allSessions ?? []));
  const profileRecords = $derived.by((): ProfileRecords | null => {
    const momentum = computeMomentum(allSessions ?? [], new Date());
    const superlatives = computeSuperlatives(allSessions ?? [], analyticsBooks, timelines);
    if (!superlatives) return null;
    return {
      momentum,
      superlatives: {
        biggestDay: superlatives.biggestDay,
        longestSession: superlatives.longestSession
          ? { minutes: superlatives.longestSession.minutes }
          : null,
        medianSessionMinutes: superlatives.medianSessionMinutes,
        fastestFinish: superlatives.fastestFinish
          ? {
              days: superlatives.fastestFinish.days,
              pageCount: superlatives.fastestFinish.pageCount,
            }
          : null,
      },
    };
  });

  // Books whose metadata cannot be filled in without a human: no ISBN, or
  // one that fails its check digit. The /isbns page repairs them.
  let isbnProblems = $derived(countIsbnProblems(allBooks ?? []));

  // The author catalog is shared, so its size is not a personal statistic:
  // count the authors this reader's own books reference. Ids no selectable
  // author row backs (dangling or retired) are left out, as on /authors.
  const referencedAuthors = $derived.by(() => {
    const selectable = new Set(selectableAuthors(authorList ?? []).map((author) => author.id));
    const referenced = new Set<string>();
    for (const book of analyticsBooks) {
      for (const id of book.authorIds) if (selectable.has(id)) referenced.add(id);
    }
    return referenced.size;
  });

  // User document (for the Toggl connection status)
  let userDoc = $state<UserDocument | null | undefined>(undefined);
  $effect(() => {
    if ($user) {
      const userStore = Database.getUser($user.uid);
      const unsubscribe = userStore.subscribe((data) => {
        userDoc = data;
      });
      return unsubscribe;
    }
  });

  let togglToken = $state('');
  let savingToken = $state(false);

  let clearingToken = $state(false);
  async function clearTogglToken() {
    clearingToken = true;
    try {
      await togglClearToken({});
    } catch (error) {
      alert(errorMessage(error));
    } finally {
      clearingToken = false;
    }
  }

  async function saveTogglToken() {
    savingToken = true;
    try {
      await togglSaveToken({ token: togglToken });
      togglToken = '';
    } catch (error) {
      alert(errorMessage(error));
    } finally {
      savingToken = false;
    }
  }

  // Statistics (shared with the public-profile payload, see utils/stats.ts)
  const stats = $derived(computeStats(analyticsBooks));
  const booksByYear = $derived(computeBooksByYear(analyticsBooks));

  // Extract username from email
  const username = $derived(($user?.email ?? '').split('@')[0]);

  // Public profile: undefined → loading, null → none enabled.
  let myProfile = $state<Profile | null | undefined>(undefined);
  $effect(() => {
    if ($user) {
      const profileStore = Database.getMyProfile($user.uid);
      const unsubscribe = profileStore.subscribe((data) => (myProfile = data));
      return unsubscribe;
    }
  });

  // Sharing is on by default; this owner-scoped document records an opt-out
  // and the reader's time zone. It stays outside profiles so the
  // full-document profile sync below cannot erase a newer choice made by
  // another client. An account with no document yet gets one, enabled,
  // carrying this browser's time zone so its reading days are bucketed
  // correctly; until then the backend uses UTC.
  let bookSharing = $state<BookSharingSettings | null | undefined>(undefined);
  let bookSharingSeeded = false;
  $effect(() => {
    const userId = $user?.uid;
    if (!userId) {
      bookSharing = undefined;
      return;
    }
    const sharingStore = Database.getBookSharingSettings(userId);
    return sharingStore.subscribe((data) => {
      bookSharing = data;
      if (data === null && !bookSharingSeeded) {
        bookSharingSeeded = true;
        void Database.setBookSharing({
          userId, enabled: true, timeZone: browserTimeZone(), existing: false,
        }).catch((error: unknown) => { profileError = errorMessage(error); });
      }
    });
  });
  const bookSharingOn = $derived(bookSharing === null || bookSharing?.enabled === true);

  function browserTimeZone(): string {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!timeZone) throw new Error('Your browser did not report a reading timezone.');
    return timeZone;
  }

  // Search discovery is a separate marker so old cached clients cannot
  // overwrite it during their full profile-stat sync. Only the owner reads
  // this document; public enumeration happens through the server sitemap.
  let profileDiscovery = $state<ProfileDiscovery | null | undefined>(undefined);
  $effect(() => {
    const profile = myProfile;
    if (!profile) {
      profileDiscovery = profile === null ? null : undefined;
      return;
    }
    profileDiscovery = undefined;
    const discoveryStore = Database.getProfileDiscovery(profile.username);
    return discoveryStore.subscribe((data) => (profileDiscovery = data));
  });
  const profileDiscoverable = $derived(profileDiscovery !== null && profileDiscovery !== undefined);

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
    const currentUser = $user;
    const books = analyticsBooks;
    if (
      currentUser === null || currentUser === undefined ||
      allBooks === undefined || allSessions === undefined || authorList === undefined
    ) {
      throw new Error('Profile saving requires an authenticated user and loaded library data.');
    }
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
          userId: currentUser.uid, username: chosenSlug, ...names, links: [],
          isPublic: false, ...buildProfilePayload(books, sessionDays, profileRecords),
        });
      } else if (chosenSlug === myProfile.username) {
        await Database.updateProfile({
          userId: currentUser.uid, username: chosenSlug, ...names,
          links: myProfile.links ?? [], isPublic: myProfile.public,
          ...buildProfilePayload(books, sessionDays, profileRecords),
        });
      } else {
        await Database.renameProfile({
          userId: currentUser.uid, oldUsername: myProfile.username, newUsername: chosenSlug,
          ...names, links: myProfile.links ?? [], isPublic: myProfile.public,
          isDiscoverable: profileDiscoverable,
          ...buildProfilePayload(books, sessionDays, profileRecords),
        });
      }
      profileGivenName = chosenGiven;
      profileFamilyName = chosenFamily;
      profileSlug = chosenSlug;
      profileSaved = true;
      setTimeout(() => (profileSaved = false), 2000);
    } catch (error) {
      // The rules turn "slug taken" into permission-denied (create on an
      // existing doc evaluates as an update of someone else's doc); a
      // reserved name lands there too. So does an unverified account —
      // publishing needs email_verified — which must not be reported as a
      // taken name.
      profileError = errorCode(error) !== 'permission-denied'
        ? errorMessage(error)
        : currentUser.emailVerified
          ? `"${chosenSlug}" is not available.`
          : 'Publishing a profile needs a verified email address. Use the link in the verification email (the banner at the top can send one), then try again.';
    } finally {
      savingProfile = false;
    }
  }

  async function deleteProfile() {
    const currentUser = $user;
    if (currentUser === null || currentUser === undefined || !myProfile) {
      throw new Error('Profile deletion requires an authenticated user and loaded profile.');
    }
    if (!confirm('Delete your public profile? Copies already cached can stay visible for up to 10 minutes, and search engines may take up to an hour to notice.')) return;
    savingProfile = true;
    profileError = '';
    try {
      await Database.deleteProfile({
        userId: currentUser.uid,
        username: myProfile.username,
      });
    } catch (error) {
      profileError = errorMessage(error);
    } finally {
      savingProfile = false;
    }
  }

  // Full-doc rewrite from the current profile plus fresh stats; overrides
  // carry the one field an immediate-write control (visibility checkbox,
  // handle add/remove) is changing.
  interface ProfileOverrides {
    isPublic?: boolean;
    links?: ProfileLink[];
    removeDiscovery?: boolean;
  }

  function persistProfile(overrides: ProfileOverrides = {}) {
    const currentUser = $user;
    const books = analyticsBooks;
    if (
      currentUser === null || currentUser === undefined || !myProfile ||
      allBooks === undefined || allSessions === undefined || authorList === undefined
    ) {
      throw new Error('Profile persistence requires an authenticated user, profile, and loaded library data.');
    }
    return Database.updateProfile({
      userId: currentUser.uid,
      username: myProfile.username,
      givenName: myProfile.givenName ?? '',
      familyName: myProfile.familyName ?? '',
      links: myProfile.links ?? [],
      isPublic: myProfile.public,
      ...buildProfilePayload(books, sessionDays, profileRecords),
      ...overrides,
    });
  }

  async function persistProfileWithFeedback(
    overrides: ProfileOverrides = {},
  ): Promise<boolean> {
    profileError = '';
    try {
      await persistProfile(overrides);
      return true;
    } catch (error) {
      profileError = errorMessage(error);
      return false;
    }
  }

  async function setProfileVisibility(input: HTMLInputElement) {
    const saved = await persistProfileWithFeedback({
      isPublic: input.checked,
      removeDiscovery: !input.checked,
    });
    if (!saved) input.checked = myProfile?.public ?? false;
  }

  async function setProfileDiscovery(input: HTMLInputElement) {
    const currentUser = $user;
    const profile = myProfile;
    if (currentUser === null || currentUser === undefined || !profile) {
      throw new Error('Search discovery requires an authenticated user and loaded profile.');
    }
    profileError = '';
    try {
      if (input.checked) {
        await Database.enableProfileDiscovery({
          userId: currentUser.uid,
          username: profile.username,
        });
      } else {
        await Database.disableProfileDiscovery({
          userId: currentUser.uid,
          username: profile.username,
        });
      }
    } catch (error) {
      profileError = errorMessage(error);
      input.checked = profileDiscoverable;
    }
  }

  let bookSharingPending = $state(false);

  async function setBookSharing(input: HTMLInputElement) {
    const currentUser = $user;
    if (currentUser === null || currentUser === undefined || bookSharing === undefined) {
      throw new Error('Book sharing requires an authenticated user and a loaded setting.');
    }
    bookSharingPending = true;
    sharingError = '';
    try {
      await Database.setBookSharing({
        userId: currentUser.uid,
        enabled: input.checked,
        timeZone: browserTimeZone(),
        existing: bookSharing !== null,
      });
    } catch (error) {
      sharingError = errorMessage(error);
      input.checked = bookSharingOn;
    } finally {
      bookSharingPending = false;
    }
  }
  let sharingError = $state('');

  // Handle editor: the plus opens the picker, choosing a platform reveals
  // the value field, Add writes immediately (like the visibility checkbox).
  let linkPickerOpen = $state(false);
  let newLinkType = $state<ProfileLinkType | ''>('');
  let newLinkLabel = $state('');
  let newLinkValue = $state('');
  let linkWrite = $state({ accepted: false });

  function openLinkPicker() {
    linkWrite.accepted = false;
    linkPickerOpen = true;
  }

  function closeLinkPicker() {
    linkPickerOpen = false;
    newLinkType = '';
    newLinkLabel = '';
    newLinkValue = '';
  }

  function addLink() {
    const value = newLinkValue.trim().slice(0, 200);
    if (!value || newLinkType === '') return;
    const link: ProfileLink = { type: newLinkType, value };
    if (newLinkType === 'other' && newLinkLabel.trim()) {
      link.label = newLinkLabel.trim().slice(0, 50);
    }
    if (!myProfile) throw new Error('A loaded profile is required to add a link.');
    const profile = myProfile;
    const links = [...profile.links, link];
    profileError = '';
    void acceptReportedWrite(
      linkWrite,
      () => Database.addProfileLink({
        userId: profile.uid,
        username: profile.username,
        link,
      }),
      () => {
        // arrayUnion preserves links added concurrently by another client.
        // Keep this optimistic copy too, so another offline link edit does
        // not wait for the local listener echo before building on this one.
        myProfile = { ...profile, links };
        closeLinkPicker();
      },
      (error) => {
        profileError = errorMessage(error);
      },
    );
  }

  async function removeLink(index: number) {
    if (!myProfile) throw new Error('A loaded profile is required to remove a link.');
    await persistProfileWithFeedback({ links: myProfile.links.filter((_, i) => i !== index) });
  }

  async function copyProfileLink() {
    await navigator.clipboard.writeText(profileUrl);
    linkCopied = true;
    setTimeout(() => (linkCopied = false), 2000);
  }

  function errorCode(error: unknown): string {
    return error instanceof FirebaseError ? error.code : '';
  }

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  // Keep the published doc in step with live stats: whenever this page
  // recomputes and the public copy differs, overwrite it. The equality
  // check excludes updatedAt, so the listener echo of our own write reads
  // as clean and the effect settles instead of looping.
  $effect(() => {
    if (!$user || !myProfile || allBooks === undefined || allSessions === undefined || authorList === undefined) return;
    const payload = buildProfilePayload(analyticsBooks, sessionDays, profileRecords);
    if (profilePayloadEqual(myProfile, payload)) return;
    void persistProfileWithFeedback();
  });
</script>

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
    .profile-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      margin-bottom: 0.4rem;

      h2 {
        margin: 0;
      }
    }

    .visibility-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.32rem 0.58rem;
      color: #4f5b56;
      font-size: 0.78rem;
      font-weight: 650;
      line-height: 1;
      background: #f1f3f2;
      border-radius: 999px;

      &::before {
        width: 7px;
        height: 7px;
        content: '';
        background: #8b9691;
        border-radius: 50%;
      }

      &.public {
        color: #176b42;
        background: #eaf7ef;

        &::before {
          background: #24925d;
        }
      }

      &.searchable {
        color: #1f5f78;
        background: #eaf5f9;

        &::before {
          background: #2d829f;
        }
      }
    }

    .profile-description {
      max-width: 720px;
      margin: 0 0 1.35rem;
      color: #666;
      font-size: 0.92rem;
      line-height: 1.5;
    }

    .profile-form {
      display: grid;
      grid-template-columns: 1fr 1fr minmax(180px, 1.2fr) auto;
      align-items: end;
      gap: 0.85rem;

      .field {
        display: flex;
        flex-direction: column;
        gap: 0.38rem;
        min-width: 0;
      }

      label {
        color: #555;
        font-size: 0.78rem;
        font-weight: 650;
      }

      input {
        width: 100%;
        min-width: 0;
      }
    }

    .primary-button,
    .secondary-button,
    .quiet-button,
    .danger-button {
      min-height: 40px;
      padding: 0.55rem 0.9rem;
      font-size: 0.88rem;
      font-weight: 650;
      line-height: 1.1;
      border-radius: 8px;
      box-shadow: none;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s, color 0.15s, box-shadow 0.15s;

      &:disabled {
        cursor: default;
        opacity: 0.5;
      }
    }

    .primary-button {
      color: #fff;
      background: #2f666b;
      border: 1px solid #2f666b;

      &:hover:not(:disabled) {
        background: #27575c;
        border-color: #27575c;
      }
    }

    .secondary-button,
    .quiet-button {
      color: #333;
      background: #fff;
      border: 1px solid #d8d8d8;

      &:hover:not(:disabled) {
        background: #f7f7f7;
        border-color: #bdbdbd;
      }
    }

    .quiet-button {
      border-color: transparent;
    }

    .danger-button {
      color: #a32d25;
      background: #fff;
      border: 1px solid #e2c3c0;

      &:hover:not(:disabled) {
        background: #fff4f3;
        border-color: #d69b96;
      }
    }

    .share-error {
      margin: 0.7rem 0 0;
      color: #b42318;
      font-size: 0.88rem;
    }

    .profile-url {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 1rem;
      margin-top: 1.15rem;
      padding: 0.75rem 0.75rem 0.75rem 0.9rem;
      background: #f7f8f8;
      border: 1px solid #e3e5e5;
      border-radius: 10px;

      .url-copy {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }

      .url-label {
        margin-bottom: 0.16rem;
        color: #6f6f6f;
        font-size: 0.74rem;
        font-weight: 650;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }

      a {
        overflow: hidden;
        color: #245e65;
        font-size: 0.88rem;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    }

    .links-section {
      margin-top: 1.5rem;
    }

    .links-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      margin-bottom: 0.65rem;

      h3 {
        margin: 0;
        color: #3d3d3d;
        font-size: 0.95rem;
        font-weight: 680;
      }
    }

    .links-empty {
      margin: 0;
      padding: 1rem;
      color: #6f6f6f;
      font-size: 0.88rem;
      text-align: center;
      background: #fafafa;
      border: 1px dashed #d8d8d8;
      border-radius: 10px;
    }

    .link-editor {
      display: grid;
      grid-template-columns: minmax(150px, 0.8fr) minmax(220px, 1.5fr) auto auto;
      align-items: end;
      gap: 0.75rem;
      margin-top: 0.75rem;
      padding: 0.9rem;
      background: #f8f9f9;
      border: 1px solid #e3e5e5;
      border-radius: 10px;

      .field {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
        min-width: 0;
      }

      label {
        color: #555;
        font-size: 0.76rem;
        font-weight: 650;
      }

      select,
      input {
        width: 100%;
        min-width: 0;
      }

      &.with-label {
        grid-template-columns: minmax(130px, 0.7fr) minmax(130px, 0.7fr) minmax(200px, 1.3fr) auto auto;
      }
    }

    .profile-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      margin-top: 1.5rem;
      padding-top: 1.15rem;
      border-top: 1px solid #ededed;
    }

    .visibility-controls {
      display: flex;
      flex-direction: column;
      gap: 0.9rem;
    }

    .visibility-control {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin: 0;
      cursor: pointer;

      .visibility-copy {
        display: flex;
        flex-direction: column;
      }

      .visibility-title {
        color: #333;
        font-size: 0.88rem;
        font-weight: 650;
      }

      .visibility-detail {
        margin-top: 0.08rem;
        color: #6f6f6f;
        font-size: 0.78rem;
      }

      input {
        position: relative;
        flex: 0 0 auto;
        width: 42px;
        height: 24px;
        margin: 0;
        appearance: none;
        background: #c9cecc;
        border-radius: 999px;
        cursor: pointer;
        transition: background 0.2s;

        &::before {
          position: absolute;
          top: 3px;
          left: 3px;
          width: 18px;
          height: 18px;
          content: '';
          background: #fff;
          border-radius: 50%;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.22);
          transition: transform 0.2s;
        }

        &:checked {
          background: #2e7d55;
        }

        &:checked::before {
          transform: translateX(18px);
        }

        &:focus-visible {
          outline: 3px solid rgba(31, 111, 120, 0.28);
          outline-offset: 2px;
        }

        &:disabled {
          cursor: default;
          opacity: 0.5;
        }
      }

      &:has(input:disabled) {
        cursor: default;
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

    .share-card {
      .profile-form,
      .link-editor,
      .link-editor.with-label {
        grid-template-columns: 1fr;
        align-items: stretch;
      }

      .profile-form .primary-button,
      .link-editor .primary-button,
      .link-editor .quiet-button {
        width: 100%;
      }

      .profile-footer {
        align-items: flex-start;
        flex-direction: column;
      }

      .danger-button {
        width: 100%;
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
  <div class="profile-container">
    <div class="profile-header">
      <h1>Welcome back, {myProfile?.givenName || username}!</h1>
      <p class="email">{$user.email}</p>
    </div>

    <div class="actions">
      <button onclick={handleSignOut}>Sign Out</button>
    </div>

    <details class="settings">
      <summary>Settings</summary>
      <div class="settings-body">
        <div class="toggl-card share-card">
          <div class="profile-heading">
            <h2>Profile</h2>
            {#if myProfile}
              <span
                class:public={myProfile.public && !profileDiscoverable}
                class:searchable={profileDiscoverable}
                class="visibility-badge">
                {profileDiscoverable ? 'Searchable' : myProfile.public ? 'Public' : 'Private'}
              </span>
            {/if}
          </div>
          {#if myProfile}
            {#if myProfile.public}
              <p class="profile-description">
                Anyone who visits the address can see your reading totals, day-by-day activity and reading records. Book titles stay private; the address is short and can be guessed.
              </p>
            {:else}
              <p class="profile-description">
                Only you can view this profile. Turn on public access below when you are ready to share it. Turning it off again takes up to 10 minutes to reach everyone, and up to an hour for search engines.
              </p>
            {/if}
          {:else if myProfile === null}
            <p class="profile-description">
              Add your name and choose the short address for your profile. New profiles start private.
            </p>
          {/if}
          <form
            class="profile-form"
            onsubmit={(event) => {
              event.preventDefault();
              saveProfile();
            }}>
            <div class="field">
              <label for="profile-given-name">First name</label>
              <input
                id="profile-given-name"
                type="text"
                class="form-control"
                maxlength="50"
                autocomplete="given-name"
                bind:value={profileGivenName} />
            </div>
            <div class="field">
              <label for="profile-family-name">Last name</label>
              <input
                id="profile-family-name"
                type="text"
                class="form-control"
                maxlength="50"
                autocomplete="family-name"
                bind:value={profileFamilyName} />
            </div>
            <div class="field">
              <label for="profile-slug">Profile address</label>
              <input
                id="profile-slug"
                type="text"
                class="form-control"
                placeholder="your-name"
                autocomplete="off"
                bind:value={profileSlug} />
            </div>
            <button class="primary-button" type="submit" disabled={savingProfile || !profileSlug || allBooks === undefined || allSessions === undefined || authorList === undefined || (myProfile !== null && profileDiscovery === undefined)}>
              {myProfile ? (profileSaved ? 'Saved!' : 'Save') : 'Create Profile'}
            </button>
          </form>
          {#if profileError}
            <p class="share-error">{profileError}</p>
          {/if}
          {#if myProfile}
            <div class="profile-url">
              <div class="url-copy">
                <span class="url-label">Public profile</span>
                <a href={profileUrl} target="_blank" rel="noopener">{profileUrl}</a>
              </div>
              <button class="secondary-button" type="button" onclick={copyProfileLink}>
                {linkCopied ? 'Copied' : 'Copy link'}
              </button>
            </div>

            <div class="links-section">
              <div class="links-heading">
                <h3>Links</h3>
                {#if !linkPickerOpen && (myProfile.links ?? []).length < MAX_PROFILE_LINKS}
                  <button class="secondary-button" type="button" disabled={authorList === undefined} onclick={openLinkPicker}>
                    Add link
                  </button>
                {/if}
              </div>

              {#if (myProfile.links ?? []).length > 0}
                <ProfileLinks links={myProfile.links} editable={authorList !== undefined} onremove={removeLink} />
              {:else}
                <p class="links-empty">No links added yet.</p>
              {/if}

              {#if linkPickerOpen}
                <div class:with-label={newLinkType === 'other'} class="link-editor">
                  <div class="field">
                    <label for="new-link-type">Service</label>
                    <select id="new-link-type" class="form-control" bind:value={newLinkType}>
                      <option value="" disabled>Choose a service</option>
                      {#each LINK_TYPES as linkType}
                        <option value={linkType.type}>{linkType.name}</option>
                      {/each}
                    </select>
                  </div>
                  {#if newLinkType === 'other'}
                    <div class="field">
                      <label for="new-link-label">Label</label>
                      <input
                        id="new-link-label"
                        type="text"
                        class="form-control"
                        placeholder="Blog"
                        maxlength="50"
                        bind:value={newLinkLabel} />
                    </div>
                  {/if}
                  <div class="field">
                    <label for="new-link-value">Link or handle</label>
                    <input
                      id="new-link-value"
                      type="text"
                      class="form-control"
                      placeholder={newLinkType ? 'Paste a URL or enter a handle' : 'Choose a service first'}
                      maxlength="200"
                      disabled={!newLinkType}
                      bind:value={newLinkValue} />
                  </div>
                  <button class="primary-button" type="button" onclick={addLink} disabled={linkWrite.accepted || authorList === undefined || !newLinkType || !newLinkValue.trim()}>
                    Add
                  </button>
                  <button class="quiet-button" type="button" onclick={closeLinkPicker}>Cancel</button>
                </div>
              {/if}
            </div>

            <div class="profile-footer">
              <div class="visibility-controls">
                <label class="visibility-control">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={myProfile.public}
                    disabled={authorList === undefined || profileDiscovery === undefined}
                    onchange={(event) => void setProfileVisibility(event.currentTarget)} />
                  <span class="visibility-copy">
                    <span class="visibility-title">Public profile</span>
                    <span class="visibility-detail">Anyone who visits the address can view your stats. Turning this off takes up to 10 minutes to reach everyone.</span>
                  </span>
                </label>
                <label class="visibility-control">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={profileDiscoverable}
                    disabled={!myProfile.public || profileDiscovery === undefined}
                    onchange={(event) => void setProfileDiscovery(event.currentTarget)} />
                  <span class="visibility-copy">
                    <span class="visibility-title">Appear in search engines</span>
                    <span class="visibility-detail">List this profile in the public sitemap and allow indexing.</span>
                  </span>
                </label>
              </div>
              <button class="danger-button" type="button" onclick={deleteProfile} disabled={savingProfile || profileDiscovery === undefined}>
                Delete profile
              </button>
            </div>
          {/if}
        </div>

        <div class="toggl-card">
          <h2>Sharing</h2>
          <label class="visibility-control">
            <input
              type="checkbox"
              role="switch"
              checked={bookSharingOn}
              disabled={bookSharing === undefined || bookSharingPending}
              onchange={(event) => void setBookSharing(event.currentTarget)} />
            <span class="visibility-copy">
              <span class="visibility-title">Share what you read</span>
              <span class="visibility-detail">Other signed-in readers see your reading of each shared book on its page. You are named only if your profile is public.</span>
            </span>
          </label>
          {#if sharingError}<p class="error" role="alert">{sharingError}</p>{/if}
        </div>

        <div class="toggl-card">
          <h2>Toggl Track</h2>
          {#if userDoc?.toggl}
            <p class="toggl-status connected">
              Connected. Timers log to your "Reading" project in Toggl, with the
              book's title as the entry description. Your token is stored on the
              server for that purpose.
            </p>
            <button type="button" disabled={clearingToken} onclick={clearTogglToken}>
              {clearingToken ? 'Disconnecting…' : 'Disconnect Toggl'}
            </button>
            <p class="toggl-status">
              Disconnecting deletes the stored copy; revoke the token in Toggl too. Stop any running timer first.
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

    <StatGrid>
      <StatCard label="Books Read" value={stats.finishedBooks} href="/finished"
        subtext={stats.firstFinishedAt && stats.lastFinishedAt ? formatDateRange(stats.firstFinishedAt, stats.lastFinishedAt) : 'Completed books'} />
      <StatCard label="Currently Reading" value={stats.readingBooks} subtext="In progress" href="/" />
      <StatCard label="Authors" value={authorList === undefined || allBooks === undefined ? '…' : referencedAuthors}
        subtext="Across your books" href="/authors" />
      <StatCard label="Needs an ISBN" value={allBooks === undefined ? '…' : isbnProblems}
        subtext="Missing or mistyped, so no cover or genre" href="/isbns" />
      <StatCard label="Total Time Read" value={`${stats.totalTimeReadHours} hrs`}
        subtext={`${stats.totalPagesRead.toLocaleString()} pages${stats.firstBookAddedAt ? ` since ${formatMonthYear(stats.firstBookAddedAt)}` : ' read'}`} />
      <StatCard label="Books Per Year" value={stats.booksPerYear}
        subtext={stats.firstFinishedAt ? formatDateRange(stats.firstFinishedAt, new Date()) : 'Average rate'} />
      <StatCard label="Avg. Time Per Book" value={formatTime(stats.avgTimePerBook)} subtext={`Across ${stats.finishedBooks} finished books`} />
      <StatCard label="Total Books" value={stats.totalBooks}
        subtext={stats.firstBookAddedAt ? `First added ${formatMonthYear(stats.firstBookAddedAt)}` : 'In your library'} />
    </StatGrid>

    <ReadingHeatmap days={sessionDays} />
    <SuperlativesRow sessions={allSessions ?? []} books={analyticsBooks} {timelines} />
    <SpeedSection sessions={allSessions ?? []} books={analyticsBooks} {months} />
    <ClockSection sessions={allSessions ?? []} />
    <CadenceSection {months} />
    <ProgressSection sessions={allSessions ?? []} books={analyticsBooks} {timelines} />
    <AuthorLeaderboardSection books={analyticsBooks} authors={selectableAuthors(authorList ?? [])} />

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
  </div>
{/if}
