<script>
  import Icon from "svelte-awesome";
  import { plus, edit, play, stop } from "svelte-awesome/icons";
  import AddReadingModal from "$lib/components/AddReadingModal.svelte";
  import UpdateCurrentModal from "$lib/components/UpdateCurrentModal.svelte";
  import NewBookModal from "$lib/components/NewBookModal.svelte";
  import ReadingSessionsModal from "$lib/components/ReadingSessionsModal.svelte";
  import { Database } from "../firebase/db";
  import { togglStart, togglStop } from "../firebase/functions.js";
  import { formatTime } from "../utils/format";

  let { finished, userId, books: booksProp = null } = $props();

  let screenWidth = $state();

  let currentBook = $state(null);
  let modal = $state(null);
  const setModalBook = (book, modalType) => {
    currentBook = book;
    modal = modalType;
  };
  const closemodal = () => {
    currentBook = null;
    prefillMinutes = null;
  };

  let sessionsBook = $state(null);
  const showSessions = (book) => (sessionsBook = book);
  const closeSessions = () => (sessionsBook = null);

  // Use provided books prop if available, otherwise fetch from database
  let books = $derived(booksProp !== null ? { subscribe: (fn) => { fn(booksProp); return () => {}; } } : Database.getBooks(userId, finished));

  function hasEstimate(book) {
    return book.pagesRead !== 0 && book.timeRead !== 0;
  }

  function addReading(detail) {
    Database.addReading({ userId, ...detail });
  }

  // Timer state; the running timer itself lives on the book doc
  // (activeTimer) so it syncs across devices via the books snapshot stream.
  // With a Toggl token connected the timer runs through Toggl; otherwise a
  // local timer is written directly to Firestore (no entryId).
  let prefillMinutes = $state(null);
  let busy = $state(false);
  let now = $state(Date.now());

  let userDoc = $state(undefined);
  $effect(() => {
    if (finished) return; // timer UI never renders on the finished list
    const userStore = Database.getUser(userId);
    const unsubscribe = userStore.subscribe((data) => (userDoc = data));
    return () => {
      unsubscribe();
      userStore.unsubscribe();
    };
  });
  let userLoaded = $derived(userDoc !== undefined);
  let hasToggl = $derived(!!userDoc?.toggl);

  let anyTimerRunning = $derived($books.some((b) => b.activeTimer));

  $effect(() => {
    if (!anyTimerRunning) return;
    const interval = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(interval);
  });

  function formatElapsed(startIso) {
    const totalSeconds = Math.max(0, Math.floor((now - Date.parse(startIso)) / 1000));
    return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
  }

  async function startTimer(book) {
    if (!hasToggl) {
      // Not awaited: offline, the promise only resolves after reconnect, but
      // the local cache applies the write instantly via the books snapshot.
      Database.startLocalTimer(userId, book.id);
      return;
    }
    busy = true;
    try {
      await togglStart({ bookId: book.id });
    } catch (error) {
      alert(error.message);
    } finally {
      busy = false;
    }
  }

  async function stopTimer(book) {
    // No entryId means the timer is local, even if Toggl was connected later
    if (!book.activeTimer.entryId) {
      const seconds = (Date.now() - Date.parse(book.activeTimer.start)) / 1000;
      prefillMinutes = Math.max(1, Math.round(seconds / 60));
      // Not awaited, same as startTimer: must not hang offline.
      Database.stopLocalTimer(userId, book.id);
      setModalBook(book, 'addReading');
      return;
    }
    busy = true;
    try {
      const { data } = await togglStop({ bookId: book.id });
      prefillMinutes = data.minutes;
      setModalBook(book, 'addReading');
    } catch (error) {
      alert(error.message);
    } finally {
      busy = false;
    }
  }

  function updateCurrentPage(detail) {
    Database.addPageUpdate({ userId, ...detail });
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

{#snippet timerControl(book, scale)}
  {#if book.activeTimer}
    <button
      type="button"
      class="action-button timer-button"
      disabled={busy}
      aria-label={`Stop the reading timer for ${book.title}`}
      onclick={() => stopTimer(book)}>
      <Icon data={stop} {scale} style="color: #dc3545;" />
      <span class="elapsed">{formatElapsed(book.activeTimer.start)}</span>
    </button>
  {:else}
    <button
      type="button"
      class="action-button timer-button"
      disabled={busy || anyTimerRunning || !userLoaded}
      aria-label={`Start a reading timer for ${book.title}`}
      onclick={() => startTimer(book)}>
      <Icon data={play} {scale} style="color: #198754;" />
    </button>
  {/if}
{/snippet}

<div class="container">
  {#each $books as book (book.id)}
    {@const progress = (book.currentPage / book.pageCount) * 100}
    <div class="book-row">
      <div class="row">
        <div class="col">
          <span class="label">Book Title</span>
          <button
            type="button"
            class="action-button edit-book-button"
            aria-label={`Edit ${book.title}`}
            onclick={() => setModalBook(book, 'editBook')}>
            <Icon data={edit} scale="0.8" style="color: #666;" />
          </button>
          <br />
          <span class="author">{book.author}:</span>
          <br />
          <span class="title">{book.title}</span>
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
                scale="1.7"
                style="margin: auto; position: relative; cursor: pointer;" />
            </button>
            {@render timerControl(book, '1.4')}
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
              aria-valuemin="0"
              aria-valuemax="100">
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
            <Icon data={plus} scale="0.9" />
            <span>Log reading</span>
          </button>
          {#if book.activeTimer}
            <button
              type="button"
              class="mobile-action-button stop-button"
              disabled={busy}
              aria-label={`Stop the reading timer for ${book.title}`}
              onclick={() => stopTimer(book)}>
              <Icon data={stop} scale="0.9" />
              <span>Stop</span>
              <span class="mobile-elapsed">{formatElapsed(book.activeTimer.start)}</span>
            </button>
          {:else}
            <button
              type="button"
              class="mobile-action-button start-button"
              disabled={busy || anyTimerRunning || !userLoaded}
              aria-label={`Start a reading timer for ${book.title}`}
              onclick={() => startTimer(book)}>
              <Icon data={play} scale="0.9" />
              <span>Start timer</span>
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {/each}
</div>
