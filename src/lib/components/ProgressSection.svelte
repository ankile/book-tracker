<script>
  // In-progress books: projected finish dates for the active ones, the
  // dusty shelf for the stalled ones, and the finish-habit summary line.
  import {
    buildBookTimelines,
    projectedFinishes,
    dustyShelf,
    daysToFinishSummary,
    completionRate,
  } from '$lib/utils/sessions.js';

  let { sessions = [], books = [] } = $props();

  const now = $derived.by(() => {
    // Recomputed whenever the listeners tick; good enough for day math.
    void sessions;
    return new Date();
  });
  const timelines = $derived(buildBookTimelines(sessions));
  const projections = $derived(projectedFinishes(books, timelines, sessions, now));
  const active = $derived(projections.filter((p) => p.projectedDate !== null).slice(0, 8));
  const dusty = $derived(dustyShelf(books, timelines, now).filter((b) => (b.daysSince ?? 0) > 60).slice(0, 5));
  const finishSummary = $derived(daysToFinishSummary(books, timelines));
  const rate = $derived(completionRate(books, timelines));

  const formatProjection = (date) =>
    date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
    });

  const formatAgo = (days) => {
    if (days < 30) return `${days} days ago`;
    if (days < 365) return `${Math.round(days / 30)} months ago`;
    return `${(days / 365).toFixed(1)} years ago`;
  };
</script>

<style>
  .section {
    background: white;
    padding: 2rem;
    border-radius: 5px;
    box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.2), 0 6px 20px 0 rgba(0, 0, 0, 0.19);
    margin-bottom: 2rem;
  }

  h2 {
    font-size: 1.5rem;
    color: #333;
    margin: 0 0 0.25rem 0;
  }

  .summary {
    font-size: 0.9rem;
    color: #666;
    margin: 0 0 1.25rem 0;
  }

  .columns {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2rem;
  }

  h3 {
    font-size: 1rem;
    color: #333;
    margin: 0 0 0.5rem 0;
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 1rem;
    padding: 0.35rem 0;
    border-bottom: 1px solid #f0f0f0;
    font-size: 0.95rem;
  }

  li:last-child {
    border-bottom: none;
  }

  .book-title {
    font-style: italic;
    color: #555;
    min-width: 0;
  }

  .book-detail {
    color: #999;
    font-size: 0.85rem;
    white-space: nowrap;
  }

  .empty {
    color: #999;
    font-size: 0.9rem;
  }

  @media (max-width: 768px) {
    .section {
      padding: 1.25rem;
    }

    .columns {
      grid-template-columns: 1fr;
      gap: 1.25rem;
    }
  }
</style>

{#if books.some((book) => !book.finished)}
  <div class="section">
    <h2>In Progress</h2>
    {#if finishSummary}
      <p class="summary">
        You finish a book in a median of {finishSummary.medianDays} days, reading on
        {finishSummary.medianActiveDays} of them{rate !== null
          ? ` — and finish ${Math.round(rate * 100)}% of the books you start`
          : ''}.
      </p>
    {/if}
    <div class="columns">
      <div>
        <h3>On deck</h3>
        {#if active.length > 0}
          <ul>
            {#each active as book}
              <li>
                <span class="book-title">{book.title}</span>
                <span class="book-detail">
                  {book.percentComplete}% · ~{formatProjection(book.projectedDate)}
                </span>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="empty">No recent activity to project from.</p>
        {/if}
      </div>
      <div>
        <h3>Dusty shelf</h3>
        {#if dusty.length > 0}
          <ul>
            {#each dusty as book}
              <li>
                <span class="book-title">{book.title}</span>
                <span class="book-detail">
                  {book.percentComplete}% · {book.daysSince === null ? 'never touched' : formatAgo(book.daysSince)}
                </span>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="empty">Nothing gathering dust — every open book has recent activity.</p>
        {/if}
      </div>
    </div>
  </div>
{/if}
