<script lang="ts">
  import { FORECAST_RANGE_SCALE, type ForecastCalibration } from '../utils/finishForecast.ts';
  import { forecastHistogram } from '../utils/forecastDistribution.ts';
  let { calibration, days }: { calibration: ForecastCalibration; days: number } = $props();
  const histogram = $derived(forecastHistogram(calibration, days));
  let width = $state(680);
  const plotWidth = $derived(width - 130);
  const ticks = $derived(width < 480 ? [0, Math.expm1(Math.log1p(histogram.maxDays) / 2), histogram.maxDays] : histogram.ticks);
  const num = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 1 });
  const percent = (n: number) => `${num(n * 100)}%`;
</script>

<figure data-testid="forecast-distribution" bind:clientWidth={width}>
  <figcaption><strong>The distribution behind the range</strong><span>Historical mass per bin</span></figcaption>
  {#if calibration.distribution!.length === 0}
    <p>No completed outcomes in this calibration group yet. All historical mass remains unresolved; there is no finite distribution to plot.</p>
  {:else}
  <svg viewBox={`0 0 ${width} 255`} role="img" aria-label={`Historical error distribution expressed as remaining days. Full finite tail to ${num(histogram.maxDays)} days. ${percent(calibration.unresolvedMass)} remains unresolved.`}>
    {#each [0, .5, 1] as fraction}
      <line x1="48" x2={48 + plotWidth} y1={182 - 142 * fraction} y2={182 - 142 * fraction} class="grid" />
      <text x="41" y={186 - 142 * fraction} text-anchor="end">{percent(histogram.maxMass * fraction)}</text>
    {/each}
    {#each histogram.bins as bin, i}
      <rect x={48 + i * plotWidth / histogram.bins.length} y={182 - bin.mass / histogram.maxMass * 142}
        width={plotWidth / histogram.bins.length - 2} height={bin.mass / histogram.maxMass * 142} class="bar">
        <title>{num(bin.from)} to {num(bin.to)} days: {percent(bin.mass)} historical mass</title>
      </rect>
    {/each}
    {#each [calibration.lowerFactor, calibration.upperFactor].filter(Number.isFinite) as factor}
      <line x1={48 + histogram.position(factor * Math.max(1, days)) * plotWidth} x2={48 + histogram.position(factor * Math.max(1, days)) * plotWidth} y1="32" y2="182" class="quantile" />
    {/each}
    <rect x={width - 49} y={182 - calibration.unresolvedMass / histogram.maxMass * 142} width="30" height={calibration.unresolvedMass / histogram.maxMass * 142} class="tail" />
    <text x={width - 34} y="28" text-anchor="middle">{percent(calibration.unresolvedMass)}</text>
    <text x={width - 34} y="205" text-anchor="middle">Unresolved</text>
    {#each ticks as tick}
      <text x={48 + histogram.position(tick) * plotWidth} y="205" text-anchor={tick === histogram.maxDays ? 'end' : 'middle'}>{num(tick)}</text>
    {/each}
    <text x={width / 2} y="235" text-anchor="middle">Remaining days · log(1 + days)</text>
  </svg>
  <p>Bars show the historical error distribution applied to this estimate, before widening. Dashed lines mark its 10th and 90th percentiles when known. The date range above widens those endpoints by a factor of {FORECAST_RANGE_SCALE}. Unfinished books contribute censored waits; unresolved mass has no known completion time. This is not a calibrated probability for this book.</p>
  <details><summary>Distribution values</summary><div class="values"><table><thead><tr><th>Remaining days</th><th>Historical mass</th></tr></thead><tbody>
    {#each histogram.bins as bin}<tr><td>{num(bin.from)} to {num(bin.to)}</td><td>{percent(bin.mass)}</td></tr>{/each}
    <tr><td>Unresolved</td><td>{percent(calibration.unresolvedMass)}</td></tr>
  </tbody></table></div></details>
  {/if}
</figure>

<style>
  figure { margin: 1.25rem 0; }
  figcaption { display: flex; flex-wrap: wrap; justify-content: space-between; gap: .5rem; font-size: .85rem; }
  figcaption span, p { color: #53636a; }
  svg { display: block; width: 100%; }
  text { fill: #42545b; font-size: 12px; }
  .grid { stroke: #d6e0e1; }
  .bar { fill: #1b7179; }
  .tail { fill: #ad7740; }
  .quantile { stroke: #253237; stroke-width: 2; stroke-dasharray: 4 3; }
  p, summary, table { font-size: .78rem; line-height: 1.5; }
  summary { cursor: pointer; color: #176c74; }
  summary:focus-visible { outline: 3px solid #1b7179; }
  table { width: 100%; border-collapse: collapse; margin-top: .5rem; }
  th, td { text-align: left; padding: .3rem; border-bottom: 1px solid #d6e0e1; }
</style>
