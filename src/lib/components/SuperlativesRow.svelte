<script>
  // Small record tiles: momentum vs lifetime pace, biggest day, longest
  // sitting, median session, fastest finish. Pure derivations from the
  // page's live listeners.
  import { computeMomentum, computeSuperlatives } from '$lib/utils/sessions.js';
  import { formatTime } from '$lib/utils/format.js';

  // timelines is the page-level buildBookTimelines result, computed once
  // and shared across sections.
  let { sessions = [], books = [], timelines = new Map(), published = null } = $props();

  const momentum = $derived(published ? published.momentum : computeMomentum(sessions, new Date()));
  const superlatives = $derived(published ? published.superlatives : computeSuperlatives(sessions, books, timelines));

  const formatDay = (dayKey) => {
    const [year, month, day] = dayKey.split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };
</script>

<style>
  .superlatives {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
    gap: 1.5rem;
    margin-bottom: 2rem;
  }

  .tile {
    background: white;
    padding: 1.25rem 1.5rem;
    border-radius: 5px;
    box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.2), 0 6px 20px 0 rgba(0, 0, 0, 0.19);
  }

  .tile-label {
    font-size: 0.8rem;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 0.4rem;
    font-weight: 600;
  }

  .tile-value {
    font-size: 1.6rem;
    font-weight: 700;
    color: #333;
  }

  .tile-subtext {
    font-size: 0.8rem;
    color: #999;
    margin-top: 0.2rem;
  }

  @media (max-width: 768px) {
    .superlatives {
      grid-template-columns: repeat(2, 1fr);
      gap: 1rem;
    }
  }
</style>

{#if superlatives}
  <div class="superlatives">
    {#if momentum?.ratio !== null && momentum}
      <div class="tile">
        <div class="tile-label">Momentum</div>
        <div class="tile-value">{momentum.ratio.toFixed(1)}×</div>
        <div class="tile-subtext">
          {momentum.recentPagesPerDay.toFixed(1)} pages/day last 30 days vs
          {momentum.lifetimePagesPerDay.toFixed(1)} lifetime
        </div>
      </div>
    {/if}

    {#if superlatives.biggestDay}
      <div class="tile">
        <div class="tile-label">Biggest Day</div>
        <div class="tile-value">{superlatives.biggestDay.pages} pages</div>
        <div class="tile-subtext">{formatDay(superlatives.biggestDay.day)}</div>
      </div>
    {/if}

    {#if superlatives.longestSession}
      <div class="tile">
        <div class="tile-label">Longest Sitting</div>
        <div class="tile-value">{formatTime(superlatives.longestSession.minutes)}</div>
        <div class="tile-subtext">
          {superlatives.longestSession.title ?? 'Single reading session'}
        </div>
      </div>
    {/if}

    <div class="tile">
      <div class="tile-label">Median Session</div>
      <div class="tile-value">{Math.round(superlatives.medianSessionMinutes)} min</div>
      <div class="tile-subtext">Across all reading sessions</div>
    </div>

    {#if superlatives.fastestFinish}
      <div class="tile">
        <div class="tile-label">Fastest Finish</div>
        <div class="tile-value">
          {superlatives.fastestFinish.days}
          {superlatives.fastestFinish.days === 1 ? 'day' : 'days'}
        </div>
        <div class="tile-subtext">
          {superlatives.fastestFinish.title ?? 'Finished book'} ({superlatives.fastestFinish.pageCount} pages)
        </div>
      </div>
    {/if}
  </div>
{/if}
