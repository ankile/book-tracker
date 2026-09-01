<script lang="ts">
  import { tick } from 'svelte';
  import { CATALOG_LIMITS } from '../../../shared/catalogLimits.ts';
  import { reauthenticateWithPassword } from '$lib/firebase/auth.ts';
  import { adminCatalogScan } from '$lib/firebase/adminCatalog.ts';
  import { adminCatalogApply, adminCatalogPreview } from '$lib/firebase/functions.ts';
  import type {
    AdminCatalogOperation,
    AdminCatalogPreviewResponse,
    CatalogAuthorInput,
    CatalogAuthorKind,
    CatalogEditionInput,
    CatalogWorkInput,
    EditionFormat,
  } from '$lib/interfaces/catalog.ts';
  import {
    adminCatalogCandidatesByBook,
    classifyAdminCatalogFailure,
    parseAdminBookTargets,
    parseAdminExternalIds,
    parseAdminStringList,
  } from '$lib/utils/adminCatalog.ts';
  import { normalizeIsbn } from '$lib/utils/isbn.ts';

  type OperationType = AdminCatalogOperation['type'];
  type PreviewState = {operation: AdminCatalogOperation; response: AdminCatalogPreviewResponse};

  // The scan is derived from live Firestore listeners the app prefetch opens
  // once the operator is signed in ($lib/firebase/adminCatalog.ts): the
  // console renders whatever is current and updates as documents change.
  // Nothing here fetches; an applied operation shows up when its writes
  // land, the same way anyone else's would.
  const scan = $derived($adminCatalogScan ?? null);
  let updatedAt = $state<Date | null>(null);
  $effect(() => {
    if (scan !== null) updatedAt = new Date();
  });

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
  let workStatus = $state<'active' | 'hidden'>('active');
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
    operationType, workId, workStatus, canonicalTitle, alternateTitles,
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

  // A selected work that a live update removed (a merge, say) is dropped
  // rather than left pointing at nothing.
  $effect(() => {
    if (scan !== null && selectedWorkId !== '' &&
        !scan.works.some((work) => work.workId === selectedWorkId)) {
      selectedWorkId = '';
    }
  });

  const unmatchedBooks = $derived(scan?.books.filter((book) => book.workId === null) ?? []);
  // A selection outlives the rows it named only while they are still
  // unmatched: a book another update linked drops out of the selection.
  $effect(() => {
    const live = new Set(unmatchedBooks.map((book) => `${book.uid}/${book.bookId}`));
    const kept = selectedBookKeys.filter((key) => live.has(key));
    if (kept.length !== selectedBookKeys.length) selectedBookKeys = kept;
  });
  // The two jobs this console exists for: works other accounts created
  // through the add-book flow (review: keep, edit, hide, or merge), and
  // things the scan thinks are the same book twice (merge works, or link a
  // book to the work it belongs to).
  const userCreatedWorks = $derived(
    [...(scan?.works ?? [])].filter((work) => work.createdBy !== null && work.status !== 'merged')
      .sort((left, right) => right.createdAt - left.createdAt),
  );
  const duplicateWorkFindings = $derived(
    (scan?.findings ?? []).filter((finding) => finding.code === 'suspected-duplicate-works'),
  );
  const candidatesByBook = $derived(scan === null ? new Map() : adminCatalogCandidatesByBook(scan));
  const unmatchedWithCandidates = $derived(
    unmatchedBooks
      .map((book) => ({book, candidates: candidatesByBook.get(`${book.uid}/${book.bookId}`) ?? []}))
      .filter(({candidates}) => candidates.length > 0),
  );
  const workById = $derived(new Map((scan?.works ?? []).map((work) => [work.workId, work])));
  const booksByWork = $derived.by(() => {
    const byWork = new Map<string, typeof unmatchedBooks>();
    for (const book of scan?.books ?? []) {
      if (book.workId === null) continue;
      byWork.set(book.workId, [...(byWork.get(book.workId) ?? []), book]);
    }
    return byWork;
  });
  function booksLinkedTo(id: string) {
    return booksByWork.get(id) ?? [];
  }
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
        status: workStatus,
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
        status: workStatus,
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

  // Form validation throws TypeError; anything else (the callable, a
  // response decoder) is reported as a failure of the operation itself.
  async function requestPreview(): Promise<void> {
    errorMessage = '';
    statusMessage = '';
    let operation: AdminCatalogOperation;
    try {
      operation = buildOperation();
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      errorMessage = error.message;
      return;
    }
    operationPending = true;
    try {
      const response = await adminCatalogPreview({operation});
      preview = {operation, response};
      previewDraftFingerprint = draftFingerprint;
      statusMessage = `Preview ready: ${response.touchedDocuments} documents would be touched.`;
    } catch (error) {
      console.error('Admin catalog preview failed', error);
      errorMessage = 'Preview failed. Nothing was changed; review the operation and try again.';
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
    return 'The catalog operation failed. Nothing was applied.';
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
      statusMessage = `Applied ${result.operationId}: ${result.touchedDocuments} documents changed. The console updates as the writes land.`;
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

  function focusOperation(): void {
    document.getElementById('operation-heading')?.scrollIntoView({behavior: 'smooth'});
  }

  function useSelectedBooks(): void {
    bookTargets = lines(selectedBookKeys);
    operationType = 'linkBooks';
    focusOperation();
  }

  function useCandidate(
    book: {uid: string; bookId: string},
    candidate: {workId: string; editionId: string | null},
  ): void {
    bookTargets = `${book.uid}/${book.bookId}`;
    linkTargetWorkId = candidate.workId;
    linkTargetEditionId = candidate.editionId ?? '';
    operationType = 'linkBooks';
    focusOperation();
  }

  let allDataOpen = $state(false);
  function inspectWork(id: string): void {
    selectedWorkId = id;
    allDataOpen = true;
    document.getElementById('work-detail-heading')?.scrollIntoView({behavior: 'smooth'});
  }
  function editWork(id: string): void {
    selectedWorkId = id;
    editSelectedWork();
  }
  // Hide is the soft delete: the work and its links stay, search and the
  // reader page skip it. Same editWork operation with the status flipped.
  function hideWork(id: string): void {
    selectedWorkId = id;
    editSelectedWork();
    workStatus = 'hidden';
  }
  // Prefill a merge with the oldest work as the survivor: it is the one
  // most books already point at.
  function mergeWorks(ids: readonly string[]): void {
    const works = ids.map((id) => workById.get(id)).filter((work) => work !== undefined)
      .sort((left, right) => left.createdAt - right.createdAt);
    if (works.length < 2) return;
    operationType = 'mergeWorks';
    mergeTarget = works[0].workId;
    mergeSources = lines(works.slice(1).map((work) => work.workId));
    focusOperation();
  }
  function mergeInto(sourceId: string): void {
    operationType = 'mergeWorks';
    mergeSources = sourceId;
    mergeTarget = '';
    focusOperation();
  }

  function editSelectedWork(): void {
    if (selectedWork === null) return;
    operationType = 'editWork';
    workId = selectedWork.workId;
    workStatus = selectedWork.status === 'hidden' ? 'hidden' : 'active';
    canonicalTitle = selectedWork.canonicalTitle;
    alternateTitles = lines(selectedWork.alternateTitles);
    workAuthorIds = lines(selectedWork.authorIds);
    workCoverUrl = selectedWork.coverUrl;
    subjects = lines(selectedWork.subjects);
    fiction = selectedWork.fiction === null ? 'unknown' : selectedWork.fiction ? 'fiction' : 'nonfiction';
    focusOperation();
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
    focusOperation();
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
    focusOperation();
  }
</script>

<svelte:head><title>Catalog · Book Tracker</title></svelte:head>

<main class="admin-catalog">
  <header>
    <nav><strong>Catalog</strong> · <a href="/admin/users">Accounts and issues</a></nav>
    <h1>Catalog</h1>
    <p class="toolbar">
      {#if scan === null}
        <small>Connecting to the catalog…</small>
      {:else}
        <small><span class="live"></span>Live · {scan.books.length} books across {scan.works.length} works · updated {updatedAt?.toLocaleTimeString() ?? ''}</small>
      {/if}
    </p>
    <p class="hint">Buttons on this page prefill the operation form at the bottom. Nothing changes until you preview and apply.</p>
  </header>

  {#if scan === null}
    <p class="loading">Waiting for the first catalog snapshot…</p>
  {:else}
    <section class="card" aria-labelledby="new-works-heading">
      <h2 id="new-works-heading">New works from readers <span>{userCreatedWorks.length}</span></h2>
      {#if userCreatedWorks.length === 0}
        <p class="empty">Nothing to review.</p>
      {:else}
        <div class="work-cards">
          {#each userCreatedWorks as work (work.workId)}
            {@const linked = booksLinkedTo(work.workId)}
            <article class="work-card" class:hidden-work={work.status === 'hidden'}>
              {#if work.coverUrl}<img src={work.coverUrl} alt="" referrerpolicy="no-referrer" />{:else}<div class="no-cover"></div>{/if}
              <div class="work-body">
                <h3>{work.canonicalTitle}</h3>
                <p>{catalogAuthorNames(work.authorIds)}</p>
                <small>
                  {new Date(work.createdAt).toISOString().slice(0, 10)} · by {work.createdBy?.slice(0, 8)}… ·
                  {work.editionCount} {work.editionCount === 1 ? 'edition' : 'editions'} ·
                  {linked.length} {linked.length === 1 ? 'reader' : 'readers'}{work.status === 'hidden' ? ' · hidden' : ''}
                </small>
                {#if linked.length > 0}
                  <ul class="linked">
                    {#each linked as book (`${book.uid}/${book.bookId}`)}
                      <li>{book.title} — {book.authorNames.join(', ')} · {book.pageCount ?? '—'} p</li>
                    {/each}
                  </ul>
                {/if}
                {#if work.warnings.length > 0}<p class="warning">{work.warnings.join(' · ')}</p>{/if}
              </div>
              <div class="actions">
                <button type="button" onclick={() => editWork(work.workId)}>Edit…</button>
                <button type="button" onclick={() => mergeInto(work.workId)}>Merge into…</button>
                {#if work.status !== 'hidden'}<button type="button" onclick={() => hideWork(work.workId)}>Hide…</button>{/if}
                <button type="button" onclick={() => inspectWork(work.workId)}>Details</button>
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
                      <strong>{work?.canonicalTitle ?? id}</strong>
                      <small>{work ? catalogAuthorNames(work.authorIds) : ''} · {booksLinkedTo(id).length} readers · {work?.editionCount ?? 0} editions · <code>{id}</code></small>
                    </li>
                  {/each}
                </ul>
              </div>
              <button class="primary" type="button" onclick={() => mergeWorks(finding.workIds)}>Merge into the oldest…</button>
            </div>
          {/each}
        </div>
      {/if}
      {#if unmatchedWithCandidates.length > 0}
        <h3>Books that probably belong to an existing work</h3>
        <div class="dupe-list">
          {#each unmatchedWithCandidates as {book, candidates} (`${book.uid}/${book.bookId}`)}
            <div class="dupe">
              <div>
                <p><strong>{book.title}</strong> — {book.authorNames.join(', ')} · {book.isbn13 ?? book.rawIsbn ?? 'no ISBN'} · reader {book.uid.slice(0, 8)}…</p>
              </div>
              <div class="actions">
                {#each candidates as candidate (`${book.uid}/${book.bookId}/${candidate.workId}`)}
                  <button type="button" onclick={() => useCandidate(book, candidate)}>Link to {candidate.title} <small>({candidate.label})</small></button>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <details class="card all-data" bind:open={allDataOpen}>
      <summary>All catalog data — {scan.authors.length} authors, {scan.works.length} works, {scan.editions.length} editions, {unmatchedBooks.length} unlinked of {scan.books.length} books, {scan.findings.length} findings</summary>
    <section aria-labelledby="catalog-authors-heading">
      <h2 id="catalog-authors-heading">Catalog authors <span>{scan.authors.length}/{CATALOG_LIMITS.catalogAuthors}</span></h2>
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
                <td><button type="button" disabled={author.status !== 'active'} onclick={() => editCatalogAuthor(author.authorId)}>Edit…</button></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <section aria-labelledby="works-heading">
      <h2 id="works-heading">Works <span>{scan.works.length}/{CATALOG_LIMITS.works}</span></h2>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Work</th><th>Created</th><th>Status</th><th>Editions</th><th>Linked books</th><th>Warnings</th><th></th></tr></thead>
          <tbody>
            <!-- Newest first: works users created through the add-book flow
                 land at the top for review (edit, merge, hide). -->
            {#each worksNewestFirst as work (work.workId)}
              <tr>
                <td><strong>{work.canonicalTitle}</strong><small>{catalogAuthorNames(work.authorIds)} · {work.workId}</small></td>
                <td>{new Date(work.createdAt).toISOString().slice(0, 10)}<small>{work.createdBy === null ? 'migration / admin' : `user ${work.createdBy.slice(0, 8)}…`}</small></td>
                <td>{work.status}</td><td>{work.editionCount}</td><td>{work.linkedBookCount}</td>
                <td>{work.warnings.length === 0 ? '—' : work.warnings.join(' · ')}</td>
                <td><button type="button" onclick={() => inspectWork(work.workId)}>Inspect</button></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <section aria-labelledby="unmatched-heading">
      <h2 id="unmatched-heading">Unmatched books <span>{unmatchedBooks.length} of {scan.books.length}</span></h2>
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
                  <td>{book.isbn13 ?? book.rawIsbn ?? '—'}</td><td>{book.pageCount ?? '—'}</td><td>{book.publisher || '—'}</td>
                  <td><code>{book.uid}/{book.bookId}</code></td>
                  <td class="candidate-cell">
                    {#each candidatesByBook.get(`${book.uid}/${book.bookId}`) ?? [] as candidate (`${book.uid}/${book.bookId}/${candidate.workId}`)}
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
      {/if}
    </section>

    <section aria-labelledby="findings-heading">
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

    <section aria-labelledby="work-detail-heading">
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
          <button type="button" onclick={editSelectedWork}>Edit this work…</button>
        </div>
        <dl class="facts">
          <div><dt>Status</dt><dd>{selectedWork.status}</dd></div>
          <div><dt>Aliases</dt><dd>{selectedWork.alternateTitles.join(' · ') || '—'}</dd></div><div><dt>Merged IDs</dt><dd>{selectedWork.mergedFrom.join(', ') || '—'}</dd></div>
        </dl>
        <h3>Editions</h3>
        <div class="compact-list">
          {#each selectedEditions as edition (edition.editionId)}
            <div><span><strong>{edition.title}</strong> · {edition.isbn13 ?? 'No ISBN'} · {edition.publisher || 'No publisher'}</span><button type="button" onclick={() => editEdition(edition.editionId)}>Edit edition…</button></div>
          {/each}
          {#if selectedEditions.length === 0}<p class="empty">No editions.</p>{/if}
        </div>
        <h3>Attached personal books</h3>
        <div class="compact-list">
          {#each selectedLinkedBooks as book (`${book.uid}/${book.bookId}`)}
            <div><span><strong>{book.title}</strong> · {book.authorNames.join(', ')} · {book.pageCount ?? '—'} pages</span><code>{book.uid}/{book.bookId}</code></div>
          {/each}
          {#if selectedLinkedBooks.length === 0}<p class="empty">No linked personal books.</p>{/if}
        </div>
      {/if}
    </section>
    </details>
  {/if}

  <section class="card operation" aria-labelledby="operation-heading">
    <h2 id="operation-heading">Run an operation</h2>
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
        <label>Status<select bind:value={workStatus}><option value="active">Active</option><option value="hidden">Hidden (soft delete: kept, not searchable)</option></select></label>
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
        <label>Target work <small>Leave blank to unlink.</small>
          <select bind:value={linkTargetWorkId}>
            <option value="">— unlink —</option>
            {#each worksNewestFirst as work (work.workId)}<option value={work.workId}>{work.canonicalTitle} ({work.workId})</option>{/each}
          </select>
        </label>
        <label>Target edition ID <small>Optional.</small><input bind:value={linkTargetEditionId} /></label>
      </div>
    {:else if operationType === 'mergeWorks'}
      <div class="form-grid">
        <label>Source work IDs, one per line<textarea bind:value={mergeSources}></textarea></label>
        <label>Canonical target work
          <select bind:value={mergeTarget}>
            <option value="">Choose the surviving work</option>
            {#each worksNewestFirst as work (work.workId)}<option value={work.workId}>{work.canonicalTitle} ({work.workId})</option>{/each}
          </select>
        </label>
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

    {#if errorMessage}<div class="notice error" role="alert">{errorMessage}</div>{/if}
    {#if statusMessage}<div class="notice success" role="status">{statusMessage}</div>{/if}
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
  header nav { font-size: .95rem; color: #64706d; } header nav strong { color: #244f49; }
  .hint { font-size: .9rem; margin: .5rem 0 0; }
  a { color: #24635a; } button, input, select, textarea { font: inherit; }
  button { border: 1px solid #49736d; border-radius: 4px; padding: .42rem .7rem; background: white; color: #244f49; cursor: pointer; }
  button:disabled { opacity: .55; cursor: default; } .primary { background: #27685e; color: white; } .danger { background: #8b2e2e; color: white; border-color: #8b2e2e; }
  .card { margin: 1.25rem 0; padding: 1.25rem; border-radius: 7px; background: white; box-shadow: 0 2px 10px #0002; }
  .card h2 { margin-top: 0; }
  .toolbar { display: flex; align-items: center; gap: .8rem; margin: .25rem 0 0; } .toolbar small { color: #71807d; }
  .live { display: inline-block; width: .55rem; height: .55rem; margin-right: .4rem; border-radius: 50%; background: #2e9e6b; vertical-align: middle; }
  .work-cards, .dupe-list { display: grid; gap: .8rem; }
  .work-card { display: grid; grid-template-columns: 56px 1fr auto; gap: .9rem; padding: .8rem; background: #f5f7f6; border-radius: 6px; align-items: start; }
  .work-card img, .no-cover { width: 56px; aspect-ratio: 2/3; object-fit: cover; border-radius: 3px; background: #dfe5e3; }
  .work-card h3, .work-card p { margin: 0 0 .2rem; } .work-card small { color: #697572; } .work-card .warning { color: #8b5a12; font-size: .85rem; }
  .work-card.hidden-work { opacity: .6; } .linked { margin: .4rem 0 0; padding-left: 1.1rem; font-size: .85rem; color: #44514e; }
  .actions { display: flex; flex-wrap: wrap; gap: .4rem; justify-content: flex-end; }
  .dupe { display: grid; grid-template-columns: 1fr auto; gap: .9rem; padding: .8rem; background: #fff8e9; border-left: 4px solid #c68a23; border-radius: 4px; align-items: start; }
  .dupe p { margin: 0 0 .3rem; } .dupe ul { margin: 0; padding-left: 1.1rem; } .dupe li small { display: block; color: #697572; }
  .all-data summary { cursor: pointer; font-weight: 600; color: #244f49; } .all-data > section { margin-top: 1.25rem; padding-top: 1rem; border-top: 1px solid #dfe5e3; } h2 span { color: #71807d; font-size: .85rem; font-weight: 500; } .card > p { color: #64706d; }
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
  @media (max-width: 700px) { .admin-catalog { padding: 1rem; } .form-grid, .diff, .work-card, .dupe { grid-template-columns: 1fr; } .wide { grid-column: auto; } .detail-heading { flex-wrap: wrap; } .detail-heading button { margin-left: 0; } }
</style>
