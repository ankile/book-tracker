<script>
  import { formatTime } from '../utils/format.js';
  import { DAY_BOUNDARY_OFFSET_HOURS } from '../utils/stats.js';

  // Per-day aggregates ({day: 'YYYY-MM-DD', pagesRead, timeRead, sessions},
  // the aggregateSessionsByDay shape). The component no longer loads
  // sessions itself: the Me page aggregates its live session listener, and
  // the public profile page passes the aggregates published on the profile
  // doc — same renderer, no private data required.
  let { days = [] } = $props();

  let tooltipVisible = $state(false);
  let tooltipContent = $state('');
  let tooltipX = $state(0);
  let tooltipY = $state(0);
  let focusedDayKey = $state(null);

  // Year selection for heatmap view
  let selectedYear = $state('last12months');

  // Index the day aggregates by their day key
  let activityByDay = $derived.by(() => {
    const dayMap = new Map();

    days.forEach((entry) => {
      const [year, month, dayOfMonth] = entry.day.split('-').map(Number);
      dayMap.set(entry.day, {
        date: new Date(year, month - 1, dayOfMonth),
        pagesRead: entry.pagesRead,
        timeRead: entry.timeRead,
        sessions: entry.sessions
      });
    });

    return dayMap;
  });

  // Get available years from the day aggregates
  let availableYears = $derived.by(() => {
    const years = new Set();
    days.forEach((entry) => {
      years.add(Number(entry.day.slice(0, 4)));
    });
    return Array.from(years).sort((a, b) => b - a); // Descending order
  });

  // Date range for the last 52 weeks, ending this week
  function last12MonthsRange() {
    const today = new Date();
    const endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - (52 * 7)); // Go back 52 weeks

    // Start from the most recent Sunday (so Monday is first in our grid)
    const dayOfWeek = endDate.getDay();
    const daysToSunday = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;
    endDate.setDate(endDate.getDate() + daysToSunday);

    // Go back to the first Monday
    const startDayOfWeek = startDate.getDay();
    startDate.setDate(startDate.getDate() - startDayOfWeek);
    startDate.setDate(startDate.getDate() + 1);

    return { startDate, endDate };
  }

  // Date range for one calendar year, padded to whole Monday–Sunday weeks
  function yearRange(year) {
    const startDate = new Date(year, 0, 1); // Jan 1
    const endDate = new Date(year, 11, 31); // Dec 31

    // Start from Monday of the week containing Jan 1
    const startDayOfWeek = startDate.getDay();
    const daysToMonday = startDayOfWeek === 0 ? 6 : startDayOfWeek - 1;
    startDate.setDate(startDate.getDate() - daysToMonday);

    // End on Sunday of the week containing Dec 31
    const endDayOfWeek = endDate.getDay();
    const daysToSunday = endDayOfWeek === 0 ? 0 : 7 - endDayOfWeek;
    endDate.setDate(endDate.getDate() + daysToSunday);

    return { startDate, endDate };
  }

  function buildWeeks({ startDate, endDate }) {
    const weeks = [];
    let currentDate = new Date(startDate);

    while (currentDate <= endDate) {
      const week = [];
      for (let i = 0; i < 7; i++) {
        const dayKey = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(currentDate.getDate()).padStart(2, '0')}`;
        const activity = activityByDay.get(dayKey);

        week.push({
          date: new Date(currentDate),
          dayKey,
          pagesRead: activity?.pagesRead || 0,
          timeRead: activity?.timeRead || 0,
          sessions: activity?.sessions || 0
        });

        currentDate.setDate(currentDate.getDate() + 1);
      }
      weeks.push(week);
    }

    return weeks;
  }

  // The grids to render: one for "last 12 months" or a single year, or —
  // for "All time" — a stack of per-year grids, newest first (the GitHub
  // activity-wall convention; one continuous strip would be thousands of
  // pixels of horizontal scroll).
  let grids = $derived.by(() => {
    if (selectedYear === 'all') {
      return availableYears.map((year) => ({
        label: String(year),
        weeks: buildWeeks(yearRange(year))
      }));
    }
    const range = selectedYear === 'last12months'
      ? last12MonthsRange()
      : yearRange(parseInt(selectedYear));
    return [{ label: null, weeks: buildWeeks(range) }];
  });

  $effect(() => {
    const focusedDayIsVisible = grids.some((grid) =>
      grid.weeks.some((week) => week.some((day) => day.dayKey === focusedDayKey))
    );

    if (!focusedDayIsVisible) {
      focusedDayKey = grids[0]?.weeks[0]?.[0]?.dayKey ?? null;
    }
  });

  // Get color based on activity level
  function getColor(pagesRead) {
    if (pagesRead === 0) return '#ebedf0';
    if (pagesRead < 10) return '#9be9a8';
    if (pagesRead < 25) return '#40c463';
    if (pagesRead < 50) return '#30a14e';
    return '#216e39';
  }

  // Format tooltip
  function formatTooltip(day) {
    const dateStr = day.date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });

    if (day.pagesRead === 0) {
      return `${dateStr}\nNo reading activity`;
    }

    return `${dateStr}\n${day.pagesRead} pages\n${formatTime(day.timeRead)}\n${day.sessions} session${day.sessions !== 1 ? 's' : ''}`;
  }

  function showTooltip(event, day) {
    tooltipContent = formatTooltip(day);
    updateTooltipPosition(event);
    tooltipVisible = true;
  }

  function showKeyboardTooltip(event, day) {
    const bounds = event.currentTarget.getBoundingClientRect();
    tooltipContent = formatTooltip(day);
    tooltipX = bounds.right;
    tooltipY = bounds.top;
    tooltipVisible = true;
  }

  function updateTooltipPosition(event) {
    tooltipX = event.clientX;
    tooltipY = event.clientY;
  }

  function hideTooltip() {
    tooltipVisible = false;
  }

  function handleDayKeydown(event, day) {
    const dayOffsets = {
      ArrowUp: -1,
      ArrowDown: 1,
      ArrowLeft: -7,
      ArrowRight: 7
    };
    const offset = dayOffsets[event.key];

    if (offset === undefined) {
      return;
    }

    event.preventDefault();
    const targetDate = new Date(day.date);
    targetDate.setDate(targetDate.getDate() + offset);
    const targetDayKey = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, '0')}-${String(targetDate.getDate()).padStart(2, '0')}`;
    const target = document.querySelector(`[data-day-key="${targetDayKey}"]`);

    if (target instanceof HTMLButtonElement) {
      focusedDayKey = targetDayKey;
      target.focus();
    }
  }

  // Get month labels for one grid's weeks
  function buildMonthLabels(weeks) {
    const labels = [];
    let lastMonth = -1;

    weeks.forEach((week, weekIndex) => {
      const firstDay = week[0];
      const month = firstDay.date.getMonth();

      // Only add label if month changed
      if (month !== lastMonth) {
        // Count how many weeks remain for this month
        let weeksInMonth = 0;
        for (let i = weekIndex; i < weeks.length && weeks[i][0].date.getMonth() === month; i++) {
          weeksInMonth++;
        }

        // Only add label if there are at least 2 weeks of this month visible
        if (weeksInMonth >= 2) {
          // Ensure at least 2 weeks between labels to prevent overlap
          if (labels.length === 0 || (weekIndex - labels[labels.length - 1].weekIndex >= 2)) {
            labels.push({
              weekIndex,
              month: firstDay.date.toLocaleDateString('en-US', { month: 'short' })
            });
          }
        }

        lastMonth = month;
      }
    });

    return labels;
  }

  // Calculate stats
  let stats = $derived.by(() => {
    let totalPages = 0;
    let totalTime = 0;
    let activeDays = 0;
    let longestStreak = 0;
    let currentStreak = 0;

    activityByDay.forEach(day => {
      totalPages += day.pagesRead;
      totalTime += day.timeRead;
      if (day.pagesRead > 0) activeDays++;
    });

    // Calculate streaks (using same offset as activity aggregation),
    // walking back from today to the earliest recorded day — a fixed
    // lookback would silently cap "longest streak" at its window.
    const now = new Date();
    now.setHours(now.getHours() - DAY_BOUNDARY_OFFSET_HOURS);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let checkDate = new Date(today);
    let tempStreak = 0;
    let foundCurrentStreak = false;

    // days is ascending by day key, so the first entry is the earliest.
    const [firstYear, firstMonth, firstDay] = (days[0]?.day ?? '9999-01-01').split('-').map(Number);
    const earliestDate = new Date(firstYear, firstMonth - 1, firstDay);

    while (checkDate >= earliestDate) {
      const dayKey = `${checkDate.getFullYear()}-${String(checkDate.getMonth() + 1).padStart(2, '0')}-${String(checkDate.getDate()).padStart(2, '0')}`;
      const activity = activityByDay.get(dayKey);

      if (activity && activity.pagesRead > 0) {
        tempStreak++;
        if (tempStreak > longestStreak) {
          longestStreak = tempStreak;
        }
        // If we haven't found the current streak yet, this counts toward it
        if (!foundCurrentStreak) {
          currentStreak++;
        }
      } else {
        // No activity on this day
        const isToday = checkDate.getTime() === today.getTime();
        if (!isToday) {
          // Past day with no reading - current streak ends (if not already ended)
          if (!foundCurrentStreak) {
            foundCurrentStreak = true;
          }
          // Reset temp streak for finding longest historical streak
          tempStreak = 0;
        }
        // If it's today with no reading, continue (might read later today)
      }

      checkDate.setDate(checkDate.getDate() - 1);
    }

    return {
      totalPages,
      totalTime,
      activeDays,
      currentStreak,
      longestStreak
    };
  });
</script>

<style>
  .heatmap-container {
    background: white;
    padding: 2rem;
    border-radius: 5px;
    box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.2), 0 6px 20px 0 rgba(0, 0, 0, 0.19);
    margin-top: 2rem;
  }

  .heatmap-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
    flex-wrap: wrap;
    gap: 1rem;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  h2 {
    font-size: 1.5rem;
    color: #333;
    margin: 0;
  }

  .year-selector {
    padding: 0.5rem 0.75rem;
    border: 1px solid #ddd;
    border-radius: 4px;
    font-size: 0.9rem;
    background: white;
    cursor: pointer;
    color: #333;
  }

  .year-selector:hover {
    border-color: #999;
  }

  .year-selector:focus {
    outline: none;
    border-color: #007bff;
    box-shadow: 0 0 0 2px rgba(0, 123, 255, 0.1);
  }

  .heatmap-stats {
    display: flex;
    gap: 1.5rem;
    font-size: 0.9rem;
    color: #666;
  }

  .stat {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
  }

  .stat-value {
    font-weight: 700;
    font-size: 1.1rem;
    color: #333;
  }

  .heatmap-wrapper {
    overflow-x: auto;
    padding-bottom: 1rem;
  }

  .year-label {
    font-size: 1.1rem;
    font-weight: 600;
    color: #333;
    margin: 0 0 0.5rem 0;
    text-align: left;
  }

  /* grid-template-columns comes from the markup (one 1fr track per week).
     min-width keeps cells from shrinking below ~10px — narrower screens
     scroll the wrapper instead. */
  .heatmap {
    display: grid;
    gap: 3px;
    min-width: 720px;
  }

  .day-cell {
    border: 0;
    width: 100%;
    aspect-ratio: 1 / 1;
    padding: 0;
    border-radius: 2px;
    cursor: pointer;
  }

  .day-cell:hover {
    outline: 2px solid rgba(0, 0, 0, 0.3);
    outline-offset: 1px;
  }

  .month-label {
    grid-row: 1;
    font-size: 0.75rem;
    color: #666;
    white-space: nowrap;
  }

  .day-label {
    grid-column: 1;
    align-self: center;
    padding-right: 5px;
    font-size: 0.75rem;
    color: #666;
  }

  .legend {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 1rem;
    font-size: 0.75rem;
    color: #666;
  }

  .legend-colors {
    display: flex;
    gap: 2px;
  }

  .legend-cell {
    width: 11px;
    height: 11px;
    border-radius: 2px;
  }

  @media (max-width: 768px) {
    .heatmap-container {
      padding: 1.25rem;
    }

    .heatmap-header {
      flex-direction: column;
      align-items: stretch;
    }

    .header-left {
      flex-direction: column;
      align-items: flex-start;
    }

    .year-selector {
      width: 100%;
    }

    .heatmap-stats {
      width: 100%;
      justify-content: space-around;
    }

    .stat {
      align-items: center;
    }
  }
</style>

<div class="heatmap-container">
  <div class="heatmap-header">
    <div class="header-left">
      <h2>Reading Activity</h2>
      <select bind:value={selectedYear} class="year-selector">
        <option value="last12months">Last 12 months</option>
        <option value="all">All time</option>
        {#each availableYears as year}
          <option value={year.toString()}>{year}</option>
        {/each}
      </select>
    </div>
    <div class="heatmap-stats">
      <div class="stat">
        <span class="stat-value">{stats.activeDays}</span>
        <span>days active</span>
      </div>
      <div class="stat">
        <span class="stat-value">{stats.currentStreak}</span>
        <span>day streak</span>
      </div>
      <div class="stat">
        <span class="stat-value">{stats.longestStreak}</span>
        <span>longest streak</span>
      </div>
    </div>
  </div>

  {#each grids as grid (grid.label ?? 'single')}
    <div class="heatmap-wrapper">
      {#if grid.label}
        <h3 class="year-label">{grid.label}</h3>
      {/if}
      <!-- One CSS grid per heatmap: an auto label column plus one 1fr track
           per week, so the wall stretches to the card's full width (cells
           take their height from the track via aspect-ratio). Month labels
           are grid items on row 1 placed by week index — no pixel math to
           fall out of step with the scaling cells. -->
      <div
        class="heatmap"
        style="grid-template-columns: auto repeat({grid.weeks.length}, 1fr);"
        role="group"
        aria-label="Daily reading activity{grid.label ? ` in ${grid.label}` : ''}">
        {#each buildMonthLabels(grid.weeks) as label}
          <span class="month-label" style="grid-column: {label.weekIndex + 2};">{label.month}</span>
        {/each}
        <span class="day-label" style="grid-row: 2;">Mon</span>
        <span class="day-label" style="grid-row: 4;">Wed</span>
        <span class="day-label" style="grid-row: 6;">Fri</span>
        {#each grid.weeks as week, weekIndex}
          {#each week as day, dayIndex}
            <button
              type="button"
              data-day-key={day.dayKey}
              tabindex={day.dayKey === focusedDayKey ? 0 : -1}
              aria-label={formatTooltip(day).replaceAll('\n', ', ')}
              class="day-cell"
              style="grid-column: {weekIndex + 2}; grid-row: {dayIndex + 2}; background-color: {getColor(day.pagesRead)}"
              onmouseenter={(e) => showTooltip(e, day)}
              onmousemove={updateTooltipPosition}
              onmouseleave={hideTooltip}
              onfocus={(e) => showKeyboardTooltip(e, day)}
              onblur={hideTooltip}
              onkeydown={(e) => handleDayKeydown(e, day)}>
            </button>
          {/each}
        {/each}
      </div>
    </div>
  {/each}

  <div class="legend">
    <span>Less</span>
    <div class="legend-colors">
      <div class="legend-cell" style="background-color: #ebedf0"></div>
      <div class="legend-cell" style="background-color: #9be9a8"></div>
      <div class="legend-cell" style="background-color: #40c463"></div>
      <div class="legend-cell" style="background-color: #30a14e"></div>
      <div class="legend-cell" style="background-color: #216e39"></div>
    </div>
    <span>More</span>
  </div>
</div>

{#if tooltipVisible}
  <div style="position: fixed; left: {tooltipX}px; top: {tooltipY}px; background: rgba(0, 0, 0, 0.9); color: white; padding: 0.5rem 0.75rem; border-radius: 4px; font-size: 0.75rem; white-space: pre-line; pointer-events: none; z-index: 9999; transform: translate(10px, 10px); box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);">
    {tooltipContent}
  </div>
{/if}
