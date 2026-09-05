<script lang="ts">
  import ModalCard from './ModalCard.svelte';
  import { Database } from '../firebase/db.ts';
  import { finishForecast, forecastDate, forecastReadings, type ForecastObservation } from '../utils/finishForecast.ts';
  import { forecastHistoryInput } from '../utils/forecastHistory.ts';
  import { formatTime } from '../utils/format.ts';
  import type { Book } from '../interfaces/book.ts';
  import type { BookUpdate } from '../interfaces/reading.ts';

  let { bookId, userId, onclose }: { bookId: string; userId: string; onclose: () => void } = $props();
  let books = $state<Book[] | undefined>(undefined);
  let updates = $state<BookUpdate[] | undefined>(undefined);
  let now = $state(Date.now());
  $effect(() => {
    books = undefined;
    updates = undefined;
    const stopBooks = Database.getAllBooks(userId).subscribe((value) => (books = value));
    const stopUpdates = Database.getAllReadingSessions(userId).subscribe((value) => (updates = value));
    const timer = setInterval(() => (now = Date.now()), 60_000);
    return () => { stopBooks(); stopUpdates(); clearInterval(timer); };
  });
  const book = $derived(books?.find((candidate) => candidate.id === bookId));
  const readings = $derived(updates === undefined ? [] : forecastReadings(updates));
  let history = $state<ForecastObservation[] | undefined>(undefined);
  let historyError = $state(false);
  // Replaying a large library takes about a second. Keep it off the UI
  // thread, and cancel obsolete work when a session changes or we close.
  $effect(() => {
    history = undefined;
    historyError = false;
    if (books === undefined || updates === undefined) return;
    const worker = new Worker(new URL('../utils/forecast.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<ForecastObservation[]>) => (history = event.data);
    worker.onerror = () => (historyError = true);
    worker.postMessage(forecastHistoryInput(books, updates, Date.now()));
    return () => worker.terminate();
  });
  const forecast = $derived(book === undefined || books === undefined || updates === undefined ? null
    : finishForecast(book, books, readings, now, history ?? []));
  const date = (days: number) => forecastDate(new Date(now), days).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
  const features = $derived(forecast?.features);
</script>

<ModalCard open header="Estimated finish" {onclose}>
  {#if books === undefined || updates === undefined}
    <p role="status">Loading your reading history…</p>
  {:else if book === undefined || book.finished}
    <p>This book is no longer in your currently reading list.</p>
  {:else if forecast !== null}
    <p class="book-title">{book.title}</p>
    {#if forecast.status === 'estimated' && forecast.days !== null}
      <p class="finish-date" data-testid="finish-date">Around {date(forecast.days)}</p>
      <p class="days">{Math.max(1, Math.round(forecast.days))} {Math.max(1, Math.round(forecast.days)) === 1 ? 'day' : 'days'} from now</p>
      {#if historyError}
        <p role="alert">The historical range couldn't be calculated. Close and reopen this estimate to try again.</p>
      {:else if history === undefined}
        <p role="status">Estimating your historical range…</p>
      {:else if forecast.lowerDays !== null && forecast.upperDays !== null}
        <p class="range">Historical range: {date(forecast.lowerDays)} to {date(forecast.upperDays)}</p>
      {:else if forecast.calibrationBooks > 0}
        <p class="range">Your history does not support a reliable upper date. A long break could put this more than a year away.</p>
      {:else}
        <p class="range">There isn't enough history yet to estimate a date range.</p>
      {/if}
      <p>Based on your pace with this book and your overall reading over the last 14 days, including days without reading.</p>
      {#if features && features.activeBooks > 1}
        <p>You've read {features.activeBooks} unfinished books in the last 30 days. Time spent on other books affects this estimate.</p>
      {/if}
      {#if features && features.idleDays >= 7}
        <p>You last read this book {Math.floor(features.idleDays)} days ago, so this estimate is especially uncertain.</p>
      {/if}
    {:else if forecast.status === 'inactive'}
      <p class="finish-date">No reliable finish date yet</p>
      <p>There hasn't been enough recent reading to predict when you'll return to this book. The estimate will update when you read again.</p>
      {#if features && features.resumeRate > 0}
        <p>If you resume your previous pace, the remaining reading would take about {Math.max(1, Math.round(features.remainingMinutes / features.resumeRate))} days after you return.</p>
      {/if}
    {:else if forecast.status === 'beyond-horizon'}
      <p class="finish-date">More than a year at this pace</p>
      <p>Your recent reading pace is too slow to give a useful calendar date. This will update as your reading changes.</p>
    {:else}
      <p class="finish-date">A little more reading first</p>
      <p>Log timed progress on at least two reading days to estimate a finish date.</p>
    {/if}
    {#if features}
      <div class="reading-left">
        <span>Active reading left</span>
        <strong>{book.pagesRead > 0 ? formatTime(Math.round((book.pageCount - book.currentPage) * book.timeRead / book.pagesRead)) : 'NA'}</strong>
      </div>
    {/if}
    <p class="note">An estimate, not a deadline. Reading more, switching books, or taking a break will move the date.</p>
  {/if}
</ModalCard>

<style>
  .book-title { color: #555; margin: 0 0 1rem; }
  .finish-date { font-size: 1.65rem; line-height: 1.2; font-weight: 600; margin-bottom: .4rem; }
  .days { color: #555; margin-bottom: 1.25rem; }
  .range { padding: .75rem; background: #f1f3f5; border-radius: 5px; }
  .reading-left { display: flex; justify-content: space-between; gap: 1rem; border-top: 1px solid #ddd; padding-top: 1rem; margin-top: 1.25rem; }
  .note { font-size: .85rem; color: #555; margin: 1rem 0 0; }
</style>
