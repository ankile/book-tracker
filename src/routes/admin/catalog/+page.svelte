<script lang="ts">
  import { tick } from 'svelte';
  import { reauthenticateWithPassword } from '$lib/firebase/auth.ts';
  import {
    adminCatalogApply,
    adminCatalogPreview,
    adminCatalogScan,
  } from '$lib/firebase/functions.ts';
  import type {
    AdminCatalogOperation,
    AdminCatalogPreviewResponse,
    AdminCatalogScanResponse,
    CatalogAuthorInput,
    CatalogAuthorKind,
    CatalogEditionInput,
    CatalogWorkInput,
    EditionFormat,
    WorkVisibility,
  } from '$lib/interfaces/catalog.ts';
  import {
    classifyAdminCatalogFailure,
    adminCatalogCandidatesForBook,
    parseAdminBookTargets,
    parseAdminExternalIds,
    parseAdminStringList,
  } from '$lib/utils/adminCatalog.ts';
  import { normalizeIsbn } from '$lib/utils/isbn.ts';

  type OperationType = AdminCatalogOperation['type'];
  type PreviewState = {operation: AdminCatalogOperation; response: AdminCatalogPreviewResponse};

  let scan = $state<AdminCatalogScanResponse | null>(null);
  let loading = $state(true);
  let loadingMore = $state(false);
  let statusMessage = $state('');
  let errorMessage = $state('');
  let selectedWorkId = $state('');
  let selectedBookKeys = $state<string[]>([]);

  let operationType = $state<OperationType>('linkBooks');
  let operationPending = $state(false);
  let preview = $state<PreviewState | null>(null);
  let previewDraftFingerprint = $state<string | null>(null);
  let passwordPromptOpen = $state(false);
  let password = $state('');
  let passwordPending = $state(false);
  let passwordInput = $state<HTMLInputElement>();
  let passwordDialog = $state<HTMLDialogElement>();
  let applyButton = $state<HTMLButtonElement>();
  let passwordReturnFocus: HTMLElement | null = null;

  $effect(() => {
    if (passwordPromptOpen && passwordDialog && !passwordDialog.open) {
      passwordDialog.showModal();
    } else if (!passwordPromptOpen && passwordDialog?.open) {
      passwordDialog.close();
    }
  });

  let workId = $state('');
  let workVisibility = $state<WorkVisibility>('internal');
  let canonicalTitle = $state('');
  let alternateTitles = $state('');
  let workAuthorIds = $state('');
  let workCoverUrl = $state('');
  let subjects = $state('');
  let fiction = $state<'unknown' | 'fiction' | 'nonfiction'>('unknown');
  let bookTargets = $state('');

  let authorId = $state('');
  let authorCanonicalName = $state('');
  let authorAlternateNames = $state('');
  let authorSortName = $state('');
  let authorKind = $state<CatalogAuthorKind>('person');
  let mergeSourceAuthorId = $state('');
  let mergeTargetAuthorId = $state('');

  let linkTargetWorkId = $state('');
  let linkTargetEditionId = $state('');
  let mergeSources = $state('');
  let mergeTarget = $state('');

  let editionId = $state('');
  let editionWorkId = $state('');
  let editionIsbn = $state('');
  let editionTitle = $state('');
  let editionPublisher = $state('');
  let editionPublishedDate = $state('');
  let editionLanguage = $state('');
  let editionTranslators = $state('');
  let editionFormat = $state<EditionFormat>('unknown');
  let editionPageCount = $state('');
  let editionCoverUrl = $state('');
  let editionExternalIds = $state('');

  let repointIsbn = $state('');
  let repointEditionId = $state('');

  const draftFingerprint = $derived(JSON.stringify([
    operationType, workId, workVisibility, canonicalTitle, alternateTitles,
    workAuthorIds, workCoverUrl, subjects, fiction, bookTargets,
    authorId, authorCanonicalName, authorAlternateNames, authorSortName,
    authorKind, mergeSourceAuthorId, mergeTargetAuthorId,
    linkTargetWorkId, linkTargetEditionId, mergeSources, mergeTarget,
    editionId, editionWorkId, editionIsbn, editionTitle,
    editionPublisher, editionPublishedDate, editionLanguage,
    editionTranslators, editionFormat, editionPageCount, editionCoverUrl,
    editionExternalIds, repointIsbn, repointEditionId,
  ]));

  $effect(() => {
    const current = draftFingerprint;
    if (preview !== null && previewDraftFingerprint !== null &&
        current !== previewDraftFingerprint) {
      preview = null;
      previewDraftFingerprint = null;
      statusMessage = 'The draft changed. Create a fresh preview before applying.';
    }
  });

  const unmatchedBooks = $derived(scan?.books.filter((book) => book.workId === null) ?? []);
  const catalogAuthorNameById = $derived(new Map(
    (scan?.authors ?? []).map((author) => [author.authorId, author.canonicalName]),
  ));
  const selectedWork = $derived(scan?.works.find((work) => work.workId === selectedWorkId) ?? null);
  const worksNewestFirst = $derived(
    [...(scan?.works ?? [])].sort((left, right) => right.createdAt - left.createdAt),
  );
  const selectedEditions = $derived(
    scan?.editions.filter((edition) => edition.workId === selectedWorkId) ?? [],
  );
  const selectedLinkedBooks = $derived(
    scan?.books.filter((book) => book.workId === selectedWorkId ||
      selectedWork?.mergedFrom.includes(book.workId ?? '')) ?? [],
  );

  $effect(() => {
    void loadScan();
  });

  async function loadScan(bookCursor: string | null = null): Promise<void> {
    if (bookCursor === null) loading = true;
    else loadingMore = true;
    errorMessage = '';
    try {
      const page = await adminCatalogScan(bookCursor);
      if (bookCursor === null || scan === null) scan = page;
      else {
        const priorCounts = new Map(scan.works.map((work) => [work.workId, work.linkedBookCount]));
        scan = {
          ...page,
          works: page.works.map((work) => ({
            ...work,
            linkedBookCount: (priorCounts.get(work.workId) ?? 0) + work.linkedBookCount,
          })),
          books: [...scan.books, ...page.books],
          findings: [...scan.findings, ...page.findings],
          bookCountsComplete: page.nextBookCursor === null,
        };
      }
      if (selectedWorkId && !scan.works.some((work) => work.workId === selectedWorkId)) {
        selectedWorkId = '';
      }
    } catch (error) {
      console.error('Admin catalog scan failed', error);
      errorMessage = 'The catalog scan could not be loaded. No catalog data was changed.';
    } finally {
      loading = false;
      loadingMore = false;
    }
  }

  function lines(values: readonly string[]): string {
    return values.join('\n');
  }

  function catalogAuthorNames(ids: readonly string[]): string {
    return ids.map((id) => catalogAuthorNameById.get(id) ?? `[Missing ${id}]`).join(', ');
  }

  function nullableFiction(): boolean | null {
    return fiction === 'unknown' ? null : fiction === 'fiction';
  }

  function requireId(value: string, label: string): string {
    const id = value.trim();
    if (id === '' || id.includes('/')) throw new TypeError(`${label} must be one Firestore document ID.`);
    return id;
  }

  function workInput(): CatalogWorkInput {
    const title = canonicalTitle.trim();
    const authorIds = parseAdminStringList(workAuthorIds);
    if (title === '') throw new TypeError('Canonical title is required.');
    if (authorIds.length === 0) throw new TypeError('At least one catalog author ID is required.');
    return {
      canonicalTitle: title,
      alternateTitles: parseAdminStringList(alternateTitles),
      authorIds,
      coverUrl: workCoverUrl.trim(),
      subjects: parseAdminStringList(subjects),
      fiction: nullableFiction(),
    };
  }

  function authorInput(): CatalogAuthorInput {
    const canonicalName = authorCanonicalName.trim();
    const sortName = authorSortName.trim();
    if (canonicalName === '' || sortName === '') {
      throw new TypeError('Canonical and sort names are required.');
    }
    return {
      canonicalName,
      alternateNames: parseAdminStringList(authorAlternateNames),
      sortName,
      kind: authorKind,
    };
  }

  function editionInput(): CatalogEditionInput {
    const rawIsbn = editionIsbn.trim();
    const normalizedIsbn = rawIsbn === '' ? null : normalizeIsbn(rawIsbn);
    if (rawIsbn !== '' && normalizedIsbn === null) throw new TypeError('Edition ISBN must have a valid checksum.');
    const title = editionTitle.trim();
    if (title === '') throw new TypeError('Edition title is required.');
    const pageCount = editionPageCount.trim() === '' ? null : Number(editionPageCount);
    if (pageCount !== null && (!Number.isSafeInteger(pageCount) || pageCount <= 0)) {
      throw new TypeError('Suggested page count must be a positive whole number or blank.');
    }
    return {
      isbn13: normalizedIsbn,
      title,
      publisher: editionPublisher.trim(),
      publishedDate: editionPublishedDate.trim(),
      language: editionLanguage.trim(),
      translatorNames: parseAdminStringList(editionTranslators),
      format: editionFormat,
      suggestedPageCount: pageCount,
      coverUrl: editionCoverUrl.trim(),
      externalIds: parseAdminExternalIds(editionExternalIds),
    };
  }

  function buildOperation(): AdminCatalogOperation {
    if (operationType === 'upsertAuthor') {
      return {
        type: operationType,
        authorId: requireId(authorId, 'Author ID'),
        author: authorInput(),
      };
    }
    if (operationType === 'mergeAuthors') {
      return {
        type: operationType,
        sourceAuthorId: requireId(mergeSourceAuthorId, 'Source author ID'),
        targetAuthorId: requireId(mergeTargetAuthorId, 'Target author ID'),
      };
    }
    if (operationType === 'createWork') {
      return {
        type: operationType,
        workId: requireId(workId, 'Work ID'),
        visibility: workVisibility,
        work: workInput(),
        books: parseAdminBookTargets(bookTargets),
      };
    }
    if (operationType === 'linkBooks') {
      const books = parseAdminBookTargets(bookTargets);
      if (books.length === 0) throw new TypeError('Select at least one personal book.');
      const targetWork = linkTargetWorkId.trim();
      return {
        type: operationType,
        books,
        target: targetWork === '' ? null : {
          workId: requireId(targetWork, 'Target work ID'),
          editionId: linkTargetEditionId.trim() === ''
            ? null
            : requireId(linkTargetEditionId, 'Target edition ID'),
        },
      };
    }
    if (operationType === 'mergeWorks') {
      const sourceWorkIds = parseAdminStringList(mergeSources).map((id) => requireId(id, 'Source work ID'));
      if (sourceWorkIds.length === 0) throw new TypeError('Enter at least one source work ID.');
      return {
        type: operationType,
        sourceWorkIds,
        targetWorkId: requireId(mergeTarget, 'Target work ID'),
      };
    }
    if (operationType === 'editWork') {
      return {
        type: operationType,
        workId: requireId(workId, 'Work ID'),
        visibility: workVisibility,
        work: workInput(),
      };
    }
    if (operationType === 'upsertEdition') {
      return {
        type: operationType,
        editionId: requireId(editionId, 'Edition ID'),
        workId: requireId(editionWorkId, 'Edition work ID'),
        edition: editionInput(),
      };
    }
    const isbn13 = normalizeIsbn(repointIsbn);
    if (isbn13 === null) throw new TypeError('Repointed ISBN must have a valid checksum.');
    return {
      type: 'repointIsbn',
      isbn13,
      editionId: requireId(repointEditionId, 'Edition ID'),
    };
  }

  async function requestPreview(): Promise<void> {
    errorMessage = '';
    statusMessage = '';
    operationPending = true;
    try {
      const operation = buildOperation();
      const response = await adminCatalogPreview({operation});
      preview = {operation, response};
      previewDraftFingerprint = draftFingerprint;
      statusMessage = `Preview ready: ${response.touchedDocuments} documents would be touched.`;
    } catch (error) {
      if (error instanceof TypeError) errorMessage = error.message;
      else {
        console.error('Admin catalog preview failed', error);
        errorMessage = 'Preview failed. Nothing was changed; review the operation and try again.';
      }
    } finally {
      operationPending = false;
    }
  }

  async function promptForRecentAuthentication(): Promise<void> {
    passwordReturnFocus = applyButton ?? (
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    );
    passwordPromptOpen = true;
    password = '';
    await tick();
    passwordInput?.focus();
  }

  async function closePasswordPrompt(): Promise<void> {
    passwordPromptOpen = false;
    password = '';
    await tick();
    passwordReturnFocus?.focus();
    passwordReturnFocus = null;
  }

  function failureMessage(error: unknown): string {
    const failure = classifyAdminCatalogFailure(error);
    if (failure.kind === 'stale-preview') {
      preview = null;
      previewDraftFingerprint = null;
      return 'This preview is stale because catalog links or metadata changed. Nothing was applied; create a fresh preview.';
    }
    if (failure.kind === 'operation-too-large') {
      return `This operation would touch more than ${failure.maxTouchedDocuments} documents. Split it into smaller operations.`;
    }
    if (failure.kind === 'catalog-capacity') {
      return `The ${failure.collection} catalog capacity (${failure.maximum}) has been reached. Edit, merge, or unlink existing records before creating another.`;
    }
    if (failure.kind === 'catalog-invariant') {
      return 'The operation would violate a catalog identity invariant. Nothing was applied.';
    }
    if (failure.kind === 'identifier-conflict') {
      return 'An ISBN or external identifier is already assigned elsewhere. Nothing was applied.';
    }
    return 'The catalog operation failed. Nothing was applied; reload the scan before retrying.';
  }

  async function applyCurrentPreview(confirmFirst = true): Promise<void> {
    if (preview === null) return;
    if (confirmFirst && !confirm(
      `Apply operation ${preview.response.operationId} and its ${preview.response.changes.length} exact changes?`,
    )) return;
    operationPending = true;
    errorMessage = '';
    statusMessage = '';
    try {
      const result = await adminCatalogApply({
        operationId: preview.response.operationId,
        operation: preview.operation,
        expected: preview.response.expected,
      });
      preview = null;
      previewDraftFingerprint = null;
      selectedBookKeys = [];
      statusMessage = `Applied ${result.operationId}: ${result.touchedDocuments} documents changed.`;
      await loadScan();
    } catch (error) {
      const failure = classifyAdminCatalogFailure(error);
      if (failure.kind === 'recent-auth-required') {
        await promptForRecentAuthentication();
      } else {
        console.error('Admin catalog apply failed', error);
        errorMessage = failureMessage(error);
      }
    } finally {
      operationPending = false;
    }
  }

  async function reauthenticateAndRetry(): Promise<void> {
    if (password === '') {
      errorMessage = 'Enter the administrator password to continue.';
      return;
    }
    passwordPending = true;
    errorMessage = '';
    try {
      await reauthenticateWithPassword(password);
      await closePasswordPrompt();
      await applyCurrentPreview(false);
    } catch (error) {
      console.error('Admin reauthentication failed', error);
      errorMessage = 'Reauthentication failed. Check the password and try again; nothing was applied.';
      password = '';
      await tick();
      passwordInput?.focus();
    } finally {
      passwordPending = false;
    }
  }

  function toggleBook(uid: string, bookId: string, selected: boolean): void {
    const key = `${uid}/${bookId}`;
    selectedBookKeys = selected
      ? [...new Set([...selectedBookKeys, key])]
      : selectedBookKeys.filter((entry) => entry !== key);
  }

  function useSelectedBooks(): void {
    bookTargets = lines(selectedBookKeys);
    operationType = 'linkBooks';
    document.getElementById('operation-heading')?.scrollIntoView({behavior: 'smooth'});
  }

  function useCandidate(
    book: {uid: string; bookId: string},
    candidate: {workId: string; editionId: string | null},
  ): void {
    bookTargets = `${book.uid}/${book.bookId}`;
    linkTargetWorkId = candidate.workId;
    linkTargetEditionId = candidate.editionId ?? '';
    operationType = 'linkBooks';
    document.getElementById('operation-heading')?.scrollIntoView({behavior: 'smooth'});
  }

  function inspectWork(id: string): void {
    selectedWorkId = id;
    document.getElementById('work-detail-heading')?.scrollIntoView({behavior: 'smooth'});
  }

  function editSelectedWork(): void {
    if (selectedWork === null) return;
    operationType = 'editWork';
    workId = selectedWork.workId;
    workVisibility = selectedWork.visibility;
    canonicalTitle = selectedWork.canonicalTitle;
    alternateTitles = lines(selectedWork.alternateTitles);
    workAuthorIds = lines(selectedWork.authorIds);
    workCoverUrl = selectedWork.coverUrl;
    subjects = lines(selectedWork.subjects);
    fiction = selectedWork.fiction === null ? 'unknown' : selectedWork.fiction ? 'fiction' : 'nonfiction';
    document.getElementById('operation-heading')?.scrollIntoView({behavior: 'smooth'});
  }

  function editEdition(id: string): void {
    const edition = scan?.editions.find((row) => row.editionId === id);
    if (edition === undefined) return;
    operationType = 'upsertEdition';
    editionId = edition.editionId;
    editionWorkId = edition.workId;
    editionIsbn = edition.isbn13 ?? '';
    editionTitle = edition.title;
    editionPublisher = edition.publisher;
    editionPublishedDate = edition.publishedDate;
    editionLanguage = edition.language;
    editionTranslators = lines(edition.translatorNames);
    editionFormat = edition.format;
    editionPageCount = edition.suggestedPageCount?.toString() ?? '';
    editionCoverUrl = edition.coverUrl;
    editionExternalIds = lines(Object.entries(edition.externalIds).map(([provider, idValue]) => `${provider}=${idValue}`));
    document.getElementById('operation-heading')?.scrollIntoView({behavior: 'smooth'});
  }

  function editCatalogAuthor(id: string): void {
    const author = scan?.authors.find((row) => row.authorId === id);
    if (author === undefined || author.status !== 'active') return;
    operationType = 'upsertAuthor';
    authorId = author.authorId;
    authorCanonicalName = author.canonicalName;
    authorAlternateNames = lines(author.alternateNames);
    authorSortName = author.sortName;
    authorKind = author.kind;
    document.getElementById('operation-heading')?.scrollIntoView({behavior: 'smooth'});
  }
</script>

<svelte:head><title>Catalog curation · Book Tracker</title></svelte:head>

<main class="admin-catalog">
  <header>
    <a href="/admin">← Admin overview</a>
    <h1>Catalog curation</h1>
    <p>Bibliographic identity only. This console does not show progress, timers, sessions, or private profile settings.</p>
    <button type="button" disabled={loading} onclick={() => void loadScan()}>{loading ? 'Scanning…' : 'Refresh scan'}</button>
  </header>

  {#if errorMessage}<div class="notice error" role="alert">{errorMessage}</div>{/if}
  {#if statusMessage}<div class="notice success" role="status">{statusMessage}</div>{/if}

  {#if loading && scan === null}
    <p class="loading">Loading bounded catalog scan…</p>
  {:else if scan}
    <section class="card" aria-labelledby="catalog-authors-heading">
      <h2 id="catalog-authors-heading">Catalog authors <span>{scan.authors.length}/{scan.limits.catalogAuthors}</span></h2>
      <p>Works reference these entities by ID. Editing a canonical author updates every catalog display without rewriting personal books.</p>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Author</th><th>Kind</th><th>Status</th><th>Works</th><th>Warnings</th><th></th></tr></thead>
          <tbody>
            {#each scan.authors as author (author.authorId)}
              <tr>
                <td><strong>{author.canonicalName}</strong><small>{author.sortName} · {author.authorId}</small></td>
                <td>{author.kind}</td><td>{author.status}</td><td>{author.workCount}</td>
                <td>{author.warnings.length === 0 ? '—' : author.warnings.join(' · ')}</td>
                <td><button type="button" disabled={author.status !== 'active'} onclick={() => editCatalogAuthor(author.authorId)}>Edit</button></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <section class="card" aria-labelledby="works-heading">
      <h2 id="works-heading">Works <span>{scan.works.length}/{scan.limits.works}</span></h2>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Work</th><th>Created</th><th>Status</th><th>Visibility</th><th>Editions</th><th>{scan.bookCountsComplete ? 'Linked books' : 'Linked books loaded'}</th><th>Warnings</th><th></th></tr></thead>
          <tbody>
            <!-- Newest first: works users created through the add-book flow
                 land at the top for review (edit, merge, hide). -->
            {#each worksNewestFirst as work (work.workId)}
              <tr>
                <td><strong>{work.canonicalTitle}</strong><small>{catalogAuthorNames(work.authorIds)} · {work.workId}</small></td>
                <td>{new Date(work.createdAt).toISOString().slice(0, 10)}<small>{work.createdBy === null ? 'migration / admin' : `user ${work.createdBy.slice(0, 8)}…`}</small></td>
                <td>{work.status}</td><td>{work.visibility}</td><td>{work.editionCount}</td><td>{work.linkedBookCount}</td>
                <td>{work.warnings.length === 0 ? '—' : work.warnings.join(' · ')}</td>
                <td><button type="button" onclick={() => inspectWork(work.workId)}>Inspect</button></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <section class="card" aria-labelledby="unmatched-heading">
      <h2 id="unmatched-heading">Unmatched books <span>{unmatchedBooks.length} loaded · {scan.limits.books} per page</span></h2>
      <p>Only identity metadata needed for curation is shown. Anomalous owners require manual review.</p>
      {#if unmatchedBooks.length === 0}
        <p class="empty">No unmatched books.</p>
      {:else}
        <div class="table-scroll">
          <table>
            <thead><tr><th><span class="sr-only">Select</span></th><th>Personal book</th><th>ISBN</th><th>Pages</th><th>Publisher</th><th>Owner/book ID</th><th>Candidates</th><th>Anomaly</th></tr></thead>
            <tbody>
              {#each unmatchedBooks as book (`${book.uid}/${book.bookId}`)}
                <tr>
                  <td><input type="checkbox" aria-label={`Select ${book.title}`} checked={selectedBookKeys.includes(`${book.uid}/${book.bookId}`)} onchange={(event) => toggleBook(book.uid, book.bookId, event.currentTarget.checked)} /></td>
                  <td class="book-cell">
                    {#if book.coverUrl}<img src={book.coverUrl} alt="" referrerpolicy="no-referrer" />{/if}
                    <span><strong>{book.title}</strong><small>{book.authorNames.join(', ')}</small></span>
                  </td>
                  <td>{book.isbn13 ?? book.rawIsbn ?? '—'}</td><td>{book.pageCount}</td><td>{book.publisher || '—'}</td>
                  <td><code>{book.uid}/{book.bookId}</code></td>
                  <td class="candidate-cell">
                    {#each adminCatalogCandidatesForBook(scan, book) as candidate (`${book.uid}/${book.bookId}/${candidate.workId}`)}
                      <button type="button" onclick={() => useCandidate(book, candidate)}>
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
        <button type="button" disabled={selectedBookKeys.length === 0} onclick={useSelectedBooks}>Use selected books in link operation</button>
        {#if scan.nextBookCursor}
          <button type="button" disabled={loadingMore} onclick={() => void loadScan(scan?.nextBookCursor ?? null)}>{loadingMore ? 'Loading…' : 'Load next 100 books'}</button>
        {/if}
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
              <small>Works: {finding.workIds.join(', ') || '—'} · Editions: {finding.editionIds.join(', ') || '—'} · Books: {finding.books.map((book) => `${book.uid}/${book.bookId}`).join(', ') || '—'}</small>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="card" aria-labelledby="work-detail-heading">
      <h2 id="work-detail-heading">Work detail</h2>
      <label for="selected-work">Selected work</label>
      <select id="selected-work" bind:value={selectedWorkId}>
        <option value="">Choose a work</option>
        {#each scan.works as work (work.workId)}<option value={work.workId}>{work.canonicalTitle} ({work.workId})</option>{/each}
      </select>
      {#if selectedWork}
        <div class="detail-heading">
          {#if selectedWork.coverUrl}<img src={selectedWork.coverUrl} alt="" referrerpolicy="no-referrer" />{/if}
          <div><h3>{selectedWork.canonicalTitle}</h3><p>{catalogAuthorNames(selectedWork.authorIds)}</p><code>{selectedWork.workId}</code></div>
          <button type="button" onclick={editSelectedWork}>Edit this work</button>
        </div>
        <dl class="facts">
          <div><dt>Status</dt><dd>{selectedWork.status}</dd></div><div><dt>Visibility</dt><dd>{selectedWork.visibility}</dd></div>
          <div><dt>Aliases</dt><dd>{selectedWork.alternateTitles.join(' · ') || '—'}</dd></div><div><dt>Merged IDs</dt><dd>{selectedWork.mergedFrom.join(', ') || '—'}</dd></div>
        </dl>
        <h3>Editions</h3>
        <div class="compact-list">
          {#each selectedEditions as edition (edition.editionId)}
            <div><span><strong>{edition.title}</strong> · {edition.isbn13 ?? 'No ISBN'} · {edition.publisher || 'No publisher'}</span><button type="button" onclick={() => editEdition(edition.editionId)}>Edit edition</button></div>
          {/each}
          {#if selectedEditions.length === 0}<p class="empty">No editions.</p>{/if}
        </div>
        <h3>Attached personal books</h3>
        <div class="compact-list">
          {#each selectedLinkedBooks as book (`${book.uid}/${book.bookId}`)}
            <div><span><strong>{book.title}</strong> · {book.authorNames.join(', ')} · {book.pageCount} pages</span><code>{book.uid}/{book.bookId}</code></div>
          {/each}
          {#if selectedLinkedBooks.length === 0}<p class="empty">No linked personal books.</p>{/if}
        </div>
      {/if}
    </section>
  {/if}

  <section class="card operation" aria-labelledby="operation-heading">
    <h2 id="operation-heading">Preview an operation</h2>
    <p>Every action is previewed without writes. Apply repeats the stale-state checks and asks for explicit confirmation.</p>
    <label for="operation-type">Operation</label>
    <select id="operation-type" bind:value={operationType}>
      <option value="upsertAuthor">Create or edit author</option><option value="mergeAuthors">Merge authors</option>
      <option value="createWork">Create work</option><option value="linkBooks">Link or unlink books</option>
      <option value="mergeWorks">Merge works</option><option value="editWork">Edit work</option>
      <option value="upsertEdition">Create or edit edition</option><option value="repointIsbn">Repoint ISBN</option>
    </select>

    {#if operationType === 'upsertAuthor'}
      <div class="form-grid">
        <label>Author ID<input bind:value={authorId} autocomplete="off" /></label>
        <label>Kind<select bind:value={authorKind}><option value="person">Person</option><option value="entity">Entity</option><option value="placeholder">Placeholder</option></select></label>
        <label>Canonical name<input bind:value={authorCanonicalName} /></label>
        <label>Sort name<input bind:value={authorSortName} /></label>
        <label class="wide">Alternate names, one per line<textarea bind:value={authorAlternateNames}></textarea></label>
      </div>
    {:else if operationType === 'mergeAuthors'}
      <div class="form-grid">
        <label>Source author ID<input bind:value={mergeSourceAuthorId} /></label>
        <label>Canonical target author ID<input bind:value={mergeTargetAuthorId} /></label>
      </div>
    {:else if operationType === 'createWork' || operationType === 'editWork'}
      <div class="form-grid">
        <label>Work ID<input bind:value={workId} autocomplete="off" /></label>
        <label>Visibility<select bind:value={workVisibility}><option value="internal">Internal</option><option value="searchable">Searchable</option></select></label>
        <label class="wide">Canonical title<input bind:value={canonicalTitle} /></label>
        <label>Catalog author IDs, one per line<textarea bind:value={workAuthorIds}></textarea></label>
        <label>Alternate titles, one per line<textarea bind:value={alternateTitles}></textarea></label>
        <label>Cover URL<input type="url" bind:value={workCoverUrl} /></label>
        <label>Subjects, one per line<textarea bind:value={subjects}></textarea></label>
        <label>Fiction<select bind:value={fiction}><option value="unknown">Unknown</option><option value="fiction">Fiction</option><option value="nonfiction">Nonfiction</option></select></label>
        {#if operationType === 'createWork'}<label class="wide">Personal books to link, uid/bookId per line<textarea bind:value={bookTargets}></textarea></label>{/if}
      </div>
    {:else if operationType === 'linkBooks'}
      <div class="form-grid">
        <label class="wide">Personal books, uid/bookId per line<textarea bind:value={bookTargets}></textarea></label>
        <label>Target work ID <small>Leave blank to unlink.</small><input bind:value={linkTargetWorkId} /></label>
        <label>Target edition ID <small>Optional.</small><input bind:value={linkTargetEditionId} /></label>
      </div>
    {:else if operationType === 'mergeWorks'}
      <div class="form-grid">
        <label>Source work IDs, one per line<textarea bind:value={mergeSources}></textarea></label>
        <label>Canonical target work ID<input bind:value={mergeTarget} /></label>
      </div>
    {:else if operationType === 'upsertEdition'}
      <div class="form-grid">
        <label>Edition ID<input bind:value={editionId} /></label><label>Work ID<input bind:value={editionWorkId} /></label>
        <label class="wide">Edition title<input bind:value={editionTitle} /></label>
        <label>Translators, one per line<textarea bind:value={editionTranslators}></textarea></label>
        <label>ISBN<input bind:value={editionIsbn} inputmode="numeric" /></label><label>Suggested pages<input bind:value={editionPageCount} inputmode="numeric" /></label>
        <label>Publisher<input bind:value={editionPublisher} /></label><label>Published date<input bind:value={editionPublishedDate} /></label>
        <label>Language<input bind:value={editionLanguage} /></label><label>Format<select bind:value={editionFormat}><option value="unknown">Unknown</option><option value="full">Full</option><option value="abridged">Abridged</option><option value="revised">Revised</option></select></label>
        <label>Cover URL<input type="url" bind:value={editionCoverUrl} /></label>
        <label>External IDs, provider=id per line<textarea bind:value={editionExternalIds}></textarea></label>
      </div>
    {:else}
      <div class="form-grid"><label>ISBN<input bind:value={repointIsbn} inputmode="numeric" /></label><label>New edition ID<input bind:value={repointEditionId} /></label></div>
    {/if}
    <button class="primary" type="button" disabled={operationPending} onclick={() => void requestPreview()}>{operationPending ? 'Working…' : 'Preview without applying'}</button>

    {#if preview}
      <section class="preview" aria-labelledby="preview-heading">
        <h3 id="preview-heading">Exact preview</h3>
        <p><code>{preview.response.operationId}</code> · hash <code>{preview.response.operationHash}</code> · {preview.response.touchedDocuments} touched documents</p>
        <details><summary>Operation payload</summary><pre>{JSON.stringify(preview.operation, null, 2)}</pre></details>
        <ol>
          {#each preview.response.changes as change (`${change.kind}:${change.id}:${change.action}`)}
            <li><strong>{change.action} {change.kind} {change.id}</strong><div class="diff"><div><span>Before</span><pre>{JSON.stringify(change.before, null, 2)}</pre></div><div><span>After</span><pre>{JSON.stringify(change.after, null, 2)}</pre></div></div></li>
          {/each}
        </ol>
        <button bind:this={applyButton} class="danger" type="button" disabled={operationPending} onclick={() => void applyCurrentPreview()}>Apply these exact changes</button>
      </section>
    {/if}
  </section>
</main>

{#if passwordPromptOpen}
  <dialog
    bind:this={passwordDialog}
    aria-labelledby="reauth-heading"
    oncancel={(event) => { event.preventDefault(); void closePasswordPrompt(); }}>
    <form onsubmit={(event) => { event.preventDefault(); void reauthenticateAndRetry(); }}>
      <h2 id="reauth-heading">Confirm recent authentication</h2>
      <p>The server requires a password check from the last 15 minutes before catalog mutations. The preview has not been applied.</p>
      <label for="admin-password">Administrator password</label>
      <input id="admin-password" bind:this={passwordInput} bind:value={password} type="password" autocomplete="current-password" />
      <div class="dialog-actions"><button type="button" onclick={() => void closePasswordPrompt()}>Cancel</button><button class="primary" type="submit" disabled={passwordPending}>{passwordPending ? 'Checking…' : 'Reauthenticate and retry'}</button></div>
    </form>
  </dialog>
{/if}

<style>
  .admin-catalog { max-width: 1280px; margin: 0 auto; padding: 2rem; text-align: left; color: #273331; }
  header { margin-bottom: 1.5rem; } header h1 { margin: .5rem 0; } header p { max-width: 760px; color: #64706d; }
  a { color: #24635a; } button, input, select, textarea { font: inherit; }
  button { border: 1px solid #49736d; border-radius: 4px; padding: .42rem .7rem; background: white; color: #244f49; cursor: pointer; }
  button:disabled { opacity: .55; cursor: default; } .primary { background: #27685e; color: white; } .danger { background: #8b2e2e; color: white; border-color: #8b2e2e; }
  .card { margin: 1.25rem 0; padding: 1.25rem; border-radius: 7px; background: white; box-shadow: 0 2px 10px #0002; }
  .card h2 { margin-top: 0; } h2 span { color: #71807d; font-size: .85rem; font-weight: 500; } .card > p { color: #64706d; }
  .notice { margin: 1rem 0; padding: .8rem; border-radius: 5px; } .error { color: #842029; background: #f8d7da; } .success { color: #15583c; background: #ddefe4; }
  .table-scroll { overflow-x: auto; margin: .75rem 0; } table { width: 100%; min-width: 840px; border-collapse: collapse; }
  th, td { padding: .55rem; border-bottom: 1px solid #dfe5e3; text-align: left; vertical-align: top; } th { color: #697572; font-size: .76rem; text-transform: uppercase; }
  td small, td strong { display: block; } td small { color: #697572; } code { font-size: .82rem; overflow-wrap: anywhere; }
  .book-cell { display: flex; gap: .55rem; align-items: flex-start; } .book-cell img, .detail-heading img { width: 38px; aspect-ratio: 2/3; object-fit: cover; }
  .candidate-cell { display: grid; gap: .35rem; } .candidate-cell button { text-align: left; } .candidate-cell small { font-weight: 400; }
  .finding-list { display: grid; gap: .7rem; padding: 0; list-style: none; } .finding-list li { padding: .75rem; border-left: 4px solid #c68a23; background: #fff8e9; }
  .finding-list li.error-finding { border-color: #a33; background: #fff0f0; } .finding-list p { margin: .35rem 0; } .finding-list span { text-transform: uppercase; font-size: .72rem; }
  .detail-heading { display: flex; align-items: flex-start; gap: .75rem; margin: 1rem 0; } .detail-heading h3, .detail-heading p { margin: 0 0 .2rem; } .detail-heading button { margin-left: auto; }
  .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: .7rem; } dt { color: #697572; font-size: .75rem; text-transform: uppercase; } dd { margin: .1rem 0; }
  .compact-list { display: grid; gap: .4rem; } .compact-list > div { display: flex; justify-content: space-between; gap: 1rem; padding: .55rem; background: #f5f7f6; }
  label { display: grid; gap: .25rem; color: #44514e; font-weight: 600; } label small { font-weight: 400; }
  input, select, textarea { width: 100%; padding: .48rem; border: 1px solid #aebbb8; border-radius: 4px; background: white; color: #273331; box-sizing: border-box; } textarea { min-height: 5rem; resize: vertical; }
  .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .85rem; margin: 1rem 0; } .wide { grid-column: 1 / -1; }
  .preview { margin-top: 1.2rem; padding: 1rem; border: 2px solid #27685e; border-radius: 6px; } .preview ol { padding-left: 1.4rem; }
  .preview li { margin: 1rem 0; } .diff { display: grid; grid-template-columns: 1fr 1fr; gap: .7rem; } pre { max-height: 320px; overflow: auto; padding: .6rem; background: #17201f; color: #e9f1ef; font-size: .75rem; white-space: pre-wrap; }
  dialog { max-width: 500px; border: 0; border-radius: 7px; box-shadow: 0 10px 40px #0006; } dialog::backdrop { background: #0008; } dialog form { display: grid; gap: .8rem; } .dialog-actions { display: flex; justify-content: flex-end; gap: .5rem; }
  .empty { color: #3d6d58; } .loading { padding: 2rem; color: #697572; } .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  @media (max-width: 700px) { .admin-catalog { padding: 1rem; } .form-grid, .diff { grid-template-columns: 1fr; } .wide { grid-column: auto; } .detail-heading { flex-wrap: wrap; } .detail-heading button { margin-left: 0; } }
</style>
