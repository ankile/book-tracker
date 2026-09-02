<script lang="ts">
  import '$lib/components/admin/catalog.css';
  import CatalogHeader from '$lib/components/admin/CatalogHeader.svelte';
  import CatalogLoading from '$lib/components/admin/CatalogLoading.svelte';
  import CatalogOperationDialog from '$lib/components/admin/CatalogOperationDialog.svelte';
  import { CATALOG_LIMITS } from '../../../shared/catalogLimits.ts';
  import { adminAccountEmails, adminCatalogProgress, adminCatalogScan } from '$lib/firebase/adminCatalog.ts';
  import type { AdminCatalogBookRow, AdminCatalogBookTarget } from '$lib/interfaces/catalog.ts';
  import {
    adminCatalogCandidatesByBook,
    type AdminCatalogCandidate,
  } from '$lib/utils/adminCatalog.ts';
  import {
    authorNamesById,
    authorSearchText,
    bookKey,
    booksByWork,
    catalogAuthorNames,
    createAuthorDraft,
    createEditionDraft,
    createWorkDraft,
    creatorLabel,
    editWorkDraft,
    filterRows,
    hideWorkDraft,
    isoDay,
    linkBooksDraft,
    mergeAuthorsDraft,
    mergeIntoOldestDraft,
    mergeWorksDraft,
    newestFirst,
    repointIsbnDraft,
    sortAuthors,
    workSearchText,
    type OperationDraft,
  } from '$lib/utils/adminCatalogView.ts';

  // The scan is derived from live Firestore listeners the app prefetch opens
  // once the operator is signed in ($lib/firebase/adminCatalog.ts): every
  // console page renders whatever is current and updates as documents
  // change. Nothing here fetches; an applied operation shows up when its
  // writes land, the same way anyone else's would.
  const scan = $derived($adminCatalogScan ?? null);
  const emails = $derived($adminAccountEmails ?? new Map<string, string>());
  const progress = $derived($adminCatalogProgress);

  // Every button on this page prefills the one operation dialog; nothing
  // changes until the operator previews and applies there.
  let draft = $state<OperationDraft | null>(null);
  let statusMessage = $state('');
  let authorQuery = $state('');
  let workQuery = $state('');
  let selectedBookKeys = $state<string[]>([]);

  const names = $derived(authorNamesById(scan ?? {authors: []}));
  const workById = $derived(new Map((scan?.works ?? []).map((work) => [work.workId, work])));
  const linkedBooks = $derived(booksByWork(scan ?? {works: [], books: []}));
  const unmatchedBooks = $derived((scan?.books ?? []).filter((book) => book.workId === null));
  // A selection outlives the rows it named only while they are still
  // unmatched: a book another update linked drops out of the selection.
  $effect(() => {
    const live = new Set(unmatchedBooks.map(bookKey));
    const kept = selectedBookKeys.filter((key) => live.has(key));
    if (kept.length !== selectedBookKeys.length) selectedBookKeys = kept;
  });
  const selectedBooks = $derived(
    unmatchedBooks.filter((book) => selectedBookKeys.includes(bookKey(book))),
  );

  // The two jobs this console exists for: works other accounts created
  // through the add-book flow (review: keep, edit, hide, or merge), and
  // things the scan thinks are the same book twice (merge works, or link a
  // book to the work it belongs to). The full lists below are for
  // browsing: every row opens the work's or the author's own page.
  const userCreatedWorks = $derived(
    (scan?.works ?? []).filter((work) => work.createdBy !== null && work.status !== 'merged')
      .sort(newestFirst),
  );
  const duplicateWorkFindings = $derived(
    (scan?.findings ?? []).filter((finding) => finding.code === 'suspected-duplicate-works'),
  );
  const candidatesByBook = $derived(
    scan === null ? new Map<string, AdminCatalogCandidate[]>() : adminCatalogCandidatesByBook(scan),
  );
  const unmatchedWithCandidates = $derived(
    unmatchedBooks
      .map((book) => ({book, candidates: candidatesByBook.get(bookKey(book)) ?? []}))
      .filter(({candidates}) => candidates.length > 0),
  );
  const authors = $derived(filterRows(sortAuthors(scan?.authors ?? []), authorQuery, authorSearchText));
  const works = $derived(filterRows(
    [...(scan?.works ?? [])].sort(newestFirst),
    workQuery,
    (work) => workSearchText(work, names),
  ));

  function toggleBook(book: AdminCatalogBookRow, selected: boolean): void {
    const key = bookKey(book);
    selectedBookKeys = selected
      ? [...new Set([...selectedBookKeys, key])]
      : selectedBookKeys.filter((entry) => entry !== key);
  }

  function mergeDuplicates(ids: readonly string[]): void {
    draft = mergeIntoOldestDraft(ids.flatMap((id) => {
      const work = workById.get(id);
      return work === undefined ? [] : [work];
    }));
  }

  function linkCandidate(book: AdminCatalogBookTarget, candidate: AdminCatalogCandidate): void {
    draft = linkBooksDraft([book], {workId: candidate.workId, editionId: candidate.editionId});
  }
</script>

<svelte:head><title>Catalog · Book Tracker</title></svelte:head>

<main class="catalog-console">
  <CatalogHeader {scan} {progress} />
  <h1>Catalog</h1>
  {#if statusMessage}<div class="notice success" role="status">{statusMessage}</div>{/if}

  {#if scan === null}
    <CatalogLoading {progress} />
  {:else}
    <section class="card" aria-labelledby="new-works-heading">
      <h2 id="new-works-heading">New works from readers <span>{userCreatedWorks.length}</span></h2>
      {#if userCreatedWorks.length === 0}
        <p class="empty">Nothing to review.</p>
      {:else}
        <div class="work-cards">
          {#each userCreatedWorks as work (work.workId)}
            {@const linked = linkedBooks.get(work.workId) ?? []}
            <article class="work-card" class:hidden-work={work.status === 'hidden'}>
              {#if work.coverUrl}<img src={work.coverUrl} alt="" referrerpolicy="no-referrer" />{:else}<div class="no-cover"></div>{/if}
              <div class="work-body">
                <h3><a href="/admin/works/{work.workId}">{work.canonicalTitle}</a></h3>
                <p>{catalogAuthorNames(names, work.authorIds)}</p>
                <small>
                  {isoDay(work.createdAt)} · {creatorLabel(work.createdBy, emails)} ·
                  {work.editionCount} {work.editionCount === 1 ? 'edition' : 'editions'} ·
                  {linked.length} {linked.length === 1 ? 'reader' : 'readers'}{work.status === 'hidden' ? ' · hidden' : ''}
                </small>
                {#if linked.length > 0}
                  <ul class="linked">
                    {#each linked as book (bookKey(book))}
                      <li>{book.title} — {book.authorNames.join(', ')} · {book.pageCount ?? '—'} p</li>
                    {/each}
                  </ul>
                {/if}
                {#if work.warnings.length > 0}<p class="warning">{work.warnings.join(' · ')}</p>{/if}
              </div>
              <div class="actions">
                <button type="button" onclick={() => (draft = editWorkDraft(work))}>Edit…</button>
                <button type="button" onclick={() => (draft = mergeWorksDraft([work.workId], ''))}>Merge into…</button>
                {#if work.status !== 'hidden'}<button type="button" onclick={() => (draft = hideWorkDraft(work))}>Hide…</button>{/if}
              </div>
            </article>
          {/each}
        </div>
      {/if}
    </section>

    <section class="card" aria-labelledby="duplicates-heading">
      <h2 id="duplicates-heading">Same book, split across records <span>{duplicateWorkFindings.length + unmatchedWithCandidates.length}</span></h2>
      {#if duplicateWorkFindings.length === 0 && unmatchedWithCandidates.length === 0}
        <p class="empty">Nothing to merge or link.</p>
      {/if}
      {#if duplicateWorkFindings.length > 0}
        <h3>Works that look like the same book</h3>
        <div class="dupe-list">
          {#each duplicateWorkFindings as finding (finding.workIds.join('/'))}
            <div class="dupe">
              <div>
                <p>{finding.message}</p>
                <ul>
                  {#each finding.workIds as id (id)}
                    {@const work = workById.get(id)}
                    <li>
                      <strong><a href="/admin/works/{id}">{work?.canonicalTitle ?? id}</a></strong>
                      <small>{work ? catalogAuthorNames(names, work.authorIds) : ''} · {work?.linkedBookCount ?? 0} readers · {work?.editionCount ?? 0} editions · <code>{id}</code></small>
                    </li>
                  {/each}
                </ul>
              </div>
              <button class="primary" type="button" onclick={() => mergeDuplicates(finding.workIds)}>Merge into the oldest…</button>
            </div>
          {/each}
        </div>
      {/if}
      {#if unmatchedWithCandidates.length > 0}
        <h3>Books that probably belong to an existing work</h3>
        <div class="dupe-list">
          {#each unmatchedWithCandidates as {book, candidates} (bookKey(book))}
            <div class="dupe">
              <div>
                <p><strong>{book.title}</strong> — {book.authorNames.join(', ')} · {book.isbn13 ?? book.rawIsbn ?? 'no ISBN'} · reader {book.uid.slice(0, 8)}…</p>
              </div>
              <div class="actions">
                {#each candidates as candidate (`${bookKey(book)}/${candidate.workId}`)}
                  <button type="button" onclick={() => linkCandidate(book, candidate)}>Link to {candidate.title} <small>({candidate.label})</small></button>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <section class="card" aria-labelledby="catalog-authors-heading">
      <div class="section-head">
        <h2 id="catalog-authors-heading">Authors <span>{scan.authors.length}/{CATALOG_LIMITS.catalogAuthors}</span></h2>
        <input class="filter" type="search" placeholder="Filter by name, alias, or ID" aria-label="Filter authors" bind:value={authorQuery} />
        <button type="button" onclick={() => (draft = createAuthorDraft())}>New author…</button>
      </div>
      <p>Works reference these entities by ID. Open an author to see their works, aliases, and to edit or merge them.</p>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Author</th><th>Kind</th><th>Status</th><th>Works</th><th>Warnings</th></tr></thead>
          <tbody>
            {#each authors as author (author.authorId)}
              <tr>
                <td><strong><a href="/admin/authors/{author.authorId}">{author.canonicalName}</a></strong><small>{author.sortName}{author.alternateNames.length > 0 ? ` · also ${author.alternateNames.join(', ')}` : ''} · {author.authorId}</small></td>
                <td>{author.kind}</td>
                <td><span class="status {author.status}">{author.status}</span></td>
                <td>{author.workCount}</td>
                <td>{author.warnings.length === 0 ? '—' : author.warnings.join(' · ')}</td>
              </tr>
            {:else}
              <tr><td colspan="5" class="empty">No authors match.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <section class="card" aria-labelledby="works-heading">
      <div class="section-head">
        <h2 id="works-heading">Works <span>{scan.works.length}/{CATALOG_LIMITS.works}</span></h2>
        <input class="filter" type="search" placeholder="Filter by title, author, or ID" aria-label="Filter works" bind:value={workQuery} />
        <button type="button" onclick={() => (draft = createWorkDraft())}>New work…</button>
      </div>
      <p>Newest first. Open a work for its editions, its readers' books, and every operation on it. Every linked book stands on an edition; a work page offers to mint one for any book without.</p>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Work</th><th>Created</th><th>Status</th><th>Editions</th><th>Readers</th><th>Warnings</th></tr></thead>
          <tbody>
            {#each works as work (work.workId)}
              <tr>
                <td><strong><a href="/admin/works/{work.workId}">{work.canonicalTitle}</a></strong><small>{catalogAuthorNames(names, work.authorIds)} · {work.workId}</small></td>
                <td>{isoDay(work.createdAt)}<small>{creatorLabel(work.createdBy, emails)}</small></td>
                <td><span class="status {work.status}">{work.status}</span></td>
                <td>{work.editionCount}</td>
                <td>{work.linkedBookCount}</td>
                <td>{work.warnings.length === 0 ? '—' : work.warnings.join(' · ')}</td>
              </tr>
            {:else}
              <tr><td colspan="6" class="empty">No works match.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <section class="card" aria-labelledby="unmatched-heading">
      <h2 id="unmatched-heading">Unmatched books <span>{unmatchedBooks.length} of {scan.books.length}</span></h2>
      <p>Only identity metadata needed for curation is shown. Anomalous owners require manual review.</p>
      {#if unmatchedBooks.length === 0}
        <p class="empty">No unmatched books.</p>
      {:else}
        <div class="table-scroll">
          <table>
            <thead><tr><th><span class="sr-only">Select</span></th><th>Personal book</th><th>ISBN</th><th>Pages</th><th>Publisher</th><th>Owner/book ID</th><th>Candidates</th><th>Anomaly</th></tr></thead>
            <tbody>
              {#each unmatchedBooks as book (bookKey(book))}
                <tr>
                  <td><input type="checkbox" aria-label={`Select ${book.title}`} checked={selectedBookKeys.includes(bookKey(book))} onchange={(event) => toggleBook(book, event.currentTarget.checked)} /></td>
                  <td class="book-cell">
                    {#if book.coverUrl}<img src={book.coverUrl} alt="" referrerpolicy="no-referrer" />{/if}
                    <span><strong>{book.title}</strong><small>{book.authorNames.join(', ')}</small></span>
                  </td>
                  <td>{book.isbn13 ?? book.rawIsbn ?? '—'}</td><td>{book.pageCount ?? '—'}</td><td>{book.publisher || '—'}</td>
                  <td><code>{bookKey(book)}</code></td>
                  <td class="candidate-cell">
                    {#each candidatesByBook.get(bookKey(book)) ?? [] as candidate (`${bookKey(book)}/${candidate.workId}`)}
                      <button type="button" onclick={() => linkCandidate(book, candidate)}>
                        <strong>{candidate.label}</strong><small>{candidate.title} · {candidate.workId}</small>
                      </button>
                    {:else}—{/each}
                  </td>
                  <td>{book.anomaly ?? '—'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <div class="actions">
          <button type="button" disabled={selectedBooks.length === 0} onclick={() => (draft = linkBooksDraft(selectedBooks, null))}>Link selected books to a work…</button>
          <button type="button" disabled={selectedBooks.length === 0} onclick={() => (draft = createWorkDraft(selectedBooks))}>New work from selected books…</button>
        </div>
      {/if}
    </section>

    <section class="card" aria-labelledby="findings-heading">
      <h2 id="findings-heading">Review findings <span>{scan.findings.length}</span></h2>
      {#if scan.findings.length === 0}
        <p class="empty">No deterministic findings.</p>
      {:else}
        <ul class="finding-list">
          {#each scan.findings as finding, index (`${finding.code}:${index}`)}
            <li class:error-finding={finding.severity === 'error'}>
              <strong>{finding.code}</strong> <span>{finding.severity}</span>
              <p>{finding.message}</p>
              <small>
                Works: {#each finding.workIds as id, position (id)}{#if position > 0}, {/if}<a href="/admin/works/{id}">{workById.get(id)?.canonicalTitle ?? id}</a>{:else}—{/each}
                · Editions: {finding.editionIds.join(', ') || '—'}
                · Books: {finding.books.map(bookKey).join(', ') || '—'}
              </small>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="card" aria-labelledby="operations-heading">
      <h2 id="operations-heading">Other operations</h2>
      <p>Everything else starts from a work's or an author's page. These need no starting record.</p>
      <div class="actions">
        <button type="button" onclick={() => (draft = createEditionDraft(null))}>New edition…</button>
        <button type="button" onclick={() => (draft = repointIsbnDraft('', ''))}>Repoint an ISBN…</button>
        <button type="button" onclick={() => (draft = mergeWorksDraft([], ''))}>Merge works…</button>
        <button type="button" onclick={() => (draft = mergeAuthorsDraft('', ''))}>Merge authors…</button>
      </div>
    </section>
  {/if}

  <CatalogOperationDialog bind:draft {scan} onapplied={(message) => (statusMessage = message)} />
</main>
