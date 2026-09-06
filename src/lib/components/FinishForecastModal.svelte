<script lang="ts">
  import ModalCard from './ModalCard.svelte';
  import { Database } from '../firebase/db.ts';
  import { finishForecast, forecastDate, forecastReadings, selectedForecastDays, multiWindowForecastDays, SELECTED_FORECAST, FORECAST_WINDOWS, FORECAST_RANGE_SCALE } from '../utils/finishForecast.ts';
  import { forecastHistoryInput } from '../utils/forecastHistory.ts';
  import { readingEvidence, type ForecastWorkerResult } from '../utils/forecastDiagnostics.ts';
  import type { Book } from '../interfaces/book.ts';
  import type { BookUpdate } from '../interfaces/reading.ts';

  let { bookId, userId, onclose }: { bookId: string; userId: string; onclose: () => void } = $props();
  let books = $state<Book[] | undefined>(undefined);
  let updates = $state<BookUpdate[] | undefined>(undefined);
  let now = $state(Date.now());
  let minutesPerDay = $state(30);
  let breakDays = $state(0);
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
  let evidence = $state<ForecastWorkerResult | undefined>(undefined);
  let historyError = $state(false);
  // Replaying and scoring a large library must not block the dialog.
  $effect(() => {
    evidence = undefined;
    historyError = false;
    if (books === undefined || updates === undefined) return;
    const worker = new Worker(new URL('../utils/forecast.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<ForecastWorkerResult>) => (evidence = event.data);
    worker.onerror = () => (historyError = true);
    worker.postMessage(forecastHistoryInput(books, updates, Date.now()));
    return () => worker.terminate();
  });
  const forecast = $derived(book === undefined || books === undefined || updates === undefined ? null
    : finishForecast(book, books, readings, now, evidence?.history ?? []));
  const features = $derived(forecast?.features);
  const facts = $derived(book ? readingEvidence(book, readings, now) : null);
  const calibration = $derived(forecast?.calibration);
  const backtest = $derived(evidence?.backtest);
  const effectivePace = $derived(features ? Math.sqrt(features.rates[14].book * features.rates[14].user) : 0);
  const multiWindowDays = $derived(features ? multiWindowForecastDays(features) : Infinity);
  const jumpTo = (id: string) => document.getElementById(id)?.scrollIntoView({ block: 'start' });
  const chartMax = $derived(facts ? Math.max(1, ...facts.days.map((day) => day.book + day.other)) : 1);
  const rawLower = $derived(forecast?.days != null && calibration ? Math.max(1, forecast.days) * calibration.lowerFactor : null);
  const rawUpper = $derived(forecast?.days != null && calibration ? Math.max(1, forecast.days) * calibration.upperFactor : null);
  const scenarioDays = $derived(features ? features.remainingMinutes / minutesPerDay + breakDays : null);
  const listMinutes = $derived(book && book.pagesRead > 0 ? (book.pageCount - book.currentPage) * book.timeRead / book.pagesRead : null);
  const num = (value: number, digits = 1) => value.toLocaleString('en-US', { maximumFractionDigits: digits });
  const dateAt = (at: number) => new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const date = (days: number) => dateAt(forecastDate(new Date(now), days).getTime());
  const duration = (minutes: number) => {
    const rounded = Math.round(minutes);
    return `${Math.floor(rounded / 60)}h ${rounded % 60}m`;
  };
  const prediction = (days: number) => !Number.isFinite(days) ? 'No date at this pace'
    : days > 365 ? 'More than a year' : `${date(days)} · ${num(days)} days`;
  const title = (id: string) => books?.find((row) => row.id === id)?.title ?? 'Book no longer in library';
  const recentUnfinished = $derived(facts?.competing.filter((row) => books?.some((candidate) => candidate.id === row.bookId
    && !candidate.finished && candidate.currentPage < candidate.pageCount)).length ?? 0);
</script>

<ModalCard open wide hideSecondary header="Estimated finish" {onclose}>
  {#if books === undefined || updates === undefined}
    <p role="status">Loading your reading history…</p>
  {:else if book === undefined || book.finished}
    <p>This book is no longer in your currently reading list.</p>
  {:else if forecast !== null && facts}
    <div class="forecast-detail">
      <header class="overview">
        <div>
          <p class="eyebrow">{book.title}</p>
          {#if forecast.status === 'estimated' && forecast.days !== null}
            <h2 data-testid="finish-date">Around {date(forecast.days)}</h2>
            <p class="lead">{num(forecast.days)} calendar days left at your recent pace.</p>
          {:else if forecast.status === 'inactive'}
            <h2>No reliable finish date yet</h2>
            <p class="lead">No reading of this book in the last 14 days. Your return date is unknown.</p>
          {:else if forecast.status === 'beyond-horizon'}
            <h2>More than a year at this pace</h2>
            <p class="lead">The recent pace puts completion beyond the one-year forecast limit.</p>
          {:else}
            <h2>A little more reading first</h2>
            <p class="lead">Log a timed reading session to start estimating a finish date.</p>
          {/if}
        </div>
        <div class="progress-fact">
          <strong>{num(book.currentPage / book.pageCount * 100, 0)}%</strong>
          <span>Page {book.currentPage} of {book.pageCount}</span>
          <progress max={book.pageCount} value={book.currentPage} aria-label="Book progress"></progress>
        </div>
      </header>

      <div class="model-note" data-testid="selected-model">
        <span class="tag">Current model · 14-day blended pace</span>
      </div>
      {#if features && (features.readingDays < 2 || features.speedSource !== 'book')}
        <p class="callout"><strong>Early estimate.</strong> {features.readingDays < 2 ? 'This book has only one recorded reading day. A single session can move the date substantially.' : ''}
          {features.speedSource === 'library' ? 'Reading speed comes from your other recorded reading because this book has too little qualifying page progress.' : features.speedSource === 'default' ? 'Until there is qualifying page progress, reading speed assumes 2 minutes per page.' : ''}</p>
      {/if}
      <nav class="forecast-nav" aria-label="Forecast sections">
        {#each [['uncertainty-heading', 'Date range'], ['calculation-heading', 'Calculation'], ['pace-heading', 'Compare estimates'], ['scenario-heading', 'What if?'], ['backtest-heading', 'Accuracy']] as [id, label]}
          {#if features || id === 'uncertainty-heading' || id === 'backtest-heading'}<button type="button" onclick={() => jumpTo(id)}>{label}</button>{/if}
        {/each}
      </nav>

      <dl class="headline-facts">
        <div><dt>Pages remaining</dt><dd>{book.pageCount - book.currentPage}</dd><small>From your current page</small></div>
        <div><dt>Active reading left</dt><dd>{features ? duration(features.remainingMinutes) : 'Not enough data'}</dd><small>{features ? `${num(features.remainingMinutes)} minutes in the forecast` : 'Needs timed page progress'}</small></div>
        <div><dt>Forecast reading budget</dt><dd>{features ? `${num(effectivePace)} min/day` : 'Not enough data'}</dd><small>Includes days with no reading</small></div>
        <div><dt>Last read</dt><dd>{facts.lastAt === null ? 'No sessions' : dateAt(facts.lastAt)}</dd><small>{features ? `${num(features.idleDays)} days ago` : 'Logged sessions only'}</small></div>
      </dl>

      <section class="uncertainty" aria-labelledby="uncertainty-heading">
        <div class="section-heading"><h3 id="uncertainty-heading">How uncertain is the date?</h3><span class="tag">Empirical uncertainty</span></div>
        {#if historyError}
          <p role="alert">Historical analysis couldn't be calculated. Close and reopen this estimate to try again. The pace calculation is still available below.</p>
        {:else if evidence === undefined}
          <p role="status">Replaying your past forecasts and checking their errors…</p>
        {:else if forecast.status !== 'estimated'}
          <p>A date range needs a usable point forecast first. {forecast.status === 'inactive' ? 'There is no estimate of when you will resume; the scenarios below start on the date you choose.' : 'Your reading facts and the available pace scenarios are below.'}</p>
        {:else if !calibration}
          <p>There isn't enough history yet to estimate a date range.</p>
          <p class="muted">At least 12 other books with usable historical forecasts in a similar pause state are required.</p>
        {:else}
          <div class="range-values" data-testid="uncertainty-range">
            <div><span>Earlier end</span><strong>{forecast.lowerDays !== null ? date(forecast.lowerDays) : 'Not established'}</strong><small>{forecast.lowerDays !== null ? `${num(forecast.lowerDays)} days away` : 'Insufficient evidence'}</small></div>
            <div class="point"><span>Point estimate</span><strong>{date(forecast.days!)}</strong><small>{num(forecast.days!)} days away</small></div>
            <div><span>Later end</span><strong>{forecast.upperDays !== null ? date(forecast.upperDays) : 'No upper date within a year'}</strong><small>{forecast.upperDays !== null ? `${num(forecast.upperDays)} days away` : 'Long pauses leave the tail unresolved'}</small></div>
          </div>
          <p>This span applies your other books' historical errors, widened to allow for larger misses. Pausing or switching books can move the date. <strong>This is an empirical range, not a calibrated 80% probability.</strong></p>
          <div class="two-columns range-detail">
            <div>
              <h4>Where the bounds come from</h4>
              <dl class="rows">
                <div><dt>Historical 10th–90th error factors</dt><dd>{num(calibration.lowerFactor, 2)}× to {Number.isFinite(calibration.upperFactor) ? `${num(calibration.upperFactor, 2)}×` : 'unresolved'}</dd></div>
                <div><dt>Before widening</dt><dd>{rawLower !== null && Number.isFinite(rawLower) ? `${num(rawLower)} days` : 'Unknown'} to {rawUpper !== null && Number.isFinite(rawUpper) ? `${num(rawUpper)} days` : 'unknown'}</dd></div>
                <div><dt>Widening chosen in validation</dt><dd>Lower ÷ {FORECAST_RANGE_SCALE}, upper × {FORECAST_RANGE_SCALE}</dd></div>
              </dl>
              <p class="small">A 2× error factor means a book took twice as long as predicted. The factors multiply at least one predicted day; the final span also includes the point estimate.</p>
            </div>
            <div>
              <h4>The evidence for this range</h4>
              <dl class="rows">
                <div><dt>Other books / forecast checkpoints</dt><dd>{calibration.books} / {num(calibration.checkpoints, 0)}</dd></div>
                <div><dt>Known completions / still unfinished</dt><dd>{calibration.completedBooks} / {calibration.books - calibration.completedBooks} books</dd></div>
                <div><dt>Completed / censored checkpoints</dt><dd>{num(calibration.completedCheckpoints, 0)} / {num(calibration.checkpoints - calibration.completedCheckpoints, 0)}</dd></div>
                <div><dt>Pause state used</dt><dd>{features && features.idleDays > 7 ? 'Over 7 days since reading' : 'Read within 7 days'}</dd></div>
              </dl>
              <p class="small">Checkpoints: {dateAt(calibration.firstAt)} to {dateAt(calibration.lastAt)}. Each book has equal total weight. Unfinished books contribute a minimum elapsed wait, not a made-up completion date. This book is excluded.</p>
            </div>
          </div>
        {/if}
      </section>

      {#if features}
        <section aria-labelledby="calculation-heading">
          <div class="section-heading"><h3 id="calculation-heading">How the estimate is calculated</h3><span class="tag">14-day blended pace</span></div>
          <div class="calculation" data-testid="forecast-calculation">
            <div><span>Reading still needed</span><strong>{num(features.remainingPages)} pages × {num(features.remainingMinutes / features.remainingPages, 2)} min/page</strong><small>= {num(features.remainingMinutes)} minutes</small></div>
            <div><span>Daily budget</span><strong>√({num(features.rates[14].book)} × {num(features.rates[14].user)})</strong><small>= {num(effectivePace)} minutes/day</small></div>
            <div><span>Calendar time left</span><strong>{num(features.remainingMinutes)} ÷ {num(effectivePace)}</strong><small>= {effectivePace > 0 ? `${num(features.remainingMinutes / effectivePace)} days` : 'no finite date'}</small></div>
          </div>
          <p class="small">The budget is the geometric mean of this book's {num(features.rates[14].book)} min/day and your overall {num(features.rates[14].user)} min/day. This book's rate uses {num(Math.min(14, features.ageDays))} elapsed days since its first session (up to 14); your overall rate uses the full 14 days. Days without reading count in both rates.</p>
          <p class="small">{features.speedSource === 'book' ? `Reading speed uses ${facts.speedSessions} of ${facts.sessions} sessions: ${num(facts.speedPages)} pages in ${duration(facts.speedMinutes)}.` : features.speedSource === 'library' ? 'Reading speed uses qualifying sessions across your library until this book has enough page progress.' : 'Reading speed uses an initial assumption of 2 minutes per page until qualifying progress is available.'} Sessions shorter than 5 minutes or faster than 150 pages/hour are excluded from speed, but still count toward the daily budget. Page corrections change remaining progress without adding reading time.</p>
          {#if listMinutes !== null && Math.abs(listMinutes - features.remainingMinutes) >= 1}
            <p class="callout">The Currently reading list shows {duration(listMinutes)} left using aggregate speed. This forecast uses {duration(features.remainingMinutes)} after the session filters above.</p>
          {/if}
        </section>
      {/if}

      <section aria-labelledby="activity-heading">
        <div class="section-heading"><h3 id="activity-heading">Your recent reading</h3><span class="muted">Last 14 × 24 hours</span></div>
        <div class="chart-summary"><span><i class="swatch own"></i>This book: <strong>{duration(facts.days.reduce((sum, day) => sum + day.book, 0))}</strong></span><span><i class="swatch other"></i>Other books: <strong>{duration(facts.days.reduce((sum, day) => sum + day.other, 0))}</strong></span><span><strong>{14 - facts.readingDays14}</strong> days without any reading</span></div>
        <div class="activity-chart" role="img" aria-label={`Reading in fourteen 24-hour periods: this book on ${facts.bookReadingDays14} days, any book on ${facts.readingDays14} days. Tallest bar ${num(chartMax)} minutes. Exact values follow in the daily totals table.`}>
          {#each facts.days as day, i}
            <div class="day-column" title={`${dateAt(day.end)}: ${num(day.book)} minutes this book; ${num(day.other)} minutes other books`}>
              <span class="bar-total">{num(day.book + day.other, 0)}</span>
              <div class="bar-space"><div class="bar other" style:height={`${day.other / chartMax * 100}%`}></div><div class="bar own" style:height={`${day.book / chartMax * 100}%`}></div></div>
              <span class="day-label">{i === 0 || i === 6 || i === 13 ? new Date(day.end).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '·'}</span>
            </div>
          {/each}
        </div>
        <p class="small">Bar labels are minutes. These are rolling 24-hour periods ending at {new Date(now).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}, not midnight-to-midnight calendar days.</p>
        <details><summary>Daily totals and session facts</summary>
          <div class="two-columns">
            <div class="table-scroll"><table><caption>Daily minutes, by period end</caption><thead><tr><th>Period ends</th><th>This book</th><th>Other books</th></tr></thead><tbody>{#each facts.days as day}<tr><th scope="row">{dateAt(day.end)}</th><td>{num(day.book)}</td><td>{num(day.other)}</td></tr>{/each}</tbody></table></div>
            <dl class="rows">
              <div><dt>First session</dt><dd>{facts.firstAt === null ? 'None' : dateAt(facts.firstAt)}</dd></div>
              <div><dt>Timed sessions used for activity</dt><dd>{facts.sessions}</dd></div>
              <div><dt>Reading days for this book, last 14</dt><dd>{facts.bookReadingDays14}</dd></div>
              <div><dt>Total logged reading time</dt><dd>{duration(book.timeRead)}</dd></div>
              <div><dt>Total logged pages</dt><dd>{book.pagesRead}</dd></div>
              <div><dt>Page corrections</dt><dd>{updates.filter((row) => row.book.id === bookId && row.type === 'update' && row.createdAt.toDate().getTime() <= now).length}</dd></div>
            </dl>
          </div>
        </details>
      </section>

      {#if features}
        <section aria-labelledby="pace-heading">
          <h3 id="pace-heading">Compare the leading estimates</h3>
          <div class="model-comparison" data-testid="model-comparison">
            <div class="chosen-model"><span class="tag">Used for your forecast</span><h4>Recent 14-day pace</h4><strong>{prediction(selectedForecastDays(features))}</strong><p>Responds to your current routine. Starts estimating on the first reading day.</p></div>
            <div><span class="tag">Comparison</span><h4>Multi-window pace</h4><strong>{prediction(multiWindowDays)}</strong><p>Median of estimates from 7, 14, 30 and 60 days. Balances your recent pace with longer reading patterns.</p></div>
          </div>
          <p class="muted">Same remaining reading time, different views of your habits. These are conditional estimates, not lower and upper uncertainty bounds.</p>
          <div class="table-scroll"><table data-testid="pace-comparison"><caption>All rates are minutes per calendar day</caption><thead><tr><th>Lookback</th><th>This book</th><th>All books</th><th>This book's share</th><th>At this book's pace</th><th>At blended pace</th></tr></thead><tbody>
            {#each FORECAST_WINDOWS as window}
              {@const rate = features.rates[window]}
              <tr class:selected={window === 14}><th scope="row">{window} days{window === 14 ? ' · selected' : ''}</th><td>{num(rate.book)}</td><td>{num(rate.user)}</td><td>{num(rate.share * 100, 0)}%</td><td>{prediction(features.remainingMinutes / rate.book)}</td><td>{prediction(features.remainingMinutes / Math.sqrt(rate.book * rate.user))}</td></tr>
            {/each}
          </tbody></table></div>
          <p class="small">New books use elapsed days since starting, with a one-day minimum. Share uses total minutes in the full window, so it can differ from the ratio of daily rates.</p>
        </section>

        <section class="scenario" aria-labelledby="scenario-heading">
          <h3 id="scenario-heading">What if you change your routine?</h3>
          <p>Set time specifically for this book. This calculation assumes the same page speed, then adds any break before you resume.</p>
          <div class="scenario-controls">
            <label>Reading per day <strong>{minutesPerDay} min</strong><input type="range" min="5" max="180" step="5" bind:value={minutesPerDay} aria-label="Minutes per day for this book" /></label>
            <label>Break before resuming <strong>{breakDays} days</strong><input type="range" min="0" max="90" step="1" bind:value={breakDays} aria-label="Days before resuming this book" /></label>
            <output data-testid="scenario-date"><span>At that routine</span><strong>{scenarioDays !== null ? prediction(scenarioDays) : 'Not enough data'}</strong></output>
          </div>
          <div class="scenario-presets">{#each [15, 30, 60] as minutes}<button type="button" class:chosen={minutesPerDay === minutes} onclick={() => (minutesPerDay = minutes)}>{minutes} min/day</button>{/each}</div>
          {#if features.resumeRate > 0}<p class="small">At the pace in the 14 days leading up to your last session ({num(features.resumeRate)} min/day), you would need {num(features.remainingMinutes / features.resumeRate)} days <strong>after resuming</strong>. This does not predict the return date.</p>{/if}
          <p class="small">Scenario dates are arithmetic, without an uncertainty range. They do not change the forecast or save a reading goal.</p>
        </section>
      {/if}

      {#if facts.competing.length > 0}
        <section aria-labelledby="parallel-heading">
          <h3 id="parallel-heading">Where your reading time went</h3>
          <p class="muted">{recentUnfinished} unfinished books read in the last 30 days. Finished books still count toward your recent overall reading budget.</p>
          <div class="table-scroll"><table><caption>Books read in the last 30 days</caption><thead><tr><th>Book</th><th>Status</th><th>Last 14 days</th><th>Last 30 days</th><th>Last read</th></tr></thead><tbody>{#each facts.competing as row}<tr class:selected={row.bookId === bookId}><th scope="row">{title(row.bookId)}{row.bookId === bookId ? ' · this book' : ''}</th><td>{books.find((candidate) => candidate.id === row.bookId)?.finished ? 'Finished' : 'Unfinished'}</td><td>{duration(row.minutes14)}</td><td>{duration(row.minutes30)}</td><td>{dateAt(row.lastAt)}</td></tr>{/each}</tbody></table></div>
          <p class="small">Each book has an individual pace forecast; these dates do not allocate a shared future reading schedule.</p>
        </section>
      {/if}

      <section aria-labelledby="backtest-heading">
        <div class="section-heading"><h3 id="backtest-heading">How this model did on your history</h3><span class="tag">Forecasts made from Jan 1, 2025</span></div>
        <p class="muted">Your library: {books.filter((row) => row.finished).length} finished books, {books.filter((row) => !row.finished).length} unfinished books, and {num(readings.filter((row) => row.at <= now).length, 0)} timed sessions. Only reconstructable, eligible checkpoints enter the scores below.</p>
        {#if historyError}
          <p>Historical results are unavailable. Close and reopen this estimate to try again.</p>
        {:else if !backtest}
          <p role="status">Calculating historical accuracy…</p>
        {:else if !backtest.overall}
          <p>There are no scorable forecasts in this evaluation period yet. Each forecast needs at least 90 days of follow-up.</p>
        {:else}
          <p>One forecast per open book every day at 00:00 UTC, using only the progress and reading available then. Each book has equal weight. Pauses, first-day estimates and currently unfinished books stay in the comparison.</p>
          <div class="table-scroll"><table data-testid="model-leaderboard"><caption>Leading models and earlier versions, on the same daily forecasts</caption><thead><tr><th>Model</th><th>All history</th><th>Since Jan 2025</th></tr></thead><tbody>
            {#each [{ name: 'Recent 14-day pace · current', key: 'selected' }, { name: 'Multi-window pace', key: 'multiWindow' }, { name: 'Earlier 14-day model · required two days', key: 'previous' }, { name: 'Original 30-day overall pace', key: 'baseline' }] as model}
              <tr class:selected={model.key === 'selected'}><th scope="row">{model.name}</th><td>{backtest.fullHistory ? `${num(backtest.fullHistory[model.key as 'selected' | 'multiWindow' | 'previous' | 'baseline'], 2)} days` : 'Not enough data'}</td><td>{num(backtest.overall[model.key as 'selected' | 'multiWindow' | 'previous' | 'baseline'], 2)} days</td></tr>
            {/each}
          </tbody></table></div>
          <p class="small">{backtest.fullHistory ? `${backtest.fullHistory.books} books and ${num(backtest.fullHistory.checkpoints, 0)} daily forecasts across all history` : 'Full-history results unavailable'}; {backtest.overall.books} books and {num(backtest.overall.checkpoints, 0)} daily forecasts since Jan 2025. Only forecasts with 90 days of follow-up are included in either column.</p>
          <p class="small">Chosen for recent-history performance; multi-window pace led over all history. Results are recomputed for your library. Repeated model comparisons used these periods, so this is not an untouched test. Model: {SELECTED_FORECAST.name}.</p>
          <dl class="headline-facts backtest-facts">
            <div><dt>Average error, capped at 90 days</dt><dd>{num(backtest.overall.selected)} days</dd><small>Selected 14-day blend</small></div>
            <div><dt>Earlier model's error</dt><dd>{num(backtest.overall.previous)} days</dd><small>14-day pace with two-day requirement</small></div>
            <div><dt>Evaluation sample</dt><dd>{backtest.overall.books} books</dd><small>{num(backtest.overall.checkpoints, 0)} forecast checkpoints</small></div>
            <div><dt>Forecasts within one year</dt><dd>{num(backtest.overall.dateRate * 100, 0)}%</dd><small>Book-weighted; dates withheld otherwise</small></div>
          </dl>
          <div class="table-scroll"><table><caption>Mean absolute error in remaining days, capped at 90</caption><thead><tr><th>Reading pattern</th><th>Current model</th><th>Earlier 14-day model</th><th>Books / forecasts</th></tr></thead><tbody>
            {#each [{ name: 'All forecasts', score: backtest.overall }, { name: 'Read within 7 days', score: backtest.active }, { name: 'Idle for more than 7 days', score: backtest.quiet }, { name: 'Multiple active books', score: backtest.parallel }] as row}
              {#if row.score}<tr><th scope="row">{row.name}</th><td>{num(row.score.selected)} days</td><td>{num(row.score.previous)} days</td><td>{row.score.books} / {row.score.checkpoints}</td></tr>{/if}
            {/each}
          </tbody></table></div>
          <p class="small">The score caps both predicted and actual remaining time at 90 days, then averages absolute errors within each book and across books. Long-unfinished books count once they have 90 days of follow-up. {backtest.pending} newer checkpoints are not yet scorable. This is not a ±{num(backtest.overall.selected)}-day confidence interval for this book.</p>
          {#if backtest.cappedCoverage !== null && backtest.intervalScore !== null && backtest.intervalWidth !== null}
            <div class="callout"><strong>Range coverage on the 90-day horizon: {num(backtest.cappedCoverage * 100)}%.</strong> {num(backtest.cappedIntervalCheckpoints, 0)} calibrated daily forecasts; mean width {num(backtest.intervalWidth)} days; interval score {num(backtest.intervalScore)} days. Lower scores reward narrow ranges and penalize misses. Unfinished outcomes and bounds beyond 90 days count at 90, without implying completion.</div>
          {/if}
          {#if backtest.uncappedError !== null}<p class="small">Uncapped mean book error: <strong>{num(backtest.uncappedError)} days</strong> across {backtest.completedCheckpoints} forecasts of {backtest.completedBooks} completed books. Only issued dates within one year count; unfinished outcomes are excluded.</p>{/if}
          {#if backtest.coverage !== null && backtest.finiteUpperRate !== null}
            <p class="small">Uncapped coverage among completed books: {num(backtest.coverage * 100)}%, across {backtest.intervalCheckpoints} forecasts of {backtest.intervalBooks} books. {num(backtest.finiteUpperRate * 100)}% of evaluable ranges have a finite upper date within one year. Open-ended ranges make coverage easier.</p>
          {/if}
          {#if backtest.worst.length > 0}
            <details><summary>Largest misses and evaluation limitations</summary>
              <div class="table-scroll"><table><caption>Largest absolute miss per book, among completed books with a forecast within one year</caption><thead><tr><th>Book / forecast made</th><th>Predicted remaining</th><th>Actual remaining</th><th>Miss</th></tr></thead><tbody>{#each backtest.worst as row}<tr><th scope="row">{title(row.bookId)}<small>{dateAt(row.at)}</small></th><td>{num(row.predictedDays)} days</td><td>{num(row.actualDays)} days</td><td>{num(row.error)} days</td></tr>{/each}</tbody></table></div>
              <p class="small">Range widening minimizes interval score on mature 2024 forecasts. Books read together share circumstances. Page counts are assumed fixed; deleted sessions and earlier edits are unavailable. Completion labels need corroborating progress. Future decisions to pause remain unknown.</p>
            </details>
          {/if}
        {/if}
      </section>
      <p class="updated">As of {dateAt(now)}, {new Date(now).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}. Dates use your local time zone. Estimates update with logged progress and elapsed time.</p>
    </div>
  {/if}
</ModalCard>

<style>
  .forecast-detail { color: #253237; font-size: .9rem; line-height: 1.5; text-align: left; }
  p { margin: .65rem 0; }
  h2 { font-size: clamp(1.6rem, 4vw, 2.1rem); font-weight: 650; line-height: 1.2; margin: .25rem 0 .5rem; }
  h3 { font-size: 1.12rem; font-weight: 650; margin: 0; }
  h4 { font-size: .95rem; font-weight: 650; margin: 0 0 .5rem; }
  section { margin-top: 1.75rem; padding-top: 1.5rem; border-top: 1px solid #dde4e5; }
  .overview { display: flex; align-items: center; justify-content: space-between; gap: 1.5rem; }
  .eyebrow { font-size: 1rem; font-weight: 600; color: #176c74; margin: 0; }
  .lead { color: #53636a; margin-bottom: 0; }
  .model-note { margin-top: 1rem; }
  .forecast-nav { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: 1rem; }
  .forecast-nav button { border: 1px solid #b3caca; border-radius: 5px; background: white; color: #176c74; padding: .5rem .75rem; font-size: .8rem; }
  h3 { scroll-margin-top: 5rem; }
  .model-comparison { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 1rem; }
  .model-comparison > div { padding: 1rem; border: 1px solid #cbd8d9; border-radius: 6px; }
  .model-comparison .chosen-model { border-color: #1b7179; background: #f0f7f6; }
  .model-comparison h4 { margin: .75rem 0 .4rem; }
  .model-comparison p { font-size: .8rem; color: #53636a; margin-bottom: 0; }
  .progress-fact { display: grid; min-width: 170px; gap: .2rem; font-size: .8rem; color: #53636a; }
  .progress-fact strong { font-size: 1.5rem; color: #253237; }
  progress { width: 100%; height: 6px; accent-color: #1b7179; }
  .headline-facts { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin: 1.5rem 0 0; }
  .headline-facts > div { padding: .9rem; border: 1px solid #dde4e5; border-radius: 7px; }
  dt { font-weight: 400; font-size: .8rem; color: #53636a; }
  dd { margin: .3rem 0; font-size: 1.08rem; font-weight: 650; font-variant-numeric: tabular-nums; }
  small, .small { display: block; color: #53636a; font-size: .78rem; line-height: 1.55; }
  .muted { color: #53636a; font-size: .85rem; }
  .section-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: .5rem; margin-bottom: .75rem; }
  .tag { color: #365b60; background: #eaf2f2; border-radius: 4px; padding: .2rem .5rem; font-size: .72rem; }
  .uncertainty, .scenario { padding: 1.25rem; background: #f5f8f8; border: 1px solid #d8e3e3; border-radius: 8px; }
  .range-values { display: grid; grid-template-columns: 1fr 1fr 1fr; margin: 1rem 0; border: 1px solid #cbd8d9; background: white; border-radius: 6px; }
  .range-values > div { padding: .85rem; display: grid; gap: .2rem; align-content: start; }
  .range-values span { font-size: .78rem; color: #53636a; }
  .range-values strong { font-size: 1.02rem; }
  .range-values .point { border-inline: 1px solid #cbd8d9; background: #eaf3f3; }
  .two-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
  .two-columns > div { min-width: 0; }
  .range-detail { margin-top: 1.25rem; padding-top: 1rem; border-top: 1px solid #d8e3e3; }
  .rows { margin: 0; }
  .rows > div { display: flex; justify-content: space-between; gap: 1rem; padding: .45rem 0; border-bottom: 1px solid #dfe6e6; }
  .rows dd { font-size: .8rem; text-align: right; margin: 0; }
  .calculation { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 1rem; }
  .calculation > div { background: #f5f8f8; padding: .8rem; border-radius: 6px; display: grid; gap: .4rem; }
  .calculation span { font-size: .8rem; color: #53636a; }
  .calculation strong { font-size: .9rem; }
  .chart-summary { display: flex; flex-wrap: wrap; gap: .5rem 1.5rem; font-size: .8rem; }
  .swatch { display: inline-block; width: .65rem; height: .65rem; border-radius: 2px; margin-right: .35rem; }
  .own { background: #1b7179; }
  .other { background: #acbfc3; }
  .activity-chart { display: flex; gap: .6rem; margin-top: 1rem; }
  .day-column { flex: 1; min-width: 0; text-align: center; }
  .bar-space { height: 100px; display: flex; flex-direction: column; justify-content: flex-end; border-bottom: 1px solid #a9b9bb; }
  .bar { flex-shrink: 0; }
  .bar-total, .day-label { display: block; font-size: .68rem; color: #53636a; white-space: nowrap; }
  .day-label { padding-top: .3rem; }
  .table-scroll { overflow-x: auto; margin: .75rem 0; }
  table { width: 100%; border-collapse: collapse; font-size: .8rem; font-variant-numeric: tabular-nums; }
  caption { caption-side: top; color: #53636a; font-size: .75rem; padding: 0 0 .4rem; }
  th, td { text-align: left; padding: .65rem .7rem; border-bottom: 1px solid #dfe6e6; vertical-align: top; }
  thead th { font-size: .74rem; color: #53636a; font-weight: 600; background: #f5f8f8; }
  tbody th { font-weight: 500; min-width: 100px; }
  td { min-width: 85px; }
  tr.selected { background: #ecf5f4; }
  .scenario-controls { display: grid; grid-template-columns: 1fr 1fr 1.2fr; gap: 1.5rem; margin: 1rem 0 .5rem; }
  label { font-size: .8rem; display: block; }
  label strong { float: right; }
  input[type='range'] { width: 100%; margin-top: .75rem; accent-color: #1b7179; }
  output { padding: .7rem; border-radius: 5px; background: white; display: grid; gap: .25rem; font-size: .88rem; }
  output span { color: #53636a; font-size: .75rem; }
  .scenario-presets { display: flex; gap: .5rem; }
  .scenario-presets button { font-size: .8rem; background: white; color: #365b60; border: 1px solid #b3caca; border-radius: 5px; padding: .4rem .7rem; }
  .scenario-presets button.chosen { background: #1b7179; color: white; border-color: #1b7179; }
  button:focus-visible, input:focus-visible, summary:focus-visible { outline: 3px solid #1b7179; outline-offset: 3px; }
  details { margin-top: 1rem; }
  summary { cursor: pointer; color: #176c74; font-weight: 500; font-size: .84rem; padding: .5rem 0; }
  .callout { font-size: .82rem; padding: .9rem 1rem; border-left: 3px solid #879fa3; background: #f3f6f6; margin-top: 1rem; }
  .updated { color: #53636a; font-size: .75rem; margin: 1.5rem 0 0; }
  @media (max-width: 760px) {
    .headline-facts { grid-template-columns: 1fr 1fr; gap: .6rem; }
    .two-columns, .scenario-controls, .model-comparison { grid-template-columns: 1fr; gap: 1rem; }
    .progress-fact { min-width: 120px; }
    .calculation { grid-template-columns: 1fr; gap: .5rem; }
  }
  @media (max-width: 480px) {
    .overview { display: block; }
    .progress-fact { margin-top: 1rem; }
    .progress-fact strong { display: none; }
    .headline-facts > div { padding: .65rem; }
    .headline-facts dd { font-size: 1rem; }
    .uncertainty, .scenario { padding: .8rem; }
    .range-values { grid-template-columns: 1fr; }
    .range-values > div { padding: .6rem .75rem; }
    .range-values .point { border-inline: 0; border-block: 1px solid #cbd8d9; }
    .activity-chart { gap: .25rem; }
    .bar-total, .day-label { font-size: .59rem; }
    .bar-space { height: 75px; }
  }
</style>
