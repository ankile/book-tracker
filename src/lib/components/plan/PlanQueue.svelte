<script lang="ts">
  // The ordered queue: rows with their expected dates, year dividers, and
  // reordering by pointer drag from the handle, by keyboard on the handle,
  // and by the explicit move controls in each row's details. The parent
  // owns the order: `onpreview` shows an order before it is saved,
  // `onmove` persists it. One polite live region announces moves.
  import { tick } from 'svelte';
  import type { Schedule } from '../../utils/readingPlan.ts';
  import { moveIndex } from '../../utils/readingPlan.ts';
  import {
    effortSourceLabel,
    formatFullDate,
    formatHours,
    formatMonth,
    formatPace,
    moveAnnouncement,
    type PlanRowView,
  } from '../../utils/planView.ts';

  let { rows, schedule, onpreview, onmove, onstart, onedit, onremove, onestimate }: {
    rows: PlanRowView[];
    schedule: Schedule;
    onpreview: (order: string[] | null) => void;
    // The moved row by id: during a drag `rows` is already in the previewed
    // order, so its original index means nothing at drop time.
    onmove: (id: string, to: number) => void;
    onstart: (row: PlanRowView) => void;
    onedit: (row: PlanRowView) => void;
    onremove: (row: PlanRowView) => void;
    onestimate: (row: PlanRowView) => void;
  } = $props();

  const scheduled = $derived(new Map(schedule.entries.map((entry) => [entry.id, entry])));
  const finishYear = (index: number) => scheduled.get(rows[index].id)?.finish?.getFullYear() ?? null;
  const dividerBefore = (index: number) => {
    if (index === 0) return null;
    const previous = finishYear(index - 1);
    const current = finishYear(index);
    return previous !== null && current !== null && current !== previous ? current : null;
  };

  let announcement = $state('');
  let expanded = $state<Record<string, boolean>>({});
  const handles = new Map<string, HTMLButtonElement>();
  const elements = new Map<string, HTMLLIElement>();
  // Row and handle elements by entry id, for hit-testing and focus.
  function trackRow(node: HTMLLIElement, id: string) {
    elements.set(id, node);
    return { destroy() { elements.delete(id); } };
  }
  function trackHandle(node: HTMLButtonElement, id: string) {
    handles.set(id, node);
    return { destroy() { handles.delete(id); } };
  }

  // Persist a move and announce it once the schedule for the new order is
  // on screen. Focus stays with the moved row's handle.
  async function commit(id: string, to: number) {
    const row = rows.find((candidate) => candidate.id === id);
    if (row === undefined) return;
    onmove(id, to);
    await tick();
    announcement = moveAnnouncement(row.title, to + 1, rows.length, scheduled.get(id)?.finish ?? null);
    handles.get(id)?.focus();
  }

  // --- Keyboard reorder: grab on the handle, arrows move, Enter/Space
  // drops, Escape cancels. ----------------------------------------------
  let grabbed = $state<string | null>(null);
  let grabbedFrom = -1;

  function handleKey(event: KeyboardEvent, index: number) {
    const row = rows[index];
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      if (grabbed === row.id) {
        grabbed = null;
        void commit(row.id, index);
      } else {
        grabbed = row.id;
        grabbedFrom = index;
        announcement = `${row.title} grabbed at position ${index + 1} of ${rows.length}. Use the arrow keys to move it, Enter to drop, Escape to cancel.`;
      }
      return;
    }
    if (grabbed !== row.id) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      grabbed = null;
      onpreview(null);
      announcement = `${row.title} returned to position ${grabbedFrom + 1}.`;
      return;
    }
    const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const target = index + delta;
    if (target < 0 || target >= rows.length) return;
    onpreview(moveIndex(rows, index, target).map((r) => r.id));
    announcement = `${row.title} at position ${target + 1} of ${rows.length}.`;
    void tick().then(() => handles.get(row.id)?.focus());
  }

  // --- Pointer drag from the handle. ---------------------------------
  const DRAG_THRESHOLD_PX = 6;
  const EDGE_PX = 56;
  const SCROLL_STEP_PX = 14;
  let dragging = $state<string | null>(null);
  let pointer: { id: number; startY: number; y: number; rowId: string; index: number; handle: HTMLButtonElement } | null = null;
  let frame = 0;

  function pointerDown(event: PointerEvent, index: number) {
    if (event.button !== 0 || grabbed !== null) return;
    const handle = event.currentTarget as HTMLButtonElement;
    pointer = { id: event.pointerId, startY: event.clientY, y: event.clientY, rowId: rows[index].id, index, handle };
    handle.setPointerCapture(event.pointerId);
  }

  function pointerMove(event: PointerEvent) {
    if (pointer === null || event.pointerId !== pointer.id) return;
    pointer.y = event.clientY;
    if (dragging === null) {
      if (Math.abs(event.clientY - pointer.startY) < DRAG_THRESHOLD_PX) return;
      dragging = pointer.rowId;
      window.addEventListener('keydown', dragKey);
      frame = requestAnimationFrame(dragFrame);
    }
  }

  // At most one reorder per animation frame, and only when the insertion
  // target changes; the edges of the viewport scroll while the pointer
  // stays near them.
  function dragFrame() {
    if (pointer === null || dragging === null) return;
    const y = pointer.y;
    if (y < EDGE_PX) window.scrollBy(0, -SCROLL_STEP_PX);
    else if (y > window.innerHeight - EDGE_PX) window.scrollBy(0, SCROLL_STEP_PX);
    let target = 0;
    for (const row of rows) {
      if (row.id === dragging) continue;
      const element = elements.get(row.id);
      if (element === undefined) continue;
      const rect = element.getBoundingClientRect();
      if (y > rect.top + rect.height / 2) target += 1;
    }
    if (target !== pointer.index) {
      pointer.index = target;
      const current = rows.findIndex((row) => row.id === dragging);
      onpreview(moveIndex(rows, current, target).map((row) => row.id));
    }
    frame = requestAnimationFrame(dragFrame);
  }

  function pointerUp(event: PointerEvent) {
    if (pointer === null || event.pointerId !== pointer.id) return;
    const { rowId, index, handle } = pointer;
    const wasDragging = dragging !== null;
    endDrag(handle, event.pointerId);
    if (wasDragging) void commit(rowId, index);
  }

  function pointerCancel(event: PointerEvent) {
    if (pointer === null || event.pointerId !== pointer.id) return;
    cancelDrag();
  }

  function dragKey(event: KeyboardEvent) {
    if (event.key === 'Escape') cancelDrag();
  }

  function cancelDrag() {
    if (pointer === null) return;
    const wasDragging = dragging !== null;
    const title = rows.find((row) => row.id === pointer?.rowId)?.title ?? '';
    endDrag(pointer.handle, pointer.id);
    if (wasDragging) {
      onpreview(null);
      announcement = `${title} returned to its position.`;
    }
  }

  function endDrag(handle: HTMLButtonElement, pointerId: number) {
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    cancelAnimationFrame(frame);
    window.removeEventListener('keydown', dragKey);
    pointer = null;
    dragging = null;
  }

  // --- Explicit controls. ---------------------------------------------
  let targetPosition = $state<Record<string, number | null>>({});

  function moveTo(index: number, position: number | null | undefined) {
    if (typeof position !== 'number' || !Number.isInteger(position)) return;
    const to = Math.min(rows.length, Math.max(1, position)) - 1;
    if (to === index) return;
    const id = rows[index].id;
    onpreview(moveIndex(rows, index, to).map((row) => row.id));
    void commit(id, to);
  }

  const dateRange = (id: string) => {
    const entry = scheduled.get(id);
    if (entry === undefined || entry.start === null || entry.finish === null) return 'No complete forecast yet';
    return `${formatFullDate(entry.start)} – ${formatFullDate(entry.finish)}`;
  };
</script>

<style>
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  ol {
    list-style: none;
    margin: 1.25rem 0 0;
    padding: 0;
  }

  .row {
    margin: 0 0 0.6rem;
    padding: 0.75rem 1rem;
    background: white;
    border: 1px solid #e2e8e8;
    border-radius: 8px;
    box-shadow: 0 2px 4px #0000000d;
    transition: box-shadow 0.15s ease-in-out, opacity 0.15s ease-in-out;
  }

  .row.dragging {
    opacity: 0.55;
    box-shadow: 0 6px 16px #0000002a;
  }

  .row.grabbed {
    outline: 2px dashed #1b7179;
    outline-offset: 2px;
  }

  .main {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .position {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .index {
    min-width: 1.5rem;
    color: #53636a;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    text-align: right;
  }

  .handle {
    width: 44px;
    height: 44px;
    border: 1px solid #ccd4d4;
    border-radius: 6px;
    background: white;
    color: #53636a;
    font-size: 1.2rem;
    line-height: 1;
    cursor: grab;
    touch-action: none;
  }

  .handle:focus-visible {
    outline: 3px solid #1f6f78;
    outline-offset: 2px;
  }

  .cover {
    flex: 0 0 auto;
    width: 40px;
    aspect-ratio: 2 / 3;
    object-fit: cover;
    border-radius: 3px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  }

  .cover-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    background: #e9e6e1;
    color: #b3aca3;
    font-weight: 600;
    user-select: none;
  }

  .identity {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .title {
    font-style: italic;
    font-size: 1.05rem;
    color: #253237;
    overflow-wrap: anywhere;
  }

  .authors {
    color: #53636a;
    font-size: 0.9rem;
  }

  .badges {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin-top: 0.2rem;
  }

  .badge {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    background: #e9eeee;
    color: #35686a;
  }

  .badge.new {
    background: #fff3d6;
    color: #7a5a1a;
  }

  .forecast {
    flex: 0 0 auto;
    display: flex;
    gap: 1rem;
  }

  .effort, .finish {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    text-align: right;
    min-width: 7rem;
    font-variant-numeric: tabular-nums;
  }

  .value {
    font-weight: 700;
    color: #253237;
  }

  .sub {
    font-size: 0.75rem;
    color: #53636a;
  }

  .toggle {
    flex: 0 0 auto;
    min-height: 44px;
    padding: 0.4rem 0.8rem;
    border: 1px solid #ccd4d4;
    border-radius: 6px;
    background: white;
    color: #1b7179;
    font-weight: 600;
    cursor: pointer;
  }

  .toggle:focus-visible, .details button:focus-visible, .details input:focus-visible {
    outline: 3px solid #1f6f78;
    outline-offset: 2px;
  }

  .details {
    margin-top: 0.75rem;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 0.75rem 1.5rem;
    padding-top: 0.75rem;
    border-top: 1px solid #e2e8e8;
    font-size: 0.9rem;
    color: #253237;
  }

  .details dl {
    margin: 0;
  }

  .details dt {
    font-size: 0.75rem;
    text-transform: uppercase;
    color: #53636a;
    font-weight: 600;
  }

  .details dd {
    margin: 0.1rem 0 0.5rem;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  .actions button {
    min-height: 44px;
    padding: 0.4rem 0.8rem;
    border: 1px solid #ccd4d4;
    border-radius: 6px;
    background: white;
    color: #1b7179;
    font-weight: 600;
    cursor: pointer;
  }

  .actions button.danger {
    color: #b42318;
  }

  .actions button:disabled {
    color: #8a9599;
    cursor: not-allowed;
  }

  .actions input {
    width: 4.5rem;
    min-height: 44px;
    padding: 0.4rem 0.5rem;
    border: 1px solid #ddd;
    border-radius: 4px;
  }

  .divider {
    display: flex;
    align-items: center;
    gap: 1em;
    margin: 1.25rem 0 0.75rem;
    color: #35686a;
    font-size: 0.8em;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }

  .divider::before, .divider::after {
    content: "";
    flex: 1;
    border-top: 1px solid #c9d6d6;
  }

  /* Phones: effort and expected finish move below the title on their own
     row, and the position numeral yields to the handle (its label still
     carries the position). */
  @media (max-width: 720px) {
    .row {
      padding: 0.75rem 0.6rem;
    }

    .main {
      flex-wrap: wrap;
      gap: 0.5rem 0.6rem;
    }

    .index {
      display: none;
    }

    .forecast {
      flex: 1 0 100%;
      justify-content: space-between;
      padding-top: 0.25rem;
      border-top: 1px solid #eef2f2;
    }

    .effort, .finish {
      min-width: 0;
    }

    .effort {
      align-items: flex-start;
      text-align: left;
    }

    .toggle {
      padding: 0.4rem 0.6rem;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .row {
      transition: none;
    }
  }
</style>

<div class="sr-only" aria-live="polite" aria-atomic="true" data-testid="plan-announcement">{announcement}</div>
<p id="reorder-help" class="sr-only">Drag the handle, or press Enter to grab, arrow keys to move, Enter to drop, Escape to cancel.</p>

<ol aria-label="Reading queue">
  {#each rows as row, index (row.id)}
    {@const entry = scheduled.get(row.id)}
    {@const effort = entry?.effort}
    {@const year = dividerBefore(index)}
    {#if year !== null}
      <li class="divider" role="separator" aria-label="Into {year}"><span>{year}</span></li>
    {/if}
    <li
      class="row"
      class:dragging={dragging === row.id}
      class:grabbed={grabbed === row.id}
      class:implicit={row.implicit}
      data-testid="plan-row"
      data-entry-id={row.id}
      use:trackRow={row.id}>
      <div class="main">
      <div class="position">
        <span class="index" aria-hidden="true">{index + 1}</span>
        <button
          type="button"
          class="handle"
          aria-label="Reorder {row.title}, position {index + 1} of {rows.length}"
          aria-describedby="reorder-help"
          aria-pressed={grabbed === row.id}
          use:trackHandle={row.id}
          onkeydown={(event) => handleKey(event, index)}
          onpointerdown={(event) => pointerDown(event, index)}
          onpointermove={pointerMove}
          onpointerup={pointerUp}
          onpointercancel={pointerCancel}>≡</button>
      </div>
      {#if row.coverUrl}
        <img class="cover" src={row.coverUrl} alt="" loading="lazy" referrerpolicy="no-referrer" />
      {:else}
        <div class="cover cover-placeholder" aria-hidden="true">{row.title.slice(0, 1)}</div>
      {/if}
      <div class="identity">
        <span class="title">{row.title}</span>
        {#if row.authors}<span class="authors">{row.authors}</span>{/if}
        <span class="badges">
          <span class="badge">{row.book === null ? 'Planned' : 'Reading'}</span>
          {#if row.implicit}<span class="badge new">New to your plan</span>{/if}
        </span>
      </div>
      <div class="forecast">
        <div class="effort">
          <span class="value">{effort?.remainingMinutes === null || effort === undefined ? 'Unknown effort' : `${formatHours(effort.remainingMinutes)} left`}</span>
          <span class="sub">{effort === undefined ? '' : effortSourceLabel(effort)}</span>
        </div>
        <div class="finish">
          <span class="value">{entry?.finish ? formatMonth(entry.finish) : '—'}</span>
          <span class="sub">Expected finish</span>
        </div>
      </div>
      <button
        type="button"
        class="toggle"
        aria-expanded={expanded[row.id] === true}
        aria-controls="plan-details-{row.id}"
        onclick={() => (expanded[row.id] = !expanded[row.id])}>Details</button>
      </div>
      {#if expanded[row.id]}
        <div class="details" id="plan-details-{row.id}">
          <dl>
            <dt>Expected dates</dt>
            <dd>{dateRange(row.id)}</dd>
            <dt>Pages</dt>
            <dd>
              {#if row.pageCount === null}Page count needed{:else}{Math.max(0, row.pageCount - row.currentPage).toLocaleString('en-US')} of {row.pageCount.toLocaleString('en-US')} left{/if}
            </dd>
            <dt>Pace</dt>
            <dd>
              {#if effort?.minutesPerPage != null}{formatPace(effort.minutesPerPage)} · {effortSourceLabel(effort)}{:else}No pace evidence yet{/if}
              {#if effort?.source === 'manual' && effort.automaticPace !== null}<br /><span class="sub">Automatic: {formatPace(effort.automaticPace.minutesPerPage)}</span>{/if}
            </dd>
            {#if row.timerRunning}<dt>Timer</dt><dd>Running; unsaved progress is not included.</dd>{/if}
          </dl>
          <div class="actions">
            <button type="button" onclick={() => onestimate(row)}>{row.manualMinutesPerPage === null ? 'Set my estimate' : 'Change my estimate'}</button>
            {#if row.book === null}
              <button type="button" onclick={() => onstart(row)}>Start reading</button>
              <button type="button" onclick={() => onedit(row)}>Edit</button>
              <button type="button" class="danger" onclick={() => onremove(row)}>Remove from plan</button>
            {/if}
          </div>
          <div class="actions">
            <button type="button" disabled={index === 0} onclick={() => moveTo(index, index)}>Move up</button>
            <button type="button" disabled={index === rows.length - 1} onclick={() => moveTo(index, index + 2)}>Move down</button>
            <label>
              <span class="sr-only">Position for {row.title}</span>
              <input type="number" inputmode="numeric" min="1" max={rows.length} bind:value={targetPosition[row.id]} placeholder={String(index + 1)} />
            </label>
            <button type="button" onclick={() => moveTo(index, targetPosition[row.id])}>Move to position</button>
          </div>
        </div>
      {/if}
    </li>
  {/each}
</ol>
