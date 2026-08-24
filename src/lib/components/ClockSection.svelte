<script lang="ts">
  // When you read: minutes by start hour (raw local time) and by weekday
  // (3 AM-shifted, matching the heatmap's idea of a day).
  import BarChart from './charts/BarChart.svelte';
  import { minutesByHour, minutesByWeekday } from '$lib/utils/sessions.ts';
  import type { HourBucket, WeekdayBucket } from '$lib/interfaces/analytics.ts';
  import type { BookUpdateView } from '$lib/interfaces/reading.ts';

  let { sessions = [] }: { sessions?: BookUpdateView[] } = $props();

  const hourLabel = (hour: number) => {
    if (hour === 0) return '12am';
    if (hour === 12) return '12pm';
    return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
  };

  const hoursTick = (minutes: number) => `${Math.round(minutes / 60)}h`;

  const bucketTooltip = (name: string, bucket: HourBucket | WeekdayBucket) => {
    const lines = [
      `${Math.round(bucket.minutes / 60)} hrs`,
      name,
      `${bucket.sessions} session${bucket.sessions === 1 ? '' : 's'}`,
    ];
    if (bucket.pagesPerHour !== null) {
      lines.push(`${Math.round(bucket.pagesPerHour)} pages/hr`);
    }
    return lines.join('\n');
  };

  const hourData = $derived(
    minutesByHour(sessions).map((bucket) => ({
      label: bucket.hour % 6 === 0 ? hourLabel(bucket.hour) : '',
      value: bucket.minutes,
      tooltip: bucketTooltip(`${hourLabel(bucket.hour)}–${hourLabel((bucket.hour + 1) % 24)}`, bucket),
    }))
  );

  const weekdayData = $derived(
    minutesByWeekday(sessions).map((bucket) => ({
      label: bucket.label,
      value: bucket.minutes,
      tooltip: bucketTooltip(`${bucket.label}s`, bucket),
    }))
  );

  const hasData = $derived(hourData.some((bucket) => bucket.value > 0));
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

  .charts {
    display: grid;
    grid-template-columns: 3fr 2fr;
    gap: 2.5rem;
  }

  h3 {
    font-size: 1rem;
    color: #333;
    margin: 0 0 0.25rem 0;
  }

  @media (max-width: 768px) {
    .section {
      padding: 1.25rem;
    }

    .charts {
      grid-template-columns: 1fr;
      gap: 1.5rem;
    }
  }
</style>

{#if hasData}
  <div class="section">
    <h2>When You Read</h2>
    <p class="subtitle">Total reading time by time of day and day of week</p>
    <div class="charts">
      <div>
        <h3>By hour</h3>
        <BarChart
          data={hourData}
          formatTick={hoursTick}
          ariaLabel="Reading time by hour of day" />
      </div>
      <div>
        <h3>By weekday</h3>
        <BarChart
          data={weekdayData}
          formatTick={hoursTick}
          ariaLabel="Reading time by day of week" />
      </div>
    </div>
  </div>
{/if}
