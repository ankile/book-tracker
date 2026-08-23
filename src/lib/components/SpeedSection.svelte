<script>
  // Reading speed: the monthly pages/hour trend against the lifetime
  // average, plus the fastest and slowest finished books by their own
  // aggregate pace.
  import LineChart from './charts/LineChart.svelte';
  import {
    monthlyAggregates,
    lifetimePagesPerHour,
    BOOK_SPEED_MIN_MINUTES,
  } from '$lib/utils/sessions.js';

  let { sessions = [], books = [] } = $props();

  const months = $derived(monthlyAggregates(sessions));
  const lifetime = $derived(lifetimePagesPerHour(sessions));

  const points = $derived(
    months.map((m) => ({
      label: m.label,
      value: m.pagesPerHour,
      tooltip:
        m.pagesPerHour === null
          ? `${m.label}\nNot enough timed reading`
          : `${Math.round(m.pagesPerHour)} pages/hr\n${m.label}\n${m.pages.toLocaleString()} pages · ${Math.round(m.minutes / 60)} hrs`,
    }))
  );

  // Sparse x-axis: one label per January; the first month too when the
  // range is short enough that no January would otherwise appear early.
  const xLabels = $derived.by(() => {
    const labels = months
      .map((m, index) => ({ index, text: String(m.year) }))
      .filter(({ index }) => months[index].month.endsWith('-01'));
    if (labels.length === 0 && months.length > 0) {
      return [{ index: 0, text: months[0].label }];
    }
    return labels;
  });

  const pacedBooks = $derived(
    books
      .filter((b) => b.finished && (b.timeRead || 0) >= BOOK_SPEED_MIN_MINUTES && (b.pagesRead || 0) > 0)
      .map((b) => ({
        title: b.title,
        pagesPerHour: (b.pagesRead || 0) / ((b.timeRead || 0) / 60),
        hours: Math.round((b.timeRead || 0) / 60),
      }))
  );
  const fastest = $derived([...pacedBooks].sort((a, b) => b.pagesPerHour - a.pagesPerHour).slice(0, 5));
  const slowest = $derived([...pacedBooks].sort((a, b) => a.pagesPerHour - b.pagesPerHour).slice(0, 5));
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

  .subtitle {
    font-size: 0.85rem;
    color: #999;
    margin: 0 0 1rem 0;
  }

  .book-lists {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2rem;
    margin-top: 2rem;
  }

  h3 {
    font-size: 1rem;
    color: #333;
    margin: 0 0 0.5rem 0;
  }

  ol {
    margin: 0;
    padding-left: 1.25rem;
  }

  li {
    padding: 0.25rem 0;
    color: #333;
    font-size: 0.95rem;
  }

  .book-title {
    font-style: italic;
    color: #555;
  }

  .book-pace {
    color: #999;
    font-size: 0.85rem;
    white-space: nowrap;
  }

  @media (max-width: 768px) {
    .section {
      padding: 1.25rem;
    }

    .book-lists {
      grid-template-columns: 1fr;
      gap: 1.25rem;
    }
  }
</style>

{#if points.length >= 2}
  <div class="section">
    <h2>Reading Speed</h2>
    <p class="subtitle">Pages per hour by month, across all timed sessions</p>
    <LineChart
      {points}
      referenceValue={lifetime}
      referenceLabel={lifetime === null ? '' : `avg ${Math.round(lifetime)}`}
      formatTick={(v) => `${Math.round(v)}`}
      ariaLabel="Reading speed in pages per hour by month"
      {xLabels} />

    {#if fastest.length > 0}
      <div class="book-lists">
        <div>
          <h3>Fastest reads</h3>
          <ol>
            {#each fastest as book}
              <li>
                <span class="book-title">{book.title}</span>
                <span class="book-pace">
                  — {Math.round(book.pagesPerHour)} pages/hr · {book.hours} hrs
                </span>
              </li>
            {/each}
          </ol>
        </div>
        <div>
          <h3>Slowest burns</h3>
          <ol>
            {#each slowest as book}
              <li>
                <span class="book-title">{book.title}</span>
                <span class="book-pace">
                  — {Math.round(book.pagesPerHour)} pages/hr · {book.hours} hrs
                </span>
              </li>
            {/each}
          </ol>
        </div>
      </div>
    {/if}
  </div>
{/if}
