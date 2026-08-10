<script>
  import Icon from "svelte-awesome";
  import { edit, trash } from "svelte-awesome/icons";
  import ModalCard from "$lib/components/ModalCard.svelte";
  import EditSessionModal from "$lib/components/EditSessionModal.svelte";
  import { Database } from "$lib/firebase/db.js";
  import { formatTime } from "$lib/utils/format.js";

  let { book, userId, onclose } = $props();

  let open = $derived(!!book);

  let sessions = $state([]);
  $effect(() => {
    if (book && userId) {
      const sessionsStore = Database.getReadingSessions(userId, book.id);
      const unsubscribeStore = sessionsStore.subscribe((data) => {
        sessions = data;
      });
      return () => {
        unsubscribeStore();
        sessionsStore.unsubscribe();
      };
    }
  });

  let editingSessionId = $state(null);

  // Derive the actual session object from the ID to always use fresh data
  let editingSession = $derived(
    editingSessionId ? sessions.find(s => s.id === editingSessionId) : null
  );

  function formatDate(timestamp) {
    if (!timestamp?.toDate) return 'N/A';
    const date = timestamp.toDate();
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function editSession(session) {
    editingSessionId = session.id;
  }

  function updateSession(data) {
    Database.updateReadingSession({
      userId,
      bookId: book.id,
      title: book.title,
      pageCount: book.pageCount,
      ...data
    });
  }

  function closeEditModal() {
    editingSessionId = null;
  }

  function deleteSession(session) {
    const confirmed = confirm("Are you sure you want to delete this reading session? This will update your book's progress accordingly.");
    if (confirmed) {
      Database.deleteReadingSession(userId, book.id, session.id, book.title, book.pageCount);
    }
  }
</script>

<style lang="scss">
  .sessions-container {
    max-height: 500px;
    overflow-y: auto;
  }

  .session {
    padding: 1rem;
    border-bottom: 1px solid #e0e0e0;

    &:last-child {
      border-bottom: none;
    }

    &:hover {
      background-color: #f9f9f9;
    }
  }

  .session-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 0.5rem;
  }

  .session-date {
    font-size: 0.9rem;
    color: #666;
    font-weight: 600;
  }

  .session-time-container {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .session-time {
    font-size: 1.1rem;
    color: #333;
    font-weight: 700;
  }

  .edit-button {
    appearance: none;
    background: none;
    border: 0;
    cursor: pointer;
    opacity: 0;
    padding: 0;
    transition: opacity 0.2s;
    display: inline-block;
    width: 20px;
  }

  .session:hover .edit-button,
  .edit-button:focus-visible {
    opacity: 1;
  }

  // Touch devices have no hover, so the buttons must always be visible there.
  @media (hover: none) {
    .edit-button {
      opacity: 1;
      padding: 0.35em;
      width: 28px;
    }

    .button-spacer {
      width: 28px;
    }
  }

  .button-spacer {
    display: inline-block;
    width: 20px;
  }

  .session-details {
    display: flex;
    gap: 1.5rem;
    font-size: 0.9rem;
    color: #666;
  }

  .detail {
    display: flex;
    gap: 0.25rem;
  }

  .detail-label {
    font-weight: 600;
  }

  .empty-state {
    text-align: center;
    padding: 2rem;
    color: #999;
    font-style: italic;
  }
</style>

<ModalCard
  open={open && !editingSession}
  onclose={() => onclose()}
  header={book ? `Reading Sessions - ${book.title}` : 'Reading Sessions'}
  primaryAction={() => onclose()}
  primaryText="Close"
  hideSecondary={true}>
  <div class="sessions-container">
    {#if sessions.length === 0}
      <div class="empty-state">No reading sessions recorded yet.</div>
    {:else}
      {#each sessions as session, index (session.id)}
        <div class="session">
          <div class="session-header">
            <span class="session-date">{formatDate(session.createdAt)}</span>
            <div class="session-time-container">
              {#if index === 0}
                <button
                  type="button"
                  class="edit-button"
                  aria-label={`Edit latest reading session for ${book.title}`}
                  onclick={() => editSession(session)}>
                  <Icon data={edit} scale="0.8" style="color: #666;" />
                </button>
                <button
                  type="button"
                  class="edit-button"
                  aria-label={`Delete latest reading session for ${book.title}`}
                  onclick={() => deleteSession(session)}>
                  <Icon data={trash} scale="0.8" style="color: #d9534f;" />
                </button>
              {:else}
                <span class="button-spacer"></span>
                <span class="button-spacer"></span>
              {/if}
              <span class="session-time">{formatTime(session.timeRead)}</span>
            </div>
          </div>
          <div class="session-details">
            <div class="detail">
              <span class="detail-label">Pages:</span>
              <span>{session.fromPage} → {session.toPage}</span>
            </div>
            <div class="detail">
              <span class="detail-label">Read:</span>
              <span>{session.pagesRead} pages</span>
            </div>
          </div>
        </div>
      {/each}
    {/if}
  </div>
</ModalCard>

{#if editingSession}
  <EditSessionModal
    session={editingSession}
    {book}
    onupdateSession={updateSession}
    oncloseModal={closeEditModal} />
{/if}
