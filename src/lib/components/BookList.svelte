<script lang="ts">
  import Icon from "svelte-awesome";
  import { plus, edit, play, stop } from "svelte-awesome/icons";
  import AddReadingModal from "$lib/components/AddReadingModal.svelte";
  import UpdateCurrentModal from "$lib/components/UpdateCurrentModal.svelte";
  import NewBookModal from "$lib/components/NewBookModal.svelte";
  import ReadingSessionsModal from "$lib/components/ReadingSessionsModal.svelte";
  import { Database } from "../firebase/db.ts";
  import { togglClearStopping, togglStart, togglStop } from "../firebase/functions.ts";
  import { formatTime } from "../utils/format.ts";
  import { repairableBookAuthors, formatAuthors, joinAuthors } from "../utils/authors.ts";
  import { catalogWorkHref } from "../utils/catalogClient.ts";
  import { FirebaseError } from "firebase/app";
  import type { Author } from "../interfaces/author.ts";
  import type { Book } from "../interfaces/book.ts";
  import type { UserDocument } from "../firebase/decoders.ts";
  import type { NewQueueOperation } from "../firebase/decoders.ts";

  let {
    finished, userId, books: booksProp = null,
  }: { finished: boolean; userId: string; books?: Book[] | null } = $props();

  let screenWidth = $state(0);

  type ModalType = 'addReading' | 'updatePage' | 'editBook';
  let currentBook = $state<Book | null>(null);
  let modal = $state<ModalType | null>(null);
  const setModalBook = (book: Book, modalType: ModalType) => {
    currentBook = book;
    modal = modalType;
  };
  const closemodal = () => {
    currentBook = null;
    prefillMinutes = null;
  };

  // Use provided books prop if available, otherwise fetch from database.
  // The fetch lives in an $effect (not $derived) so the snapshot listener
  // is torn down when the component unmounts or userId/finished change.
  let fetchedBooks = $state<Book[]>([]);
  $effect(() => {
    if (booksProp !== null) return;
    const booksStore = Database.getBooks(userId, finished);
    const unsubscribe = booksStore.subscribe((data) => (fetchedBooks = data));
    return unsubscribe;
  });
  let books = $derived(booksProp ?? fetchedBooks);
  let sessionsBookId = $state<string | null>(null);
  let sessionsBook = $derived(
    sessionsBookId === null
      ? null
      : books.find((candidate) => candidate.id === sessionsBookId) ?? null,
  );
  const showSessions = (book: Book) => (sessionsBookId = book.id);
  const closeSessions = () => (sessionsBookId = null);

  // Books reference authors by id; resolve them against the shared author
  // catalog. undefined = still loading, during which authorIds books render
  // an empty author line for a frame rather than strict-looking-up into a
  // map that isn't there yet.
  let authorList = $state<Author[] | undefined>(undefined);
  $effect(() => {
    const authorsStore = Database.getAuthors();
    const unsubscribe = authorsStore.subscribe((data) => (authorList = data));
    return unsubscribe;
  });
  let authorMap = $derived(authorList === undefined ? null : new Map(authorList.map((a) => [a.id, a])));

  function hasEstimate(book: Book): boolean {
    return book.pagesRead !== 0 && book.timeRead !== 0;
  }

  function addReading(detail: { id: string; timeRead: number; currentPage: number; previousPage: number }) {
    if (currentBook === null) throw new Error('No book selected for the reading session.');
    Database.addReading({ userId, title: currentBook.title, pageCount: currentBook.pageCount, ...detail });
  }

  // Timer state; the running timer itself lives on the book doc
  // (activeTimer) so it syncs across devices via the books snapshot stream.
  // With a Toggl token connected the timer runs through Toggl; otherwise a
  // local timer is written directly to Firestore (no entryId).
  let prefillMinutes = $state<number | null>(null);
  let busy = $state(false);
  let now = $state(Date.now());
  let online = $state(true);

  $effect(() => {
    const updateOnline = () => (online = navigator.onLine);
    updateOnline();
    window.addEventListener('online', updateOnline);
    window.addEventListener('offline', updateOnline);
    return () => {
      window.removeEventListener('online', updateOnline);
      window.removeEventListener('offline', updateOnline);
    };
  });

  let userDoc = $state<UserDocument | null | undefined>(undefined);
  $effect(() => {
    if (finished) return; // timer UI never renders on the finished list
    const userStore = Database.getUser(userId);
    const unsubscribe = userStore.subscribe((data) => (userDoc = data));
    return unsubscribe;
  });
  let userLoaded = $derived(userDoc !== undefined);
  let hasToggl = $derived(!!userDoc?.toggl);

  $effect(() => {
    // Database reports the failure before rethrowing; observe it here so the
    // fire-and-forget recovery sweep never creates an unhandled rejection.
    if (hasToggl) void Database.retryStalledTogglSync(userId).catch(() => {});
  });

  let anyTimerRunning = $derived(books.some((b) => b.activeTimer));

  // Set synchronously when a fire-and-forget timer write is issued so a
  // double-tap in the IndexedDB round-trip window cannot start two timers
  // or enqueue twice. Cleared by the next books snapshot (normally the
  // local apply of that same write, within milliseconds); the timeout is a
  // backstop for writes that produce no snapshot (e.g. a no-op stop when
  // another device already cleared the timer) so it can never latch shut.
  let timerPending = $state(false);
  let timerPendingTimeout: ReturnType<typeof setTimeout> | undefined;
  function markTimerPending() {
    timerPending = true;
    if (timerPendingTimeout !== undefined) clearTimeout(timerPendingTimeout);
    timerPendingTimeout = setTimeout(() => (timerPending = false), 3000);
  }
  $effect(() => {
    books;
    timerPending = false;
  });

  $effect(() => {
    if (!anyTimerRunning) return;
    const interval = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(interval);
  });

  function formatElapsed(startIso: string): string {
    const totalSeconds = Math.max(0, Math.floor((now - Date.parse(startIso)) / 1000));
    return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
  }

  function startClaimIsStale(book: Book): boolean {
    const timer = book.activeTimer;
    return timer !== null &&
      'state' in timer &&
      timer.state === 'starting' &&
      timer.claimedAt.toMillis() < now - 5 * 60 * 1000;
  }

  async function startTimer(book: Book): Promise<void> {
    if (timerPending) return;
    // Offline with Toggl connected: run a local timer; the stop path
    // enqueues the finished interval for server-side Toggl sync.
    if (!hasToggl || !navigator.onLine) {
      // Not awaited: offline, the promise only resolves after reconnect, but
      // the local cache applies the write instantly via the books snapshot.
      // A flush-time rejection surfaces via the global error banner.
      markTimerPending();
      Database.startLocalTimer(userId, book.id, book.title);
      return;
    }
    busy = true;
    try {
      await togglStart({ bookId: book.id });
    } catch (error) {
      alert(errorMessage(error));
    } finally {
      busy = false;
    }
  }

  async function resolveStalledStart(book: Book): Promise<void> {
    if (!startClaimIsStale(book)) return;
    if (!hasToggl || !online) {
      alert('Reconnect to the configured Toggl account before resolving this start.');
      return;
    }
    busy = true;
    try {
      await togglStart({ bookId: book.id });
    } catch (error) {
      alert(errorMessage(error));
    } finally {
      busy = false;
    }
  }

  // Stop without the network. A fully local timer can clear immediately;
  // a remote Toggl timer enters an immutable stopping state until the queue
  // worker confirms its PUT, so another timer cannot start meanwhile.
  // 'stop' items patch an entry started online in Toggl with the recorded
  // stop time (instead of stopping it at reconnect time with an inflated
  // duration); 'create' items cover timers that ran entirely locally.
  function stopTimerViaQueue(book: Book): void {
    const timer = book.activeTimer;
    if (timer === null) throw new Error('Cannot stop a timer that is not running.');
    if ('state' in timer) throw new Error('Cannot stop a Toggl timer before its start outcome is resolved.');
    const stop = new Date().toISOString();
    const seconds = (Date.parse(stop) - Date.parse(timer.start)) / 1000;
    prefillMinutes = Math.max(1, Math.round(seconds / 60));
    markTimerPending();
    let entry: NewQueueOperation | null = null;
    if (timer.entryId !== undefined) {
      // start and bookTitle ride along so the sync function can build the
      // full PUT body without a Toggl read (the GET /me endpoints have a
      // strict 30/hour quota that a reconnect burst would blow through).
      entry = {
        type: 'stop',
        entryId: timer.entryId,
        bookTitle: book.title,
        start: timer.start,
        stop,
      };
    } else if (hasToggl && seconds >= 1) {
      entry = {
        type: 'create',
        bookTitle: book.title,
        start: timer.start,
        stop,
      };
    }
    // Not awaited: offline, the local cache applies the correlated writes
    // together and the promise resolves when the batch reaches the server.
    Database.stopTimerAndEnqueue(userId, book.id, book.title, entry, timer);
    setModalBook(book, 'addReading');
  }

  async function stopTimer(book: Book): Promise<void> {
    const timer = book.activeTimer;
    if (timer === null) throw new Error('Cannot stop a timer that is not running.');
    if ('state' in timer) throw new Error('Cannot stop a Toggl timer before its lifecycle transition is resolved.');
    if (timerPending) return;
    // No entryId means the timer is local, even if Toggl was connected later
    if (timer.entryId === undefined || !navigator.onLine) {
      stopTimerViaQueue(book);
      return;
    }
    busy = true;
    try {
      const { data } = await togglStop({ bookId: book.id });
      prefillMinutes = data.minutes;
      setModalBook(book, 'addReading');
    } catch (error) {
      if (['functions/unavailable', 'functions/internal', 'functions/deadline-exceeded'].includes(errorCode(error))) {
        // These codes mean the outcome is unknown (no route to the server,
        // a server-side throw, or the client-side deadline with the server
        // possibly still running). Falling back to the queue keeps the
        // timer from getting stuck and is replay-safe here ONLY because a
        // 'stop' item PUTs the same entryId — do not extend this list on
        // the 'create' path, where a replay would duplicate the entry.
        stopTimerViaQueue(book);
      } else {
        alert(errorMessage(error));
      }
    } finally {
      busy = false;
    }
  }

  function updateCurrentPage(detail: { id: string; currentPage: number; previousPage: number }) {
    if (currentBook === null) throw new Error('No book selected for the page update.');
    Database.addPageUpdate({ userId, title: currentBook.title, pageCount: currentBook.pageCount, ...detail });
  }

  function errorCode(error: unknown): string {
    return error instanceof FirebaseError ? error.code : '';
  }

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  function clearUnknownTimer(book: Book): void {
    const timer = book.activeTimer;
    if (timer === null || !('state' in timer) || timer.state !== 'outcome-unknown') {
      throw new Error('Only an unknown Toggl timer outcome can be cleared here.');
    }
    const confirmed = confirm(
      'Toggl may have created this timer. Check Toggl first and stop or delete it there if needed. Clear the local timer state now?',
    );
    if (confirmed) Database.stopLocalTimer(userId, book.id, book.title, timer);
  }

  async function clearStoppingTimer(book: Book): Promise<void> {
    const timer = book.activeTimer;
    if (timer === null || !('state' in timer) || timer.state !== 'stopping') {
      throw new Error('Only a queued Toggl stop can be cleared here.');
    }
    if (!navigator.onLine) {
      alert('Reconnect so the queued Toggl stop can finish.');
      return;
    }
    const confirmed = confirm(
      'Only clear this after checking Toggl and stopping or deleting the remote timer there. Clear the failed local stop and queue now?',
    );
    if (!confirmed) return;
    busy = true;
    try {
      await togglClearStopping({ bookId: book.id });
    } catch (error) {
      alert(errorMessage(error));
    } finally {
      busy = false;
    }
  }

</script>

<style lang="scss">
  .book-row {
    margin: 3em;
    padding: 2em;
    text-align: start;
    box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.2), 0 6px 20px 0 rgba(0, 0, 0, 0.19);
    border-radius: 5px;
  }

  .v-spacer {
    height: 10px;
  }

  .label {
    font-size: 0.9em;
    color: #666;
    text-transform: uppercase;
  }

  .author,
  .title,
  .page-number {
    font-size: 1.5em;
  }

  .author {
    color: #333;
  }

  .title {
    color: #555;
    font-style: italic;
  }

  .catalog-link {
    display: inline-block;
    margin-top: 0.35rem;
    color: #35686a;
    font-size: 0.82rem;
    font-style: normal;
    font-weight: 600;
    text-decoration: none;
  }

  .catalog-link:hover {
    text-decoration: underline;
  }

  .book-identity {
    display: flex;
    align-items: flex-start;
    gap: 1em;
  }

  .identity-text {
    min-width: 0;
  }

  .cover {
    flex: 0 0 auto;
    width: 56px;
    aspect-ratio: 2 / 3;
    object-fit: cover;
    border-radius: 3px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  }

  .cover-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    background: #e9e6e1;
    color: #b3aca3;
    font-size: 1.6em;
    font-weight: 600;
    user-select: none;
  }

  .text-right {
    text-align: end;
  }

  .action-button {
    appearance: none;
    background: none;
    border: 0;
    color: inherit;
    cursor: pointer;
    font: inherit;
    padding: 0;
    width: 100%;
  }

  .edit-book-button {
    margin-left: 0.5em;
    width: auto;
  }

  .add-reading-button {
    height: 100%;
    text-align: center;
  }

  .action-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75em;
  }

  .action-col .add-reading-button {
    height: auto;
  }

  .timer-button {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.15em;
    text-align: center;
  }

  .timer-button:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .elapsed {
    font-variant-numeric: tabular-nums;
    font-size: 0.9em;
    color: #555;
  }

  .page-number {
    color: #555;
  }

  .mobile-actions {
    display: flex;
    gap: 0.75em;
    margin-top: 1.75em;
  }

  .mobile-action-button {
    appearance: none;
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5em;
    min-height: 44px;
    padding: 0.5em 1em;
    border: 1px solid;
    border-radius: 999px;
    background: none;
    font: inherit;
    font-size: 0.95em;
    font-weight: 600;
    cursor: pointer;
    transition: transform 0.1s ease;
  }

  .mobile-action-button:active {
    transform: scale(0.97);
  }

  .mobile-action-button:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .mobile-action-button .mobile-elapsed {
    font-variant-numeric: tabular-nums;
    font-weight: 700;
  }

  .log-button {
    color: #35686a;
    border-color: rgba(53, 104, 106, 0.35);
    background: rgba(53, 104, 106, 0.07);
  }

  .start-button {
    color: #198754;
    border-color: rgba(25, 135, 84, 0.35);
    background: rgba(25, 135, 84, 0.07);
  }

  .stop-button {
    color: #dc3545;
    border-color: rgba(220, 53, 69, 0.35);
    background: rgba(220, 53, 69, 0.08);
  }

  .progress-container {
    position: relative;
    width: 100%;
    min-height: 2.5em;
    margin-top: 15px;
    margin-bottom: -1em;
  }

  .progress-container .progress {
    height: 2.5em !important;
    margin: 0;
    border-radius: 0.25rem;
  }

  .progress-text-black,
  .progress-text-white {
    position: absolute;
    top: 0.45em;
    left: 0;
    width: 100%;
    text-align: center;
    font-weight: bold;
    font-size: 1em;
    pointer-events: none;
    line-height: 1;
  }

  .progress-text-black {
    color: #333;
  }

  .progress-text-white {
    color: white;
  }

  @media only screen and (max-width: 770px) {
    .author,
    .title,
    .page-number {
      font-size: 1em;
    }

    .label {
      font-size: 0.62em;
      letter-spacing: 0.02em;
    }

    .book-row {
      margin: 1.5em 0.75em;
      padding: 1em;
    }

    .book-identity {
      gap: 0.75em;
    }

    .cover {
      width: 44px;
    }

    .cover-placeholder {
      font-size: 1.2em;
    }

    .text-right {
      margin: -0.2em;
    }

    @media only screen and (max-width: 370px) {
    }
  }
</style>

<svelte:window bind:innerWidth={screenWidth} />

{#if currentBook && modal === 'addReading'}
  <AddReadingModal
    book={currentBook}
    initialTime={prefillMinutes ?? undefined}
    onaddReading={addReading}
    oncloseModal={closemodal} />
{:else if currentBook && modal === 'updatePage'}
  <UpdateCurrentModal
    book={currentBook}
    onupdateCurrentPage={updateCurrentPage}
    oncloseModal={closemodal} />
{:else if currentBook && modal === 'editBook'}
  <NewBookModal
    open={true}
    {userId}
    book={currentBook}
    onclose={closemodal} />
{/if}

{#if sessionsBook}
  <ReadingSessionsModal
    book={sessionsBook}
    {userId}
    onclose={closeSessions} />
{/if}

{#snippet timerControl(book: Book, scale: number)}
  {#if book.activeTimer && 'state' in book.activeTimer && book.activeTimer.state === 'starting'}
    <button
      type="button"
      class="action-button timer-button"
      disabled={!startClaimIsStale(book) || busy || timerPending || !userLoaded || !hasToggl || !online}
      aria-label={startClaimIsStale(book) ? `Resolve the stalled Toggl start for ${book.title}` : `Starting the Toggl timer for ${book.title}`}
      onclick={() => resolveStalledStart(book)}>
      <Icon data={play} {scale} style="color: #666;" />
      <span class="elapsed">{startClaimIsStale(book) ? 'Resolve start' : 'Starting…'}</span>
    </button>
  {:else if book.activeTimer && 'state' in book.activeTimer && book.activeTimer.state === 'outcome-unknown'}
    <button
      type="button"
      class="action-button timer-button"
      aria-label={`Check Toggl, then clear the unresolved timer for ${book.title}`}
      onclick={() => clearUnknownTimer(book)}>
      <Icon data={stop} {scale} style="color: #dc3545;" />
      <span class="elapsed">Check Toggl</span>
    </button>
  {:else if book.activeTimer && 'state' in book.activeTimer && book.activeTimer.state === 'stopping'}
    <button
      type="button"
      class="action-button timer-button"
      disabled={busy || !online}
      aria-label={online ? `The Toggl stop for ${book.title} is syncing` : `The Toggl stop for ${book.title} is queued until reconnect`}
      onclick={() => clearStoppingTimer(book)}>
      <Icon data={stop} {scale} style="color: #666;" />
      <span class="elapsed">{online ? 'Stop queued — syncing' : 'Stop queued — reconnect'}</span>
    </button>
  {:else if book.activeTimer}
    <button
      type="button"
      class="action-button timer-button"
      disabled={busy || timerPending || !userLoaded}
      aria-label={`Stop the reading timer for ${book.title}`}
      onclick={() => stopTimer(book)}>
      <Icon data={stop} {scale} style="color: #dc3545;" />
      <span class="elapsed">{formatElapsed(book.activeTimer.start)}</span>
    </button>
  {:else}
    <button
      type="button"
      class="action-button timer-button"
      disabled={busy || timerPending || anyTimerRunning || !userLoaded}
      aria-label={`Start a reading timer for ${book.title}`}
      onclick={() => startTimer(book)}>
      <Icon data={play} {scale} style="color: #198754;" />
    </button>
  {/if}
{/snippet}

<div class="container">
  {#each books as book (book.id)}
    {@const progress = (book.currentPage / book.pageCount) * 100}
    {@const resolvedAuthors = repairableBookAuthors(book, authorMap)}
    {@const workHref = catalogWorkHref(book)}
    <div class="book-row">
      <div class="row">
        <div class="col">
          <div class="book-identity">
            <!-- Covers are hot-linked from Open Library (see migrate-enrich-books.ts).
                 The placeholder keeps the column width uniform for the books
                 without one, so the list's left edge never goes ragged. -->
            {#if book.coverUrl}
              <img class="cover" src={book.coverUrl} alt="" loading="lazy" referrerpolicy="no-referrer" />
            {:else}
              <div class="cover cover-placeholder" aria-hidden="true">{book.title.slice(0, 1)}</div>
            {/if}
            <div class="identity-text">
              <span class="label">Book Title</span>
              <button
                type="button"
                class="action-button edit-book-button"
                aria-label={`Edit ${book.title}`}
                onclick={() => setModalBook(book, 'editBook')}>
                <Icon data={edit} scale={0.8} style="color: #666;" />
              </button>
              <br />
              <span class="author" title={resolvedAuthors ? joinAuthors(resolvedAuthors.map((a) => a.name)) : ''}>{resolvedAuthors ? formatAuthors(resolvedAuthors) : ''}:</span>
              <br />
              <span class="title">{book.title}</span>
              {#if workHref}
                <br />
                <a class="catalog-link" href={workHref}>Linked work</a>
              {/if}
            </div>
          </div>
        </div>
        <div class="col-md-6">
          <div class="row">
            <div class="col">
              <button
                type="button"
                class="action-button text-right"
                aria-label={`Update current page for ${book.title}`}
                onclick={() => setModalBook(book, 'updatePage')}>
                <span class="label">Page</span>
                <br />
                <span class="page-number">
                  {book.currentPage}/{book.pageCount}
                </span>
              </button>
            </div>
            <div class="col">
              <button
                type="button"
                class="action-button text-right clickable"
                aria-label={`View reading sessions for ${book.title}`}
                onclick={() => showSessions(book)}>
                <span class="label">Time read</span>
                <br />
                <span class="page-number">
                  {#if hasEstimate(book)}
                    {formatTime(book.timeRead)}
                  {:else}NA{/if}
                </span>
              </button>
            </div>

            <div class="col">
              <div class="text-right">
                <span class="label">{finished ? 'Finished' : 'Est left'}</span>
                <br />
                <span class="page-number">
                  {#if finished && book.updatedAt}
                    {book.updatedAt.toDate().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  {:else if hasEstimate(book)}
                    {formatTime(Math.round((book.pageCount - book.currentPage) * (book.timeRead / book.pagesRead)))}
                  {:else}NA{/if}
                </span>
              </div>
            </div>
            <div class="col">
              <div class="text-right">
                <span class="label">Min/Page</span>
                <br />
                <span class="page-number">
                  {#if hasEstimate(book)}
                    {Math.round((book.timeRead / book.pagesRead) * 100) / 100}
                  {:else}NA{/if}
                </span>
              </div>
            </div>
          </div>
        </div>
        {#if !finished && screenWidth > 770}
          <div class="col-md-1 action-col">
            <button
              type="button"
              class="action-button add-reading-button"
              aria-label={`Add a reading session for ${book.title}`}
              onclick={() => setModalBook(book, 'addReading')}>
              <Icon
                data={plus}
                scale={1.7}
                style="margin: auto; position: relative; cursor: pointer;" />
            </button>
            {@render timerControl(book, 1.4)}
          </div>
        {/if}
      </div>
      <div class="v-spacer"></div>
      <div class="row">
        <div class="col">
          <div class="progress-container">
            <div
              class="progress"
              role="progressbar"
              aria-label={`Reading progress for ${book.title}`}
              aria-valuenow={Math.round(progress)}
              aria-valuemin={0}
              aria-valuemax={100}>
              <div
                class="progress-bar text-bg-danger"
                style={`width: ${progress}%`}>
              </div>
            </div>
            <div class="progress-text-black" aria-hidden="true">
              {Math.round(progress)}%
            </div>
            <div
              class="progress-text-white"
              aria-hidden="true"
              style={`clip-path: inset(0 ${100 - progress}% 0 0)`}>
              {Math.round(progress)}%
            </div>
          </div>
        </div>
      </div>
      {#if !finished && screenWidth <= 770}
        <div class="mobile-actions">
          <button
            type="button"
            class="mobile-action-button log-button"
            aria-label={`Add a reading session for ${book.title}`}
            onclick={() => setModalBook(book, 'addReading')}>
            <Icon data={plus} scale={0.9} />
            <span>Log reading</span>
          </button>
          {#if book.activeTimer && 'state' in book.activeTimer && book.activeTimer.state === 'starting'}
            <button
              type="button"
              class="mobile-action-button start-button"
              disabled={!startClaimIsStale(book) || busy || timerPending || !userLoaded || !hasToggl || !online}
              onclick={() => resolveStalledStart(book)}>
              <Icon data={play} scale={0.9} />
              <span>{startClaimIsStale(book) ? 'Resolve Toggl start' : 'Starting Toggl…'}</span>
            </button>
          {:else if book.activeTimer && 'state' in book.activeTimer && book.activeTimer.state === 'outcome-unknown'}
            <button
              type="button"
              class="mobile-action-button stop-button"
              onclick={() => clearUnknownTimer(book)}>
              <Icon data={stop} scale={0.9} />
              <span>Check Toggl, then clear</span>
            </button>
          {:else if book.activeTimer && 'state' in book.activeTimer && book.activeTimer.state === 'stopping'}
            <button
              type="button"
              class="mobile-action-button stop-button"
              disabled={busy || !online}
              aria-label={online ? `The Toggl stop for ${book.title} is syncing` : `The Toggl stop for ${book.title} is queued until reconnect`}
              onclick={() => clearStoppingTimer(book)}>
              <Icon data={stop} scale={0.9} />
              <span>{online ? 'Stop queued — syncing' : 'Stop queued — reconnect'}</span>
            </button>
          {:else if book.activeTimer}
            <button
              type="button"
              class="mobile-action-button stop-button"
              disabled={busy || timerPending || !userLoaded}
              aria-label={`Stop the reading timer for ${book.title}`}
              onclick={() => stopTimer(book)}>
              <Icon data={stop} scale={0.9} />
              <span>Stop</span>
              <span class="mobile-elapsed">{formatElapsed(book.activeTimer.start)}</span>
            </button>
          {:else}
            <button
              type="button"
              class="mobile-action-button start-button"
              disabled={busy || timerPending || anyTimerRunning || !userLoaded}
              aria-label={`Start a reading timer for ${book.title}`}
              onclick={() => startTimer(book)}>
              <Icon data={play} scale={0.9} />
              <span>Start timer</span>
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {/each}
</div>
