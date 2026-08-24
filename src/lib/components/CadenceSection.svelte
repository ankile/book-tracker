<script>
  // Monthly cadence: pages read per calendar month over the whole history.
  // months is the page-level monthlyAggregates result, shared with the
  // speed section.
  import BarChart from './charts/BarChart.svelte';

  let { months = [] } = $props();

  const data = $derived(
    months.map((m) => ({
      // One label per January keeps ~70 bars readable.
      label: m.month.endsWith('-01') ? String(m.year) : '',
      value: m.pages,
      tooltip: [
        `${m.pages.toLocaleString()} pages`,
        m.label,
        `${Math.round(m.minutes / 60)} hrs · ${m.books} book${m.books === 1 ? '' : 's'}`,
      ].join('\n'),
    }))
  );
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

  /* Many thin bars: below tablet width the chart scrolls instead of
     shrinking bars to invisibility. */
  .chart-scroll {
    overflow-x: auto;
  }

  .chart-scroll > :global(.chart) {
    min-width: 640px;
  }

  @media (max-width: 768px) {
    .section {
      padding: 1.25rem;
    }
  }
</style>

{#if data.length >= 2}
  <div class="section">
    <h2>Monthly Cadence</h2>
    <p class="subtitle">Pages read per month since the beginning</p>
    <div class="chart-scroll">
      <BarChart
        {data}
        ariaLabel="Pages read per month" />
    </div>
  </div>
{/if}
