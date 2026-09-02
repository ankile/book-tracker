<script lang="ts">
  import '$lib/components/admin/admin.css';
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import CatalogHeader from '$lib/components/admin/CatalogHeader.svelte';
  import CatalogLoading from '$lib/components/admin/CatalogLoading.svelte';
  import CatalogOperationDialog from '$lib/components/admin/CatalogOperationDialog.svelte';
  import ReviewAction from '$lib/components/admin/ReviewAction.svelte';
  import { CATALOG_LIMITS } from '../../../shared/catalogLimits.ts';
  import { ADMIN_UID } from '$lib/admin-uid.ts';
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
    consoleHref,
    type ConsolePage,
    type ConsoleTab,
    createAuthorDraft,
    createEditionDraft,
    createWorkDraft,
    creatorLabel,
    type CreatorFilter,
    editWorkDraft,
    filterByCreator,
    filterByReview,
    filterRows,
    hideWorkDraft,
    isoDay,
    linkBooksDraft,
    mergeAuthorsDraft,
    mergeIntoOldestDraft,
    mergeWorksDraft,
    newestFirst,
    type OperationDraft,
    paginate,
    parseConsoleQuery,
    repointIsbnDraft,
    type ReviewFilter,
    reviewLabel,
    reviewStatus,
    sortAuthors,
    activeOnly,
    workSearchText,
  } from '$lib/utils/adminCatalogView.ts';

  // The scan is derived from live Firestore listeners the app prefetch opens
  // once the operator is signed in ($lib/firebase/adminCatalog.ts): every
  // console page renders whatever is current and updates as documents
  // change. Nothing here fetches; an applied operation shows up when its
  // writes land, the same way anyone else's would.
  const scan = $derived($adminCatalogScan ?? null);
  const emails = $derived($adminAccountEmails ?? new Map<string, string>());
  const progress = $derived($adminCatalogProgress);

  // The view is the URL (?tab=&q=&page=&review=&creator=): tabs, filters
  // and pages are links, so any list can be linked to and the browser's
  // back button steps through where the operator has been.
  const query = $derived(parseConsoleQuery(page.url.searchParams));

  // Every button on this page prefills the one operation dialog; nothing
  // changes until the operator applies there. Review marks are the one
  // exception: they are operator bookkeeping and land at once.
  let draft = $state<OperationDraft | null>(null);
  let statusMessage = $state('');
  let statusOk = $state(true);
  let selectedBookKeys = $state<string[]>([]);
  let selectedWorkIds = $state<string[]>([]);
  let selectedAuthorIds = $state<string[]>([]);

  // The search box is local state: typing replaces the URL after a short
  // pause, and the URL only writes back into the box while it is not
  // focused (history navigation), so the navigation cannot fight keystrokes.
  let searchText = $state('');
  let searchBox = $state<HTMLInputElement | null>(null);
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const fromUrl = query.q;
    const box = searchBox;
    untrack(() => {
      if (fromUrl !== searchText && document.activeElement !== box) searchText = fromUrl;
    });
  });
  function search(text: string): void {
    searchText = text;
    if (searchTimer !== null) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      if (text !== query.q) {
        void goto(consoleHref(query, {q: text}), {replaceState: true, keepFocus: true, noScroll: true});
      }
    }, 150);
  }

  const names = $derived(authorNamesById(scan ?? {authors: []}));
  const workById = $derived(new Map((scan?.works ?? []).map((work) => [work.workId, work])));
  const linkedBooks = $derived(booksByWork(scan ?? {works: [], books: []}));
  const unmatchedBooks = $derived((scan?.books ?? []).filter((book) => book.workId === null));
  const candidatesByBook = $derived(
    scan === null ? new Map<string, AdminCatalogCandidate[]>() : adminCatalogCandidatesByBook(scan),
  );
  const unmatchedWithCandidates = $derived(
    unmatchedBooks
      .map((book) => ({book, candidates: candidatesByBook.get(bookKey(book)) ?? []}))
      .filter(({candidates}) => candidates.length > 0),
  );
  const duplicateWorkFindings = $derived(
    (scan?.findings ?? []).filter((finding) => finding.code === 'suspected-duplicate-works'),
  );

  // Works newest first and authors by sort name, active ones only unless
  // asked for the merged and hidden, narrowed by the search, then the review
  // and creator filters, then one page of fifty.
  const allWorks = $derived(activeOnly([...(scan?.works ?? [])].sort(newestFirst), query.inactive));
  const allAuthors = $derived(activeOnly(sortAuthors(scan?.authors ?? []), query.inactive));
  const searchedWorks = $derived(filterByCreator(
    filterRows(allWorks, query.q, (work) => workSearchText(work, names)), query.creator, ADMIN_UID,
  ));
  const searchedAuthors = $derived(filterByCreator(
    filterRows(allAuthors, query.q, authorSearchText), query.creator, ADMIN_UID,
  ));
  const workRows = $derived(paginate(filterByReview(searchedWorks, query.review), query.page));
  const authorRows = $derived(paginate(filterByReview(searchedAuthors, query.review), query.page));
  const bookRows = $derived(paginate(filterRows(unmatchedBooks, query.q, (book) =>
    [book.title, ...book.authorNames, book.isbn13 ?? '', book.rawIsbn ?? '', book.publisher, bookKey(book)].join(' ')), query.page));
  const worksToReview = $derived(searchedWorks.filter((work) => work.status !== 'merged' && reviewStatus(work) !== 'done').length);
  const authorsToReview = $derived(searchedAuthors.filter((author) => author.status !== 'merged' && reviewStatus(author) !== 'done').length);

  // A selection outlives the rows it named only while they are still on
  // the page: a filter change or a book another update linked drops them.
  $effect(() => {
    const live = new Set(unmatchedBooks.map(bookKey));
    const kept = selectedBookKeys.filter((key) => live.has(key));
    if (kept.length !== selectedBookKeys.length) selectedBookKeys = kept;
  });
  $effect(() => {
    const visible = new Set(workRows.rows.map((work) => work.workId));
    const kept = selectedWorkIds.filter((id) => visible.has(id));
    if (kept.length !== selectedWorkIds.length) selectedWorkIds = kept;
  });
  $effect(() => {
    const visible = new Set(authorRows.rows.map((author) => author.authorId));
    const kept = selectedAuthorIds.filter((id) => visible.has(id));
    if (kept.length !== selectedAuthorIds.length) selectedAuthorIds = kept;
  });
  const selectedBooks = $derived(
    unmatchedBooks.filter((book) => selectedBookKeys.includes(bookKey(book))),
  );

  function toggled(list: readonly string[], key: string, on: boolean): string[] {
    return on ? [...new Set([...list, key])] : list.filter((entry) => entry !== key);
  }

  function toggleBook(book: AdminCatalogBookRow, selected: boolean): void {
    selectedBookKeys = toggled(selectedBookKeys, bookKey(book), selected);
  }

  function report(message: string, ok: boolean): void {
    statusMessage = message;
    statusOk = ok;
    if (ok) {
      selectedWorkIds = [];
      selectedAuthorIds = [];
    }
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

  const tabs: Array<{id: ConsoleTab; label: string}> = [
    {id: 'works', label: 'Works'},
    {id: 'authors', label: 'Authors'},
    {id: 'books', label: 'Unmatched books'},
    {id: 'findings', label: 'Findings'},
  ];
  const reviewChips: Array<{id: ReviewFilter; label: string}> = [
    {id: 'all', label: 'All'}, {id: 'needs', label: 'Needs review'}, {id: 'done', label: 'Reviewed'},
  ];
  const creatorChips: Array<{id: CreatorFilter; label: string}> = [
    {id: 'all', label: 'Anyone'}, {id: 'others', label: 'Added by others'}, {id: 'me', label: 'Added by me'},
  ];
  const searchLabel = $derived(
    query.tab === 'authors' ? 'Filter authors' : query.tab === 'books' ? 'Filter books' : 'Filter works',
  );
  const searchPlaceholder = $derived(
    query.tab === 'authors' ? 'Filter by name, alias, or ID' :
      query.tab === 'books' ? 'Filter by title, author, ISBN, or owner' : 'Filter by title, author, or ID',
  );
  const tabCount = (tab: ConsoleTab): number => {
    if (scan === null) return 0;
    if (tab === 'works') return allWorks.length;
    if (tab === 'authors') return allAuthors.length;
    if (tab === 'books') return unmatchedBooks.length;
    return duplicateWorkFindings.length + unmatchedWithCandidates.length + scan.findings.length;
  };
</script>

<svelte:head><title>Catalog · Book Tracker</title></svelte:head>

{#snippet pager(window: ConsolePage<unknown>, bottom: boolean)}
  {#if window.total > 0}
    <nav class="pager" class:bottom aria-label="Pages">
      <span>{window.from}–{window.to} of {window.total}</span>
      {#if window.page > 1}
        <a href={consoleHref(query, {page: window.page - 1})} data-sveltekit-noscroll>← Previous</a>
      {:else}
        <span aria-disabled="true">← Previous</span>
      {/if}
      <span>Page {window.page} of {window.pages}</span>
      {#if window.page < window.pages}
        <a href={consoleHref(query, {page: window.page + 1})} data-sveltekit-noscroll>Next →</a>
      {:else}
        <span aria-disabled="true">Next →</span>
      {/if}
    </nav>
  {/if}
{/snippet}

{#snippet reviewChipRow(needs: number)}
  <div class="chips" role="group" aria-label="Review filter">
    {#each reviewChips as chip (chip.id)}
      <a href={consoleHref(query, {review: chip.id})} aria-current={query.review === chip.id ? 'true' : undefined}>
        {chip.label}{#if chip.id === 'needs'} ({needs}){/if}
      </a>
    {/each}
  </div>
  <div class="chips" role="group" aria-label="Creator filter">
    {#each creatorChips as chip (chip.id)}
      <a href={consoleHref(query, {creator: chip.id})} aria-current={query.creator === chip.id ? 'true' : undefined}>{chip.label}</a>
    {/each}
  </div>
  <div class="chips" role="group" aria-label="Merged and hidden records">
    <a href={consoleHref(query, {inactive: !query.inactive})} aria-current={query.inactive ? 'true' : undefined}>Show merged and hidden</a>
  </div>
{/snippet}

<main class="admin-console">
  <CatalogHeader {scan} {progress} />
  <div class="page-title">
    <div>
      <h1>Catalog</h1>
      <p class="lead">The works, editions and authors every reader shares, and the personal books that stand on them.</p>
    </div>
    {#if scan !== null}
      <div class="ops" role="group" aria-label="Catalog operations">
        <button type="button" onclick={() => (draft = createWorkDraft())}>New work…</button>
        <button type="button" onclick={() => (draft = createAuthorDraft())}>New author…</button>
        <button type="button" onclick={() => (draft = createEditionDraft(null))}>New edition…</button>
        <button type="button" onclick={() => (draft = repointIsbnDraft('', ''))}>Repoint an ISBN…</button>
        <button type="button" onclick={() => (draft = mergeWorksDraft([], ''))}>Merge works…</button>
        <button type="button" onclick={() => (draft = mergeAuthorsDraft('', ''))}>Merge authors…</button>
      </div>
    {/if}
  </div>
  {#if statusMessage}<div class="notice {statusOk ? 'success' : 'error'}" role="status">{statusMessage}</div>{/if}

  {#if scan === null}
    <CatalogLoading {progress} />
  {:else}
    <nav class="tabs" aria-label="Catalog sections">
      {#each tabs as tab (tab.id)}
        <a href={consoleHref(query, {tab: tab.id})} aria-current={query.tab === tab.id ? 'page' : undefined}>
          {tab.label} <span>{tabCount(tab.id)}</span>
        </a>
      {/each}
    </nav>

    {#if query.tab !== 'findings'}
      <div class="toolbar-row">
        <input class="filter" type="search" placeholder={searchPlaceholder} aria-label={searchLabel}
          value={searchText} oninput={(event) => search(event.currentTarget.value)} bind:this={searchBox} />
        {#if query.tab === 'works'}{@render reviewChipRow(worksToReview)}{/if}
        {#if query.tab === 'authors'}{@render reviewChipRow(authorsToReview)}{/if}
      </div>
    {/if}

    {#if query.tab === 'works'}
      <section class="card" aria-labelledby="works-heading">
        <h2 id="works-heading">Works <span>{scan.works.length}/{CATALOG_LIMITS.works}</span></h2>
        <p>Newest first. Open a work for its editions, its readers' books, and every operation on it. A reviewed work returns to the queue when an edition or a reader's book lands on it.</p>
        <div class="list-bar">
          <div class="bulk">
            <span>{selectedWorkIds.length} selected</span>
            <ReviewAction kind="work" ids={selectedWorkIds} reviewed={true} label="Mark reviewed" onresult={report} />
            <ReviewAction kind="work" ids={selectedWorkIds} reviewed={false} label="Mark unreviewed" onresult={report} />
          </div>
          {@render pager(workRows, false)}
        </div>
        <div class="table-scroll">
          <table>
            <thead><tr>
              <th><input type="checkbox" aria-label="Select every work on this page"
                checked={workRows.rows.length > 0 && workRows.rows.every((work) => selectedWorkIds.includes(work.workId))}
                onchange={(event) => (selectedWorkIds = event.currentTarget.checked ? workRows.rows.map((work) => work.workId) : [])} /></th>
              <th>Work</th><th>Created</th><th>Status</th><th>Editions</th><th>Readers</th><th>Review</th><th>Warnings</th>
            </tr></thead>
            <tbody>
              {#each workRows.rows as work (work.workId)}
                <tr>
                  <td><input type="checkbox" aria-label={`Select ${work.canonicalTitle}`} checked={selectedWorkIds.includes(work.workId)} onchange={(event) => (selectedWorkIds = toggled(selectedWorkIds, work.workId, event.currentTarget.checked))} /></td>
                  <td><strong><a href="/admin/works/{work.workId}">{work.canonicalTitle}</a></strong><small>{catalogAuthorNames(names, work.authorIds)} · {work.workId}</small></td>
                  <td>{isoDay(work.createdAt)}<small>{creatorLabel(work.createdBy, emails)}</small></td>
                  <td><span class="status {work.status}">{work.status}</span></td>
                  <td class="numeric">{work.editionCount}</td>
                  <td class="numeric">{work.linkedBookCount}</td>
                  <td><span class="review {reviewStatus(work)}">{reviewLabel(work)}</span></td>
                  <td>{work.warnings.length === 0 ? '—' : work.warnings.join(' · ')}</td>
                </tr>
              {:else}
                <tr><td colspan="8" class="empty">No works match.</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
        {@render pager(workRows, true)}
      </section>
    {:else if query.tab === 'authors'}
      <section class="card" aria-labelledby="catalog-authors-heading">
        <h2 id="catalog-authors-heading">Authors <span>{scan.authors.length}/{CATALOG_LIMITS.catalogAuthors}</span></h2>
        <p>Works reference these entities by ID. Open an author to see their works, aliases, and to edit or merge them. A reviewed author returns to the queue when a new work names them.</p>
        <div class="list-bar">
          <div class="bulk">
            <span>{selectedAuthorIds.length} selected</span>
            <ReviewAction kind="author" ids={selectedAuthorIds} reviewed={true} label="Mark reviewed" onresult={report} />
            <ReviewAction kind="author" ids={selectedAuthorIds} reviewed={false} label="Mark unreviewed" onresult={report} />
          </div>
          {@render pager(authorRows, false)}
        </div>
        <div class="table-scroll">
          <table>
            <thead><tr>
              <th><input type="checkbox" aria-label="Select every author on this page"
                checked={authorRows.rows.length > 0 && authorRows.rows.every((author) => selectedAuthorIds.includes(author.authorId))}
                onchange={(event) => (selectedAuthorIds = event.currentTarget.checked ? authorRows.rows.map((author) => author.authorId) : [])} /></th>
              <th>Author</th><th>Kind</th><th>Status</th><th>Works</th><th>Created</th><th>Review</th><th>Warnings</th>
            </tr></thead>
            <tbody>
              {#each authorRows.rows as author (author.authorId)}
                <tr>
                  <td><input type="checkbox" aria-label={`Select ${author.canonicalName}`} checked={selectedAuthorIds.includes(author.authorId)} onchange={(event) => (selectedAuthorIds = toggled(selectedAuthorIds, author.authorId, event.currentTarget.checked))} /></td>
                  <td><strong><a href="/admin/authors/{author.authorId}">{author.canonicalName}</a></strong><small>{author.sortName}{author.alternateNames.length > 0 ? ` · also ${author.alternateNames.join(', ')}` : ''} · {author.authorId}</small></td>
                  <td>{author.kind}</td>
                  <td><span class="status {author.status}">{author.status}</span></td>
                  <td class="numeric">{author.workCount}</td>
                  <td>{isoDay(author.createdAt)}<small>{creatorLabel(author.createdBy, emails)}</small></td>
                  <td><span class="review {reviewStatus(author)}">{reviewLabel(author)}</span></td>
                  <td>{author.warnings.length === 0 ? '—' : author.warnings.join(' · ')}</td>
                </tr>
              {:else}
                <tr><td colspan="8" class="empty">No authors match.</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
        {@render pager(authorRows, true)}
      </section>
    {:else if query.tab === 'books'}
      <section class="card" aria-labelledby="unmatched-heading">
        <h2 id="unmatched-heading">Unmatched books <span>{unmatchedBooks.length} of {scan.books.length}</span></h2>
        <p>Personal books linked to no work. Only identity metadata needed for curation is shown; anomalous owners require manual review.</p>
        {#if unmatchedBooks.length === 0}
          <p class="empty">No unmatched books.</p>
        {:else}
          <div class="list-bar">
            <div class="actions">
              <button type="button" disabled={selectedBooks.length === 0} onclick={() => (draft = linkBooksDraft(selectedBooks, null))}>Link selected books to a work…</button>
              <button type="button" disabled={selectedBooks.length === 0} onclick={() => (draft = createWorkDraft(selectedBooks))}>New work from selected books…</button>
            </div>
            {@render pager(bookRows, false)}
          </div>
          <div class="table-scroll">
            <table>
              <thead><tr><th><span class="sr-only">Select</span></th><th>Personal book</th><th>ISBN</th><th>Pages</th><th>Publisher</th><th>Owner/book ID</th><th>Candidates</th><th>Anomaly</th></tr></thead>
              <tbody>
                {#each bookRows.rows as book (bookKey(book))}
                  <tr>
                    <td><input type="checkbox" aria-label={`Select ${book.title}`} checked={selectedBookKeys.includes(bookKey(book))} onchange={(event) => toggleBook(book, event.currentTarget.checked)} /></td>
                    <td class="book-cell">
                      {#if book.coverUrl}<img src={book.coverUrl} alt="" referrerpolicy="no-referrer" />{/if}
                      <span><strong>{book.title}</strong><small>{book.authorNames.join(', ')}</small></span>
                    </td>
                    <td>{book.isbn13 ?? book.rawIsbn ?? '—'}</td><td class="numeric">{book.pageCount ?? '—'}</td><td>{book.publisher || '—'}</td>
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
                {:else}
                  <tr><td colspan="8" class="empty">No unmatched books match.</td></tr>
                {/each}
              </tbody>
            </table>
          </div>
          {@render pager(bookRows, true)}
        {/if}
      </section>
    {:else}
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
                        <small>{work ? catalogAuthorNames(names, work.authorIds) : ''} · {(linkedBooks.get(id) ?? []).length} readers · {work?.editionCount ?? 0} editions · <code>{id}</code></small>
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
                  <p><strong>{book.title}</strong> — {book.authorNames.join(', ')} · {book.isbn13 ?? book.rawIsbn ?? 'no ISBN'} · {creatorLabel(book.uid, emails)}</p>
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

      <section class="card" aria-labelledby="findings-heading">
        <h2 id="findings-heading">Review findings <span>{scan.findings.length}</span></h2>
        {#if scan.findings.length === 0}
          <p class="empty">No deterministic findings.</p>
        {:else}
          <ul class="finding-list">
            {#each scan.findings as finding, index (`${finding.code}:${index}`)}
              <li class:error-finding={finding.severity === 'error'}>
                <strong>{finding.code}</strong> <span class="badge {finding.severity}">{finding.severity}</span>
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
    {/if}
  {/if}

  <CatalogOperationDialog bind:draft {scan} onapplied={(message) => report(message, true)} />
</main>
