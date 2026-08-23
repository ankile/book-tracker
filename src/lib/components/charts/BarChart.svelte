<script>
  // Single-series column chart. Hand-rolled (no chart library — bundle
  // budget) from positioned divs: each column is a full-height button so
  // the hit target is the whole band, not the painted bar, and keyboard
  // focus gets the same tooltip as hover.
  //
  // data: [{ label, value, tooltip }] — label may be '' for sparse axes
  // (24 hours, 68 months); tooltip is the full readout for that bar.
  let {
    data = [],
    plotHeight = 140,
    formatTick = (value) => value.toLocaleString(),
    ariaLabel,
  } = $props();

  let tooltipVisible = $state(false);
  let tooltipContent = $state('');
  let tooltipX = $state(0);
  let tooltipY = $state(0);

  // Round the axis top up to a clean step so ticks land on friendly
  // numbers without leaving half the plot empty.
  const niceMax = $derived.by(() => {
    const max = Math.max(...data.map((d) => d.value), 0);
    if (max === 0) return 1;
    const magnitude = 10 ** Math.floor(Math.log10(max));
    const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => s * magnitude >= max);
    return step * magnitude;
  });
  const ticks = $derived([0.5, 1].map((f) => f * niceMax));
  const maxIndex = $derived.by(() => {
    let best = -1;
    data.forEach((d, i) => {
      if (d.value > 0 && (best === -1 || d.value > data[best].value)) best = i;
    });
    return best;
  });

  function show(event, bar) {
    tooltipContent = bar.tooltip;
    const bounds = event.currentTarget.getBoundingClientRect();
    tooltipX = bounds.left + bounds.width / 2;
    tooltipY = bounds.top;
    tooltipVisible = true;
  }

  const hide = () => (tooltipVisible = false);
</script>

<style>
  .chart {
    width: 100%;
  }

  .plot {
    position: relative;
    /* Room for the direct label above the tallest bar. */
    margin-top: 1.1rem;
  }

  .gridline {
    position: absolute;
    left: 0;
    right: 0;
    border-top: 1px solid #eeeeee;
  }

  .tick {
    position: absolute;
    right: 0;
    top: 0;
    transform: translateY(-100%);
    font-size: 0.7rem;
    color: #999;
    font-variant-numeric: tabular-nums;
    background: white;
    padding-left: 0.25rem;
  }

  .bars {
    position: relative;
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 100%;
    border-bottom: 1px solid #e0e0e0;
  }

  .bar-slot {
    flex: 1;
    min-width: 0;
    height: 100%;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    border: 0;
    padding: 0;
    background: none;
    cursor: pointer;
    position: relative;
  }

  .bar {
    width: 100%;
    max-width: 24px;
    border-radius: 4px 4px 0 0;
    background: #30a14e;
  }

  .bar-slot:hover .bar,
  .bar-slot:focus-visible .bar {
    background: #40c463;
  }

  .bar-slot:focus-visible {
    outline: 2px solid rgba(0, 0, 0, 0.3);
    outline-offset: 1px;
  }

  .bar-value {
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    font-size: 0.7rem;
    font-weight: 600;
    color: #333;
    white-space: nowrap;
    pointer-events: none;
    padding-bottom: 2px;
  }

  .x-labels {
    display: flex;
    gap: 2px;
    margin-top: 0.35rem;
  }

  .x-label {
    flex: 1;
    min-width: 0;
    font-size: 0.7rem;
    color: #666;
    text-align: center;
    white-space: nowrap;
    overflow: visible;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>

<div class="chart">
  <div class="plot" style="height: {plotHeight}px" role="img" aria-label={ariaLabel}>
    {#each ticks as tick}
      <div class="gridline" style="bottom: {(tick / niceMax) * 100}%">
        <span class="tick">{formatTick(tick)}</span>
      </div>
    {/each}
    <div class="bars">
      {#each data as bar, i}
        <button
          type="button"
          class="bar-slot"
          aria-label={bar.tooltip.replaceAll('\n', ', ')}
          onmouseenter={(e) => show(e, bar)}
          onmouseleave={hide}
          onfocus={(e) => show(e, bar)}
          onblur={hide}>
          {#if i === maxIndex}
            <span class="bar-value" style="bottom: {(bar.value / niceMax) * 100}%">
              {formatTick(bar.value)}
            </span>
          {/if}
          <div class="bar" style="height: {(bar.value / niceMax) * 100}%"></div>
        </button>
      {/each}
    </div>
  </div>
  <div class="x-labels" aria-hidden="true">
    {#each data as bar}
      <span class="x-label">{bar.label}</span>
    {/each}
  </div>
  <!-- The no-hover twin of the tooltip layer -->
  <table class="sr-only">
    <tbody>
      {#each data as bar}
        <tr><td>{bar.tooltip.replaceAll('\n', ', ')}</td></tr>
      {/each}
    </tbody>
  </table>
</div>

{#if tooltipVisible}
  <div style="position: fixed; left: {tooltipX}px; top: {tooltipY}px; background: rgba(0, 0, 0, 0.9); color: white; padding: 0.5rem 0.75rem; border-radius: 4px; font-size: 0.75rem; white-space: pre-line; pointer-events: none; z-index: 9999; transform: translate(-50%, calc(-100% - 6px)); box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);">
    {tooltipContent}
  </div>
{/if}
