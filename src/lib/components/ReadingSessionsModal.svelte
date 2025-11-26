<script>
  import ModalCard from "$lib/components/ModalCard.svelte";
  import { Database } from "$lib/firebase/db.js";
  import { formatTime } from "$lib/utils/format.js";

  let { book, userId, onclose } = $props();

  let open = $derived(!!book);

  let sessions = $state([]);
  $effect(() => {
    if (book && userId) {
      const sessionsStore = Database.getReadingSessions(userId, book.id);
      return sessionsStore.subscribe((data) => {
        sessions = data;
      });
    }
  });

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

  .session-time {
    font-size: 1.1rem;
    color: #333;
    font-weight: 700;
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
  {open}
  onclose={() => onclose()}
  header={book ? `Reading Sessions - ${book.title}` : 'Reading Sessions'}
  primaryAction={() => onclose()}
  primaryText="Close"
  hideSecondary={true}>
  <div class="sessions-container">
    {#if sessions.length === 0}
      <div class="empty-state">No reading sessions recorded yet.</div>
    {:else}
      {#each sessions as session (session.id)}
        <div class="session">
          <div class="session-header">
            <span class="session-date">{formatDate(session.createdAt)}</span>
            <span class="session-time">{formatTime(session.timeRead)}</span>
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
