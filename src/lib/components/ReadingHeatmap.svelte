<script>
  import { Database } from '../firebase/db.js';
  import { formatTime } from '../utils/format.js';

  let { userId, allBooks } = $props();

  let tooltipVisible = $state(false);
  let tooltipContent = $state('');
  let tooltipX = $state(0);
  let tooltipY = $state(0);

  // Get all reading sessions across all books
  let allSessions = $state([]);

  $effect(() => {
    if (!userId || !allBooks || allBooks.length === 0) {
      allSessions = [];
      return;
    }

    const unsubscribers = [];
    const sessionsByBook = new Map();

    allBooks.forEach(book => {
      const sessionsStore = Database.getReadingSessions(userId, book.id);
      const unsub = sessionsStore.subscribe((sessions) => {
        sessionsByBook.set(book.id, sessions);
        // Flatten all sessions into one array
        allSessions = Array.from(sessionsByBook.values()).flat();
      });
      unsubscribers.push(unsub);
    });

    return () => {
      unsubscribers.forEach(unsub => unsub());
    };
  });

  // Aggregate sessions by day
  let activityByDay = $derived.by(() => {
    const dayMap = new Map();

    allSessions.forEach(session => {
      const date = session.createdAt?.toDate?.();
      if (!date) return;

      const dayKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

      if (!dayMap.has(dayKey)) {
        dayMap.set(dayKey, {
          date: new Date(date.getFullYear(), date.getMonth(), date.getDate()),
          pagesRead: 0,
          timeRead: 0,
          sessions: 0
        });
      }

      const day = dayMap.get(dayKey);
      day.pagesRead += session.pagesRead || 0;
      day.timeRead += session.timeRead || 0;
      day.sessions += 1;
    });

    return dayMap;
  });

  // Generate grid for last 52 weeks
  let weeks = $derived.by(() => {
    const today = new Date();
    const endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - (52 * 7)); // Go back 52 weeks

    // Start from the most recent Sunday (so Monday is first in our grid)
    const dayOfWeek = endDate.getDay();
    // Adjust to get to next Sunday (day 0)
    const daysToSunday = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;
    endDate.setDate(endDate.getDate() + daysToSunday);

    // Go back to the first Monday (by going to Sunday then forward 1 day)
    const startDayOfWeek = startDate.getDay();
    // Go back to previous Sunday
    startDate.setDate(startDate.getDate() - startDayOfWeek);
    // Then forward to Monday
    startDate.setDate(startDate.getDate() + 1);

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

  function updateTooltipPosition(event) {
    tooltipX = event.clientX;
    tooltipY = event.clientY;
  }

  function hideTooltip() {
    tooltipVisible = false;
  }

  // Get month labels
  let monthLabels = $derived.by(() => {
    const labels = [];
    let lastMonth = -1;

    weeks.forEach((week, weekIndex) => {
      const firstDay = week[0];
      const month = firstDay.date.getMonth();

      // Only add label if month changed
      if (month !== lastMonth) {
        // Only add label if there are at least 2 weeks remaining after this week
        // This prevents labels from appearing with no or few weeks below them
        if (weekIndex < weeks.length - 2) {
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
  });

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

    // Calculate streaks
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let checkDate = new Date(today);
    let streakActive = true;

    for (let i = 0; i < 365; i++) {
      const dayKey = `${checkDate.getFullYear()}-${String(checkDate.getMonth() + 1).padStart(2, '0')}-${String(checkDate.getDate()).padStart(2, '0')}`;
      const activity = activityByDay.get(dayKey);

      if (activity && activity.pagesRead > 0) {
        currentStreak++;
        if (currentStreak > longestStreak) {
          longestStreak = currentStreak;
        }
      } else {
        if (streakActive) {
          // Only count as broken streak if it's not today (you might read later today)
          const isToday = checkDate.getTime() === today.getTime();
          if (!isToday) {
            streakActive = false;
          }
        }
        if (!streakActive) {
          currentStreak = 0;
        }
      }

      checkDate.setDate(checkDate.getDate() - 1);
    }

    return {
      totalPages,
      totalTime,
      activeDays,
      currentStreak: streakActive ? currentStreak : 0,
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

  h2 {
    font-size: 1.5rem;
    color: #333;
    margin: 0;
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

  .heatmap {
    display: inline-flex;
    gap: 3px;
    min-width: 100%;
  }

  .week-column {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .day-cell {
    width: 11px;
    height: 11px;
    border-radius: 2px;
    cursor: pointer;
    position: relative;
  }

  .day-cell:hover {
    outline: 2px solid rgba(0, 0, 0, 0.3);
    outline-offset: 1px;
  }

  .tooltip {
    position: fixed;
    background: rgba(0, 0, 0, 0.9);
    color: white;
    padding: 0.5rem 0.75rem;
    border-radius: 4px;
    font-size: 0.75rem;
    white-space: pre-line;
    pointer-events: none;
    z-index: 9999;
    transform: translate(10px, 10px);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    min-width: 150px;
  }

  .month-labels {
    display: flex;
    margin-bottom: 0.5rem;
    font-size: 0.75rem;
    color: #666;
    padding-left: 30px;
  }

  .month-label {
    position: absolute;
    font-size: 0.75rem;
    color: #666;
  }

  .day-labels {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin-right: 5px;
    font-size: 0.75rem;
    color: #666;
  }

  .day-label {
    height: 11px;
    display: flex;
    align-items: center;
  }

  .heatmap-grid {
    display: flex;
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
    <h2>Reading Activity</h2>
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

  <div class="heatmap-wrapper">
    <div class="month-labels" style="position: relative; height: 15px;">
      {#each monthLabels as label}
        <span class="month-label" style="left: {label.weekIndex * 14}px;">{label.month}</span>
      {/each}
    </div>

    <div class="heatmap-grid">
      <div class="day-labels">
        <div class="day-label">Mon</div>
        <div class="day-label"></div>
        <div class="day-label">Wed</div>
        <div class="day-label"></div>
        <div class="day-label">Fri</div>
        <div class="day-label"></div>
        <div class="day-label"></div>
      </div>

      <div class="heatmap">
        {#each weeks as week}
          <div class="week-column">
            {#each week as day}
              <div
                class="day-cell"
                style="background-color: {getColor(day.pagesRead)}"
                onmouseenter={(e) => showTooltip(e, day)}
                onmousemove={updateTooltipPosition}
                onmouseleave={hideTooltip}>
              </div>
            {/each}
          </div>
        {/each}
      </div>
    </div>
  </div>

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
  <div class="tooltip" style="left: {tooltipX}px; top: {tooltipY}px;">
    {tooltipContent}
  </div>
{/if}
