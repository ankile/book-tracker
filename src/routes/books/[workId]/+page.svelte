<script lang="ts">
  import { page } from '$app/state';
  import { FirebaseError } from 'firebase/app';
  import { workReaders } from '$lib/firebase/functions.ts';
  import type { WorkReadersResponse } from '$lib/interfaces/catalog.ts';
  import {
    appendDistinctReaderPage,
    createLatestRequestGate,
    displayTrackingCoverage,
    groupReaderAttempts,
  } from '$lib/utils/catalogClient.ts';
  import { formatTime } from '$lib/utils/format.ts';
  import { effectiveLanguage, languageLabel } from '../../../../shared/language.ts';

  let response = $state<WorkReadersResponse | null>(null);
  let loading = $state(true);
  let loadingMore = $state(false);
  let error = $state('');
  let moreError = $state('');
  const requestGate = createLatestRequestGate();
  const readers = $derived(response === null ? [] : groupReaderAttempts(response.attempts));

  $effect(() => {
    const workId = page.params.workId;
    if (!workId) {
      loading = false;
      error = 'This work could not be found.';
      return;
    }
    const requestId = requestGate.begin();
    loading = true;
    error = '';
    moreError = '';
    response = null;
    void workReaders({workId}).then((value) => {
      if (!requestGate.isCurrent(requestId)) return;
      response = value;
      loading = false;
    }).catch((reason) => {
      if (!requestGate.isCurrent(requestId)) return;
      console.error('Work readers failed', reason);
      response = null;
      error = isRateLimited(reason)
        ? 'Too many requests for now — try again in a while.'
        : 'This linked work is unavailable or has not been shared yet.';
      loading = false;
    });
    return () => requestGate.invalidate();
  });

  async function loadMoreReaders(): Promise<void> {
    const workId = page.params.workId;
    const cursor = response?.nextCursor;
    if (!workId || !cursor || loadingMore) return;
    const requestId = requestGate.begin();
    loadingMore = true;
    moreError = '';
    try {
      const next = await workReaders({workId, cursor});
      if (!requestGate.isCurrent(requestId) || response === null ||
          next.work.workId !== response.work.workId) return;
      response = {
        ...next,
        attempts: appendDistinctReaderPage(response.attempts, next.attempts),
        incomplete: response.incomplete || next.incomplete,
        omittedAttempts: response.omittedAttempts + next.omittedAttempts,
      };
    } catch (reason) {
      if (!requestGate.isCurrent(requestId)) return;
      console.error('More work readers failed', reason);
      moreError = isRateLimited(reason)
        ? 'Too many requests for now — try again in a while.'
        : 'More readers could not be loaded. Try again later.';
    } finally {
      if (requestGate.isCurrent(requestId)) loadingMore = false;
    }
  }

  // The reader summary is rate limited per user and across all readers, so a
  // burst of page loads is the one rejection worth naming: the generic
  // message would send the reader looking for a problem with the work.
  function isRateLimited(reason: unknown): boolean {
    return reason instanceof FirebaseError && reason.code === 'functions/resource-exhausted';
  }

  function displayDate(value: string | null): string {
    return value === null
      ? 'Unknown'
      : new Date(`${value}T00:00:00.000Z`).toLocaleDateString(
        'en-US',
        {month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'},
      );
  }

</script>

<svelte:head>
  <title>{response?.work.canonicalTitle ?? 'Linked work'} · Book Tracker</title>
</svelte:head>

<div class="work-page">
  {#if loading}
    <p class="state">Loading linked work…</p>
  {:else if error}
    <div class="state error" role="alert">
      <h1>Linked work</h1>
      <p>{error}</p>
      <a href="/">Back to your books</a>
    </div>
  {:else if response}
    <header class="work-header">
      {#if response.work.coverUrl}
        <img src={response.work.coverUrl} alt="" referrerpolicy="no-referrer" />
      {/if}
      <div>
        <a class="back" href="/">← Your books</a>
        <h1>{response.work.canonicalTitle}</h1>
        <p class="authors">{response.work.authors.map((author) => author.canonicalName).join(', ')}</p>
        {#if response.work.alternateTitles.length > 0}
          <p class="aliases">Also known as {response.work.alternateTitles.join(' · ')}</p>
        {/if}
        {#if response.work.language !== ''}
          <p class="aliases">Language: {languageLabel(response.work.language)}</p>
        {/if}
      </div>
    </header>

    {#if response.editions.length > 0}
      <section aria-labelledby="editions-heading">
        <h2 id="editions-heading">Known editions</h2>
        <div class="edition-list">
          {#each response.editions as edition (edition.editionId)}
            <article class="edition">
              <strong>{edition.title}</strong>
              <span>{[edition.publisher, edition.publishedDate, languageLabel(effectiveLanguage(edition.language, response.work.language))].filter(Boolean).join(' · ')}</span>
              {#if edition.isbn13}<span>ISBN {edition.isbn13}</span>{/if}
              {#if edition.suggestedPageCount}<span>{edition.suggestedPageCount} suggested pages</span>{/if}
              {#if edition.format !== 'unknown'}<span>{edition.format}</span>{/if}
            </article>
          {/each}
        </div>
      </section>
    {/if}

    <section aria-labelledby="readers-heading">
      <h2 id="readers-heading">Readers</h2>
      {#if response.incomplete}
        <p class="partial-note" role="status">
          This is a partial summary. {response.omittedAttempts > 0
            ? `${response.omittedAttempts} opted-in reading ${response.omittedAttempts === 1 ? 'attempt is' : 'attempts are'} not shown.`
            : 'Some reader rows could not be read.'}
        </p>
      {/if}
      {#if readers.length === 0}
        <p class="empty">No readers yet.</p>
      {:else}
        <div class="reader-list">
          {#each readers as reader (reader.readerKey)}
            <article class="reader-card">
              <h3>
                {#if reader.username !== null && reader.displayName !== null}
                  <a href={`/profiles/${encodeURIComponent(reader.username)}`}>{reader.displayName}</a>
                {:else}
                  A reader
                {/if}
              </h3>
              <div class="attempt-list">
                {#each reader.attempts as attempt, index (`${reader.readerKey}:${index}`)}
                  <section class="attempt">
                    <div class="attempt-heading">
                      <strong>{attempt.status === 'finished' ? 'Finished' : 'Reading'}</strong>
                      {#if reader.attempts.length > 1}<span>Attempt {index + 1}</span>{/if}
                    </div>
                    <dl>
                      <div><dt>Reader's page count</dt><dd>{attempt.pageCount.toLocaleString()}</dd></div>
                      <div><dt>First progress</dt><dd>{displayDate(attempt.firstProgressAt)}</dd></div>
                      <div><dt>Finished</dt><dd>{displayDate(attempt.finishedAt)}</dd></div>
                      <div><dt>Calendar span</dt><dd>{attempt.calendarDays === null ? 'Unknown' : `${attempt.calendarDays} days`}</dd></div>
                      <div><dt>Active reading days</dt><dd>{attempt.activeDays}</dd></div>
                      <div><dt>Tracked reading time</dt><dd>{formatTime(Math.round(attempt.trackedMinutes))}</dd></div>
                      <div><dt>Reading sessions</dt><dd>{attempt.sessionCount}</dd></div>
                      <div><dt>Qualified speed</dt><dd>{attempt.qualifiedPagesPerHour === null ? 'Not enough data' : `${attempt.qualifiedPagesPerHour.toFixed(1)} pages/hour`}</dd></div>
                      <div><dt>Edition per tracked hour</dt><dd>{attempt.percentPerHour === null ? 'Not enough data' : `${attempt.percentPerHour.toFixed(1)}%`}</dd></div>
                      <div><dt>Tracking coverage</dt><dd>{displayTrackingCoverage(attempt.trackingCoverage)}</dd></div>
                    </dl>
                  </section>
                {/each}
              </div>
            </article>
          {/each}
        </div>
      {/if}
      {#if response.nextCursor}
        <button class="load-more" type="button" disabled={loadingMore} onclick={() => void loadMoreReaders()}>
          {loadingMore ? 'Loading more readers…' : 'Load more readers'}
        </button>
      {/if}
      {#if moreError}<p class="partial-note" role="alert">{moreError}</p>{/if}
    </section>
  {/if}
</div>

<style>
  .work-page {
    max-width: 1000px;
    margin: 0 auto;
    padding: 2rem 1.25rem 4rem;
    text-align: left;
    color: #263331;
  }

  .work-header {
    display: flex;
    gap: 1.25rem;
    align-items: flex-start;
    margin-bottom: 2.5rem;
  }

  .work-header img {
    width: 110px;
    aspect-ratio: 2 / 3;
    border-radius: 5px;
    object-fit: cover;
    box-shadow: 0 3px 10px rgba(0, 0, 0, 0.2);
  }

  h1 { margin: 0.35rem 0 0.25rem; }
  h2 { margin-top: 2rem; }
  .authors { margin: 0; font-size: 1.1rem; }
  .aliases, .edition span { color: #65716e; font-size: 0.9rem; }
  .partial-note { padding: 0.75rem; border-left: 4px solid #a56712; background: #fff4d9; color: #5f410f; }
  .back { color: #35686a; text-decoration: none; }

  .edition-list, .reader-list, .attempt-list {
    display: grid;
    gap: 0.8rem;
  }

  .edition-list {
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  }

  .edition, .reader-card {
    padding: 1rem;
    border: 1px solid #d9dfdd;
    border-radius: 7px;
    background: #fff;
  }

  .edition { display: flex; flex-direction: column; gap: 0.25rem; }
  .reader-card h3 { margin: 0 0 0.8rem; }
  .reader-card h3 a { color: #24594c; }

  .attempt {
    padding: 0.9rem;
    border-radius: 6px;
    background: #f6f8f7;
  }

  .attempt-heading {
    display: flex;
    justify-content: space-between;
    margin-bottom: 0.7rem;
  }

  dl {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(155px, 1fr));
    gap: 0.7rem;
    margin: 0;
  }

  dl div { min-width: 0; }
  dt { color: #65716e; font-size: 0.78rem; text-transform: uppercase; }
  dd { margin: 0.1rem 0 0; font-variant-numeric: tabular-nums; }
  .state { margin: 4rem auto; text-align: center; }
  .error { max-width: 520px; padding: 1.5rem; border-radius: 7px; background: #f8f1ef; }
  .empty { padding: 1rem; border-radius: 6px; background: #f6f8f7; }
  .load-more { margin-top: 1rem; padding: 0.55rem 0.8rem; border: 1px solid #35686a; border-radius: 5px; background: white; color: #24594c; cursor: pointer; }

  @media (max-width: 520px) {
    .work-header img { width: 78px; }
    .work-page { padding-inline: 0.9rem; }
  }
</style>
