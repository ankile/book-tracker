<script lang="ts">
  import '$lib/components/admin/admin.css';
  import { page } from '$app/state';
  import CatalogHeader from '$lib/components/admin/CatalogHeader.svelte';
  import CatalogLoading from '$lib/components/admin/CatalogLoading.svelte';
  import CatalogOperationDialog from '$lib/components/admin/CatalogOperationDialog.svelte';
  import ReviewAction from '$lib/components/admin/ReviewAction.svelte';
  import { adminAccountEmails, adminCatalogProgress, adminCatalogScan } from '$lib/firebase/adminCatalog.ts';
  import { effectiveLanguage, languageLabel } from '../../../../../shared/language.ts';
  import {
    authorNamesById,
    bookKey,
    booksByWork,
    catalogAuthorNames,
    createEditionDraft,
    creatorLabel,
    duplicateFindingsFor,
    editEditionDraft,
    editWorkDraft,
    hideWorkDraft,
    isoDay,
    reviewLabel,
    reviewStatus,
    linkBooksDraft,
    mergeEditionsDraft,
    mergeIntoOldestDraft,
    mergeWorksDraft,
    repointIsbnDraft,
    type OperationDraft,
  } from '$lib/utils/adminCatalogView.ts';

  // One work: its record, its editions, the readers' books that resolve
  // to it, and every operation that starts from it. The scan is the same
  // live store the overview renders, so the page is current the moment it
  // opens and updates as writes land.
  const scan = $derived($adminCatalogScan ?? null);
  const emails = $derived($adminAccountEmails ?? new Map<string, string>());
  const progress = $derived($adminCatalogProgress);
  const workId = $derived(page.params.workId ?? '');

  let draft = $state<OperationDraft | null>(null);
  let statusMessage = $state('');
  let statusOk = $state(true);
  function report(message: string, ok: boolean): void {
    statusMessage = message;
    statusOk = ok;
  }

  const work = $derived(scan?.works.find((row) => row.workId === workId) ?? null);
  const names = $derived(authorNamesById(scan ?? {authors: []}));
  const workById = $derived(new Map((scan?.works ?? []).map((row) => [row.workId, row])));
  const authors = $derived((work?.authorIds ?? []).map((id) => ({
    id,
    name: names.get(id) ?? null,
  })));
  const allEditions = $derived((scan?.editions ?? []).filter((edition) => edition.workId === workId));
  const editions = $derived(allEditions.filter((edition) => edition.status === 'active'));
  const absorbedEditions = $derived(allEditions.filter((edition) => edition.status === 'merged'));
  const editionById = $derived(new Map(allEditions.map((edition) => [edition.editionId, edition])));
  const books = $derived(booksByWork(scan ?? {works: [], books: []}).get(workId) ?? []);
  const duplicates = $derived(duplicateFindingsFor(scan ?? {findings: []}, workId));

  function mergeDuplicates(ids: readonly string[]): void {
    draft = mergeIntoOldestDraft(ids.flatMap((id) => {
      const row = workById.get(id);
      return row === undefined ? [] : [row];
    }));
  }
</script>

<svelte:head><title>{work?.canonicalTitle ?? 'Work'} · Catalog · Book Tracker</title></svelte:head>

<main class="admin-console">
  <CatalogHeader crumbs={[{label: 'Works', href: '/admin'}, {label: work?.canonicalTitle ?? workId}]} {scan} {progress} />
  {#if statusMessage}<div class="notice {statusOk ? 'success' : 'error'}" role="status">{statusMessage}</div>{/if}

  {#if scan === null}
    <CatalogLoading {progress} />
  {:else if work === null}
    <section class="card">
      <h1>Work not found</h1>
      <p>No work <code>{workId}</code> is in the catalog. <a href="/admin">Back to the catalog</a>.</p>
    </section>
  {:else}
    <section class="card">
      <div class="entity-head">
        {#if work.coverUrl}<img src={work.coverUrl} alt="" referrerpolicy="no-referrer" />{:else}<div class="no-cover"></div>{/if}
        <div>
          <h1>{work.canonicalTitle}</h1>
          <p class="byline">
            {#each authors as author, index (author.id)}{#if index > 0}, {/if}<a href="/admin/authors/{author.id}">{author.name ?? `[Missing ${author.id}]`}</a>{:else}No authors{/each}
          </p>
          <p class="meta">
            <span class="status {work.status}">{work.status}</span>
            <span class="review {reviewStatus(work)}">{reviewLabel(work)}</span>
            <span>Created {isoDay(work.createdAt)} by {creatorLabel(work.createdBy, emails)}</span>
            <code>{work.workId}</code>
          </p>
          {#if work.warnings.length > 0}<p class="warning">{work.warnings.join(' · ')}</p>{/if}
        </div>
        <div class="actions">
          <ReviewAction kind="work" ids={[work.workId]} reviewed={reviewStatus(work) !== 'done'} primary={reviewStatus(work) !== 'done'}
            label={reviewStatus(work) === 'done' ? 'Mark unreviewed' : 'Mark reviewed'} onresult={report} />
          <button type="button" onclick={() => (draft = editWorkDraft(work))}>Edit work…</button>
          {#if work.status === 'active'}<button type="button" onclick={() => (draft = hideWorkDraft(work))}>Hide…</button>{/if}
          {#if work.status !== 'merged'}<button type="button" onclick={() => (draft = mergeWorksDraft([work.workId], ''))}>Merge into another work…</button>{/if}
          <button type="button" onclick={() => (draft = createEditionDraft(work))}>New edition…</button>
        </div>
      </div>
      <dl class="facts">
        <div><dt>Alternate titles</dt><dd>{work.alternateTitles.join(' · ') || '—'}</dd></div>
        <div><dt>Subjects</dt><dd>{work.subjects.join(' · ') || '—'}</dd></div>
        <div><dt>Fiction</dt><dd>{work.fiction === null ? 'Unknown' : work.fiction ? 'Fiction' : 'Nonfiction'}</dd></div>
        <div><dt>Language</dt><dd>{work.language === '' ? '—' : `${languageLabel(work.language)} (${work.language})`}</dd></div>
        <div><dt>Merged into</dt><dd>{#if work.mergedInto}<a href="/admin/works/{work.mergedInto}">{workById.get(work.mergedInto)?.canonicalTitle ?? work.mergedInto}</a>{:else}—{/if}</dd></div>
        <div><dt>Absorbed works</dt><dd>{#each work.mergedFrom as id, index (id)}{#if index > 0}, {/if}<a href="/admin/works/{id}">{workById.get(id)?.canonicalTitle ?? id}</a>{:else}—{/each}</dd></div>
        <div><dt>Cover URL</dt><dd>{#if work.coverUrl}<a href={work.coverUrl} rel="noreferrer">{work.coverUrl}</a>{:else}—{/if}</dd></div>
      </dl>
    </section>

    {#if duplicates.length > 0}
      <section class="card" aria-labelledby="duplicates-heading">
        <h2 id="duplicates-heading">Looks like the same book as</h2>
        <div class="dupe-list">
          {#each duplicates as finding (finding.workIds.join('/'))}
            <div class="dupe">
              <div>
                <p>{finding.message}</p>
                <ul>
                  {#each finding.workIds.filter((id) => id !== workId) as id (id)}
                    {@const other = workById.get(id)}
                    <li><strong><a href="/admin/works/{id}">{other?.canonicalTitle ?? id}</a></strong><small>{other?.linkedBookCount ?? 0} readers · {other?.editionCount ?? 0} editions · <code>{id}</code></small></li>
                  {/each}
                </ul>
              </div>
              <button class="primary" type="button" onclick={() => mergeDuplicates(finding.workIds)}>Merge into the oldest…</button>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    <section class="card" aria-labelledby="editions-heading">
      <h2 id="editions-heading">Editions <span>{editions.length}</span></h2>
      {#if editions.length === 0}
        <p class="empty">No editions. Every linked book stands on an edition of its work; a reader's book below without one offers to mint it from the book's own fields.</p>
      {:else}
        <div class="table-scroll">
          <table>
            <thead><tr><th>Edition</th><th>ISBN</th><th>Publisher</th><th>Published</th><th>Language</th><th>Format</th><th>Pages</th><th>External IDs</th><th>Added by</th><th class="row-actions"></th></tr></thead>
            <tbody>
              {#each editions as edition (edition.editionId)}
                <tr>
                  <td><strong>{edition.title}</strong><small>{edition.translatorNames.length > 0 ? `tr. ${edition.translatorNames.join(', ')} · ` : ''}{edition.editionId}</small></td>
                  <td>{edition.isbn13 ?? '—'}</td>
                  <td>{edition.publisher || '—'}</td>
                  <td>{edition.publishedDate || '—'}</td>
                  <td>{#if edition.language !== ''}{languageLabel(edition.language)}{:else if work.language !== ''}{languageLabel(work.language)}<small>from the work</small>{:else}—{/if}</td>
                  <td>{edition.format}</td>
                  <td class="numeric">{edition.suggestedPageCount ?? '—'}</td>
                  <td>{Object.entries(edition.externalIds).map(([provider, id]) => `${provider}: ${id}`).join(', ') || '—'}</td>
                  <td>{creatorLabel(edition.createdBy, emails)}</td>
                  <td class="row-actions">
                    <div class="actions">
                      <button type="button" onclick={() => (draft = editEditionDraft(edition))}>Edit edition…</button>
                      {#if editions.length > 1}<button type="button" onclick={() => (draft = mergeEditionsDraft(work.workId, [edition.editionId]))}>Merge into…</button>{/if}
                      {#if edition.isbn13 !== null}<button type="button" onclick={() => (draft = repointIsbnDraft(edition.isbn13 ?? '', ''))}>Repoint ISBN…</button>{/if}
                    </div>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
      {#if absorbedEditions.length > 0}
        <h3>Absorbed editions</h3>
        <p>Aliases of the editions above: they keep their identifiers, and a lookup that lands on one answers with its survivor.</p>
        <ul class="alias-list">
          {#each absorbedEditions as alias (alias.editionId)}
            <li><strong>{alias.title}</strong>{#if alias.isbn13}<span>{alias.isbn13}</span>{/if}<code>{alias.editionId}</code><span aria-hidden="true">→</span><span>{editionById.get(alias.mergedInto ?? '')?.title ?? alias.mergedInto ?? '?'}</span></li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="card" aria-labelledby="readers-heading">
      <h2 id="readers-heading">Readers' books <span>{books.length}</span></h2>
      <p>Personal books that resolve to this work, including any still linked to a work merged into it. Only identity metadata is shown. Every linked book stands on an edition; one without gets it minted from the book's own fields.</p>
      {#if books.length === 0}
        <p class="empty">No reader has a book linked to this work.</p>
      {:else}
        <div class="table-scroll">
          <table>
            <thead><tr><th>Personal book</th><th>Reader</th><th>ISBN</th><th>Pages</th><th>Edition</th><th>Language</th><th>Anomaly</th><th class="row-actions"></th></tr></thead>
            <tbody>
              {#each books as book (bookKey(book))}
                {@const carried = effectiveLanguage(editionById.get(book.editionId ?? '')?.language ?? '', work.language)}
                <tr>
                  <td class="book-cell">
                    {#if book.coverUrl}<img src={book.coverUrl} alt="" referrerpolicy="no-referrer" />{/if}
                    <span><strong>{book.title}</strong><small>{book.authorNames.join(', ')}{book.workId !== workId ? ` · via merged ${book.workId}` : ''}</small></span>
                  </td>
                  <td>{creatorLabel(book.uid, emails)}<small><code>{book.uid}/{book.bookId}</code></small></td>
                  <td>{book.isbn13 ?? book.rawIsbn ?? '—'}</td>
                  <td class="numeric">{book.pageCount ?? '—'}</td>
                  <td>{book.editionId === null ? 'none' : editionById.get(book.editionId)?.title ?? book.editionId}{editionById.get(book.editionId ?? '')?.status === 'merged' ? ' · merged alias' : ''}</td>
                  <td>{book.language === '' ? '—' : languageLabel(book.language)}{#if carried !== '' && book.language !== carried}<small class="warning">edition says {languageLabel(carried)}</small>{/if}</td>
                  <td>{book.anomaly ?? '—'}</td>
                  <td class="row-actions">
                    <div class="actions">
                      {#if book.editionId === null}<button class="primary" type="button" onclick={() => (draft = linkBooksDraft([book], {workId: work.workId, editionId: null}))}>Mint edition…</button>{/if}
                      <button type="button" onclick={() => (draft = linkBooksDraft([book], {workId: work.workId, editionId: book.editionId}))}>Move…</button>
                      <button type="button" onclick={() => (draft = linkBooksDraft([book], null))}>Unlink…</button>
                    </div>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>
  {/if}

  <CatalogOperationDialog bind:draft {scan} onapplied={(message) => report(message, true)} />
</main>
