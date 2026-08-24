<script>
  // Single-series line chart. The SVG holds only the line (percentage
  // coordinates, preserveAspectRatio none, non-scaling 2px stroke); all
  // text and the end-dot are HTML overlays so nothing distorts when the
  // plot stretches. Months with a null value break the line into segments
  // — a gap is data, not something to interpolate over.
  //
  // points: [{ label, value|null, tooltip }]; referenceValue draws a
  // dashed lifetime-average rule; xLabels: [{ index, text }] sparse ticks.
  let {
    points = [],
    referenceValue = null,
    referenceLabel = '',
    plotHeight = 180,
    formatTick = (value) => value.toLocaleString(),
    ariaLabel,
    xLabels = [],
  } = $props();

  let activeIndex = $state(null);
  let plotElement = $state(null);
  let tooltipX = $state(0);
  let tooltipY = $state(0);

  const niceMax = $derived.by(() => {
    const max = Math.max(...points.map((p) => p.value ?? 0), referenceValue ?? 0);
    if (max === 0) return 1;
    const magnitude = 10 ** Math.floor(Math.log10(max));
    const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => s * magnitude >= max);
    return step * magnitude;
  });
  const ticks = $derived([0.5, 1].map((f) => f * niceMax));

  const xPercent = (index) =>
    points.length > 1 ? (index / (points.length - 1)) * 100 : 50;
  const yPercent = (value) => 100 - (value / niceMax) * 100;

  // Contiguous non-null runs, each its own path.
  const segments = $derived.by(() => {
    const runs = [];
    let run = [];
    points.forEach((point, index) => {
      if (point.value === null) {
        if (run.length > 0) runs.push(run);
        run = [];
      } else {
        run.push({ index, value: point.value });
      }
    });
    if (run.length > 0) runs.push(run);
    return runs;
  });

  const pathFor = (run) =>
    run
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xPercent(p.index)} ${yPercent(p.value)}`)
      .join(' ');

  const lastPoint = $derived.by(() => {
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i].value !== null) return { index: i, value: points[i].value };
    }
    return null;
  });

  function positionTooltip(index) {
    const bounds = plotElement.getBoundingClientRect();
    const value = points[index].value;
    tooltipX = bounds.left + (xPercent(index) / 100) * bounds.width;
    tooltipY = value === null
      ? bounds.top + bounds.height / 2
      : bounds.top + (yPercent(value) / 100) * bounds.height;
  }

  // The crosshair finds the X: snap the pointer to the nearest index.
  function handlePointer(event) {
    const bounds = plotElement.getBoundingClientRect();
    const fraction = (event.clientX - bounds.left) / bounds.width;
    const index = Math.max(0, Math.min(points.length - 1, Math.round(fraction * (points.length - 1))));
    activeIndex = index;
    positionTooltip(index);
  }

  function handleKeydown(event) {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const index = Math.max(0, Math.min(points.length - 1, (activeIndex ?? points.length - 1) + step));
    activeIndex = index;
    positionTooltip(index);
  }

  const clear = () => (activeIndex = null);
</script>

<style>
  .chart {
    width: 100%;
  }

  .plot {
    position: relative;
    margin-top: 1.1rem;
    border-bottom: 1px solid #e0e0e0;
    cursor: crosshair;
    outline: none;
  }

  .plot:focus-visible {
    outline: 2px solid rgba(0, 0, 0, 0.3);
    outline-offset: 2px;
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

  .reference {
    position: absolute;
    left: 0;
    right: 0;
    border-top: 1px dashed #999;
  }

  .reference-label {
    position: absolute;
    left: 0;
    top: 0;
    transform: translateY(-100%);
    font-size: 0.7rem;
    color: #666;
    background: white;
    padding-right: 0.25rem;
  }

  svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
  }

  path {
    fill: none;
    stroke: #30a14e;
    stroke-width: 2px;
    stroke-linecap: round;
    stroke-linejoin: round;
    vector-effect: non-scaling-stroke;
  }

  .end-dot,
  .active-dot {
    position: absolute;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #30a14e;
    border: 2px solid white;
    box-sizing: content-box;
    transform: translate(-50%, -50%);
    pointer-events: none;
  }

  .crosshair {
    position: absolute;
    top: 0;
    bottom: 0;
    border-left: 1px solid #cccccc;
    pointer-events: none;
  }

  .x-labels {
    position: relative;
    height: 1.1rem;
    margin-top: 0.35rem;
  }

  .x-label {
    position: absolute;
    transform: translateX(-50%);
    font-size: 0.7rem;
    color: #666;
    white-space: nowrap;
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
  <!-- The plot is a genuine keyboard widget (arrow keys walk the months,
       reading out each point), which no non-interactive role captures. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="plot"
    style="height: {plotHeight}px"
    bind:this={plotElement}
    role="img"
    aria-label={ariaLabel}
    tabindex="0"
    onpointermove={handlePointer}
    onpointerleave={clear}
    onkeydown={handleKeydown}
    onblur={clear}>
    {#each ticks as tick}
      <div class="gridline" style="top: {yPercent(tick)}%">
        <span class="tick">{formatTick(tick)}</span>
      </div>
    {/each}
    {#if referenceValue !== null}
      <div class="reference" style="top: {yPercent(referenceValue)}%">
        <span class="reference-label">{referenceLabel}</span>
      </div>
    {/if}
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {#each segments as run}
        <path d={pathFor(run)} />
      {/each}
    </svg>
    {#if lastPoint}
      <div
        class="end-dot"
        style="left: {xPercent(lastPoint.index)}%; top: {yPercent(lastPoint.value)}%">
      </div>
    {/if}
    <!-- points[activeIndex] check: a snapshot can shrink the series while
         the pointer or focus still holds a now-out-of-range index. -->
    {#if activeIndex !== null && points[activeIndex]}
      <div class="crosshair" style="left: {xPercent(activeIndex)}%"></div>
      {#if points[activeIndex].value !== null}
        <div
          class="active-dot"
          style="left: {xPercent(activeIndex)}%; top: {yPercent(points[activeIndex].value)}%">
        </div>
      {/if}
    {/if}
  </div>
  <div class="x-labels" aria-hidden="true">
    {#each xLabels as { index, text }}
      <span class="x-label" style="left: {xPercent(index)}%">{text}</span>
    {/each}
  </div>
  <!-- The no-hover twin of the tooltip layer -->
  <table class="sr-only">
    <tbody>
      {#each points as point}
        <tr><td>{point.tooltip.replaceAll('\n', ', ')}</td></tr>
      {/each}
    </tbody>
  </table>
</div>

{#if activeIndex !== null && points[activeIndex]}
  <div style="position: fixed; left: {tooltipX}px; top: {tooltipY}px; background: rgba(0, 0, 0, 0.9); color: white; padding: 0.5rem 0.75rem; border-radius: 4px; font-size: 0.75rem; white-space: pre-line; pointer-events: none; z-index: 9999; transform: translate(-50%, calc(-100% - 10px)); box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);">
    {points[activeIndex].tooltip}
  </div>
{/if}
