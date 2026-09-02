<script lang="ts">
  import { tick } from 'svelte';
  import { FunctionsError } from 'firebase/functions';
  import { reauthenticateWithPassword } from '$lib/firebase/auth.ts';
  import { adminCatalogApply, adminCatalogPreview, lookupIsbn } from '$lib/firebase/functions.ts';
  import { normalizeIsbn } from '$lib/utils/isbn.ts';
  import { lookupIsbnSources, primaryLookup } from '$lib/utils/isbnLookup.ts';
  import { selectLookupMetadata } from '$lib/utils/bookMetadata.ts';
  import type {
    AdminCatalogOperation,
    AdminCatalogPreviewResponse,
    CatalogScan,
  } from '$lib/interfaces/catalog.ts';
  import { COMMON_LANGUAGES } from '../../../../shared/language.ts';
  import { catalogAuthorIdFor, classifyAdminCatalogFailure } from '$lib/utils/adminCatalog.ts';
  import {
    buildOperation,
    newestFirst,
    operationTitle,
    sortAuthors,
    type OperationDraft,
  } from '$lib/utils/adminCatalogView.ts';

  // One dialog per console page. The page opens it by assigning a prefilled
  // draft (src/lib/utils/adminCatalogView.ts) and the dialog closes itself
  // by assigning null: on cancel, or once an apply has landed. Preview and
  // apply are the two callables; a preview is pinned to the draft it was
  // made from and dropped the moment the draft changes.
  interface Props {
    draft: OperationDraft | null;
    scan: CatalogScan | null;
    onapplied: (message: string) => void;
  }

  let { draft = $bindable(), scan, onapplied }: Props = $props();

  type PreviewState = {operation: AdminCatalogOperation; response: AdminCatalogPreviewResponse};
  let dialog = $state<HTMLDialogElement>();
  let preview = $state<PreviewState | null>(null);
  let previewFingerprint = $state<string | null>(null);
  let pending = $state(false);
  let lookingUp = $state(false);
  let errorMessage = $state('');
  let statusMessage = $state('');

  let passwordPromptOpen = $state(false);
  let password = $state('');
  let passwordPending = $state(false);
  let passwordInput = $state<HTMLInputElement>();
  let passwordDialog = $state<HTMLDialogElement>();
  let applyButton = $state<HTMLButtonElement>();
  let passwordReturnFocus: HTMLElement | null = null;

  const open = $derived(draft !== null);
  $effect(() => {
    if (open && dialog !== undefined && !dialog.open) {
      preview = null;
      previewFingerprint = null;
      errorMessage = '';
      statusMessage = '';
      dialog.showModal();
    } else if (!open && dialog?.open) {
      dialog.close();
    }
  });

  $effect(() => {
    if (passwordPromptOpen && passwordDialog !== undefined && !passwordDialog.open) {
      passwordDialog.showModal();
    } else if (!passwordPromptOpen && passwordDialog?.open) {
      passwordDialog.close();
    }
  });

  const fingerprint = $derived(JSON.stringify(draft));
  $effect(() => {
    if (preview !== null && previewFingerprint !== null && fingerprint !== previewFingerprint) {
      preview = null;
      previewFingerprint = null;
      statusMessage = 'The draft changed. Create a fresh preview before applying.';
    }
  });

  const targetWorks = $derived(
    [...(scan?.works ?? [])].filter((work) => work.status !== 'merged').sort(newestFirst),
  );
  const activeAuthors = $derived(
    sortAuthors((scan?.authors ?? []).filter((author) => author.status === 'active')),
  );
  const editions = $derived(scan?.editions ?? []);
  // An ISBN can only be repointed to a live edition, of any work; the work
  // is named so two editions with one title can be told apart.
  const repointTargets = $derived(editions.filter((edition) => edition.status === 'active'));
  const workTitles = $derived(new Map((scan?.works ?? []).map((work) => [work.workId, work.canonicalTitle])));
  const workTitle = (workId: string): string => workTitles.get(workId) ?? workId;
  // Only active editions can be stood on or merged into; a merge's sources
  // are not offered as its survivor.
  const targetEditions = $derived.by(() => {
    const current = draft;
    if (current?.type === 'linkBooks') {
      return editions.filter((edition) => edition.workId === current.targetWorkId && edition.status === 'active');
    }
    if (current?.type === 'mergeEditions') {
      const sources = new Set(current.sourceEditionIds.split(/\s+/u).filter(Boolean));
      return editions.filter((edition) =>
        edition.workId === current.workId && edition.status === 'active' && !sources.has(edition.editionId));
    }
    return [];
  });
  // A target edition must belong to the target work; changing the work
  // clears an edition that no longer does.
  $effect(() => {
    const current = draft;
    if (current?.type === 'linkBooks' && current.targetEditionId !== '' &&
        !targetEditions.some((edition) => edition.editionId === current.targetEditionId)) {
      current.targetEditionId = '';
    }
  });

  function close(): void {
    draft = null;
  }

  // Form validation throws TypeError; anything else (the callable, a
  // response decoder) is reported as a failure of the operation itself.
  async function requestPreview(): Promise<void> {
    const current = draft;
    if (current === null) return;
    errorMessage = '';
    statusMessage = '';
    if (current.type === 'upsertAuthor' && current.authorId.trim() === '' &&
        current.canonicalName.trim() !== '') {
      current.authorId = await catalogAuthorIdFor(current.canonicalName);
    }
    let operation: AdminCatalogOperation;
    try {
      operation = buildOperation(current);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      errorMessage = error.message;
      return;
    }
    pending = true;
    try {
      const response = await adminCatalogPreview({operation});
      preview = {operation, response};
      previewFingerprint = fingerprint;
      statusMessage = `Preview ready: ${response.touchedDocuments} documents would be touched.`;
    } catch (error) {
      console.error('Admin catalog preview failed', error);
      errorMessage = failureMessage(
        error, 'Preview failed. Nothing was changed; review the operation and try again.',
      );
    } finally {
      pending = false;
    }
  }

  // The edition form's ISBN lookup: the same three sources the add-book
  // form asks, filling only the fields the operator left blank.
  async function lookUpEditionIsbn(): Promise<void> {
    const current = draft;
    if (current?.type !== 'upsertEdition') return;
    const isbn13 = normalizeIsbn(current.isbn);
    if (isbn13 === null) {
      errorMessage = 'Not a valid ISBN-10 or ISBN-13 (check digit mismatch?).';
      return;
    }
    current.isbn = isbn13;
    lookingUp = true;
    errorMessage = '';
    statusMessage = '';
    try {
      const sources = await lookupIsbnSources(isbn13, {
        google: async (isbn) => (await lookupIsbn({isbn})).data,
      });
      const primary = primaryLookup(sources);
      if (primary === null) {
        errorMessage = 'No book found for this ISBN.';
        return;
      }
      const metadata = selectLookupMetadata(sources.openLibrary, sources.google, sources.nb);
      const filled: string[] = [];
      const fill = (field: 'title' | 'publisher' | 'publishedDate' | 'coverUrl' | 'language' | 'pageCount', value: string, label: string): void => {
        if (current[field].trim() !== '' || value === '') return;
        current[field] = value;
        filled.push(label);
      };
      fill('title', primary.title, 'title');
      fill('publisher', metadata.publisher, 'publisher');
      fill('publishedDate', metadata.publishedDate, 'date');
      fill('coverUrl', metadata.coverUrl, 'cover');
      fill('language', metadata.language, 'language');
      const pages = primary.pageCount ?? sources.google?.pageCount ?? sources.nb?.pageCount;
      fill('pageCount', pages === undefined ? '' : String(pages), 'pages');
      statusMessage = filled.length === 0 ?
        'The ISBN answered, but every field already had a value.' :
        `Filled ${filled.join(', ')} from the ISBN; what you had typed was kept.`;
    } catch (error) {
      console.error('ISBN lookup failed', error);
      errorMessage = 'Failed to look up the ISBN. Try again.';
    } finally {
      lookingUp = false;
    }
  }

  // The server's own reason rides along where it has one, so "identity
  // invariant" names the invariant.
  function failureMessage(
    error: unknown,
    fallback = 'The catalog operation failed. Nothing was applied.',
  ): string {
    const reason = error instanceof FunctionsError && error.message !== '' ? ` (${error.message})` : '';
    const failure = classifyAdminCatalogFailure(error);
    if (failure.kind === 'stale-preview') {
      preview = null;
      previewFingerprint = null;
      return 'This preview is stale because catalog links or metadata changed. Nothing was applied; create a fresh preview.';
    }
    if (failure.kind === 'operation-too-large') {
      return `This operation would touch more than ${failure.maxTouchedDocuments} documents. Split it into smaller operations.`;
    }
    if (failure.kind === 'catalog-capacity') {
      return `The ${failure.collection} catalog capacity (${failure.maximum}) has been reached. Edit, merge, or unlink existing records before creating another.`;
    }
    if (failure.kind === 'catalog-invariant') {
      return `The operation would violate a catalog identity invariant${reason}. Nothing was applied.`;
    }
    if (failure.kind === 'identifier-conflict') {
      return `An ISBN or external identifier is already assigned elsewhere${reason}. Nothing was applied.`;
    }
    return `${fallback}${reason}`;
  }

  async function applyPreview(confirmFirst = true): Promise<void> {
    if (preview === null) return;
    if (confirmFirst && !confirm(
      `Apply operation ${preview.response.operationId} and its ${preview.response.changes.length} exact changes?`,
    )) return;
    pending = true;
    errorMessage = '';
    statusMessage = '';
    try {
      const result = await adminCatalogApply({
        operationId: preview.response.operationId,
        operation: preview.operation,
        expected: preview.response.expected,
      });
      preview = null;
      previewFingerprint = null;
      onapplied(`Applied ${result.operationId}: ${result.touchedDocuments} documents changed. The page updates as the writes land.`);
      draft = null;
    } catch (error) {
      const failure = classifyAdminCatalogFailure(error);
      if (failure.kind === 'recent-auth-required') {
        await promptForRecentAuthentication();
      } else {
        console.error('Admin catalog apply failed', error);
        errorMessage = failureMessage(error);
      }
    } finally {
      pending = false;
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
      await applyPreview(false);
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
</script>

<dialog
  bind:this={dialog}
  class="operation"
  aria-labelledby="operation-heading"
  oncancel={(event) => { event.preventDefault(); if (!passwordPromptOpen) close(); }}>
  {#if draft !== null}
    <form onsubmit={(event) => { event.preventDefault(); void requestPreview(); }}>
      <h2 id="operation-heading">{operationTitle(draft)}</h2>

      {#if draft.type === 'upsertAuthor'}
        <div class="form-grid">
          <label>Canonical name<input bind:value={draft.canonicalName} /></label>
          <label>Sort name<input bind:value={draft.sortName} /></label>
          <label>Kind<select bind:value={draft.kind}><option value="person">Person</option><option value="entity">Entity</option><option value="placeholder">Placeholder</option></select></label>
          <label>Author ID <small>Blank derives it from the canonical name, as the add-book flow does.</small><input bind:value={draft.authorId} autocomplete="off" /></label>
          <label class="wide">Alternate names, one per line<textarea bind:value={draft.alternateNames}></textarea></label>
        </div>
      {:else if draft.type === 'mergeAuthors'}
        <div class="form-grid">
          <label>Source author <small>Becomes an alias of the target.</small>
            <select bind:value={draft.sourceAuthorId}>
              <option value="">Choose the author to absorb</option>
              {#each activeAuthors as author (author.authorId)}<option value={author.authorId}>{author.canonicalName} ({author.authorId})</option>{/each}
            </select>
          </label>
          <label>Canonical target author
            <select bind:value={draft.targetAuthorId}>
              <option value="">Choose the surviving author</option>
              {#each activeAuthors as author (author.authorId)}<option value={author.authorId}>{author.canonicalName} ({author.authorId})</option>{/each}
            </select>
          </label>
        </div>
      {:else if draft.type === 'createWork' || draft.type === 'editWork'}
        <div class="form-grid">
          <label class="wide">Canonical title<input bind:value={draft.canonicalTitle} /></label>
          <label>Catalog author IDs, one per line<textarea bind:value={draft.authorIds}></textarea></label>
          <label>Alternate titles, one per line<textarea bind:value={draft.alternateTitles}></textarea></label>
          <label>Status<select bind:value={draft.status}><option value="active">Active</option><option value="hidden">Hidden (soft delete: kept, not searchable)</option></select></label>
          <label>Fiction<select bind:value={draft.fiction}><option value="unknown">Unknown</option><option value="fiction">Fiction</option><option value="nonfiction">Nonfiction</option></select></label>
          <label>Language <small>The language its editions are in unless one says otherwise; a code such as en or no, blank for unknown.</small><input list="language-codes" bind:value={draft.language} autocomplete="off" /></label>
          <label>Cover URL<input type="url" bind:value={draft.coverUrl} /></label>
          <label>Subjects, one per line<textarea bind:value={draft.subjects}></textarea></label>
          <label>Work ID<input bind:value={draft.workId} autocomplete="off" readonly={draft.type === 'editWork'} /></label>
          {#if draft.type === 'createWork'}
            <label>Personal books to link, uid/bookId per line<textarea bind:value={draft.bookTargets}></textarea></label>
          {/if}
        </div>
      {:else if draft.type === 'linkBooks'}
        <div class="form-grid">
          <label class="wide">Personal books, uid/bookId per line<textarea bind:value={draft.bookTargets}></textarea></label>
          <label>Target work <small>Leave blank to unlink.</small>
            <select bind:value={draft.targetWorkId}>
              <option value="">— unlink —</option>
              {#each targetWorks as work (work.workId)}<option value={work.workId}>{work.canonicalTitle} ({work.workId})</option>{/each}
            </select>
          </label>
          <label>Target edition <small>Blank mints one edition per book from the book's own fields.</small>
            <select bind:value={draft.targetEditionId} disabled={draft.targetWorkId === ''}>
              <option value="">— mint from each book —</option>
              {#each targetEditions as edition (edition.editionId)}<option value={edition.editionId}>{edition.title} · {edition.isbn13 ?? 'no ISBN'} ({edition.editionId})</option>{/each}
            </select>
          </label>
        </div>
      {:else if draft.type === 'mergeWorks'}
        <div class="form-grid">
          <label>Source work IDs, one per line <small>They become aliases of the target, which keeps its own values and takes the titles, subjects, cover, fiction flag and language it lacks.</small><textarea bind:value={draft.sourceWorkIds}></textarea></label>
          <label>Canonical target work
            <select bind:value={draft.targetWorkId}>
              <option value="">Choose the surviving work</option>
              {#each targetWorks as work (work.workId)}<option value={work.workId}>{work.canonicalTitle} ({work.workId})</option>{/each}
            </select>
          </label>
        </div>
      {:else if draft.type === 'mergeEditions'}
        <div class="form-grid">
          <label>Work ID<input bind:value={draft.workId} autocomplete="off" readonly /></label>
          <label>Source edition IDs, one per line <small>They become aliases of the survivor. The survivor keeps its own values and takes what it lacks from them (ISBN, external IDs, publisher, date, cover, language, translators, format, pages); every reader's book on the merged edition inherits what it left blank.</small><textarea bind:value={draft.sourceEditionIds}></textarea></label>
          <label>Surviving edition
            <select bind:value={draft.targetEditionId}>
              <option value="">Choose the surviving edition</option>
              {#each targetEditions as edition (edition.editionId)}<option value={edition.editionId}>{edition.title}{edition.isbn13 ? ` · ${edition.isbn13}` : ''}{edition.publisher ? ` · ${edition.publisher}` : ''} ({edition.editionId})</option>{/each}
            </select>
          </label>
        </div>
      {:else if draft.type === 'upsertEdition'}
        <div class="form-grid">
          <label class="wide">Edition title<input bind:value={draft.title} /></label>
          <label>Work
            <select bind:value={draft.workId}>
              <option value="">Choose the work</option>
              {#each targetWorks as work (work.workId)}<option value={work.workId}>{work.canonicalTitle} ({work.workId})</option>{/each}
            </select>
          </label>
          <label>Edition ID<input bind:value={draft.editionId} autocomplete="off" /></label>
          <div class="field-row">
            <label>ISBN<input bind:value={draft.isbn} inputmode="numeric" /></label>
            <button type="button" disabled={lookingUp || pending} onclick={() => void lookUpEditionIsbn()}>{lookingUp ? 'Looking up…' : 'Look up'}</button>
          </div>
          <label>Suggested pages<input bind:value={draft.pageCount} inputmode="numeric" /></label>
          <label>Publisher<input bind:value={draft.publisher} /></label>
          <label>Published date<input bind:value={draft.publishedDate} /></label>
          <label>Language <small>Blank inherits the work's language; set it only where this edition differs.</small><input list="language-codes" bind:value={draft.language} autocomplete="off" /></label>
          <label>Format<select bind:value={draft.format}><option value="unknown">Unknown</option><option value="full">Full</option><option value="abridged">Abridged</option><option value="revised">Revised</option></select></label>
          <label>Translators, one per line<textarea bind:value={draft.translatorNames}></textarea></label>
          <label>External IDs, provider=id per line<textarea bind:value={draft.externalIds}></textarea></label>
          <label class="wide">Cover URL<input type="url" bind:value={draft.coverUrl} /></label>
        </div>
      {:else}
        <div class="form-grid">
          <label>ISBN<input bind:value={draft.isbn} inputmode="numeric" /></label>
          <label>New edition
            <select bind:value={draft.editionId}>
              <option value="">Choose the edition</option>
              {#each repointTargets as edition (edition.editionId)}<option value={edition.editionId}>{edition.title} · {edition.isbn13 ?? 'no ISBN'} · {workTitle(edition.workId)} ({edition.editionId})</option>{/each}
            </select>
          </label>
        </div>
      {/if}

      <datalist id="language-codes">
        {#each COMMON_LANGUAGES as language (language.code)}<option value={language.code}>{language.label}</option>{/each}
      </datalist>

      {#if errorMessage}<div class="notice error" role="alert">{errorMessage}</div>{/if}
      {#if statusMessage}<div class="notice success" role="status">{statusMessage}</div>{/if}

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
        </section>
      {/if}

      <div class="dialog-actions">
        <button type="button" onclick={close} disabled={pending}>Cancel</button>
        <button class="primary" type="submit" disabled={pending}>{pending ? 'Working…' : 'Preview without applying'}</button>
        {#if preview}
          <button bind:this={applyButton} class="danger" type="button" disabled={pending} onclick={() => void applyPreview()}>Apply these exact changes</button>
        {/if}
      </div>
    </form>
  {/if}

  {#if passwordPromptOpen}
    <dialog
      bind:this={passwordDialog}
      class="reauth"
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
</dialog>

<style>
  /* Buttons, fields, notices and code come from admin.css: the dialog sits
     inside the console page that imports it. Only the dialog's own layout
     lives here. */
  dialog {
    padding: 0;
    color: #263331;
    text-align: left;
    border: 0;
    border-radius: 14px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
  }

  dialog::backdrop {
    background: rgba(18, 30, 30, 0.55);
  }

  .operation {
    width: min(960px, calc(100vw - 2rem));
    max-height: calc(100vh - 2rem);
    padding: 1.5rem 1.75rem;
    box-sizing: border-box;
  }

  .reauth {
    width: min(500px, calc(100vw - 2rem));
    padding: 1.5rem 1.75rem;
    box-sizing: border-box;
  }

  .reauth form {
    display: grid;
    gap: 0.8rem;
  }

  .reauth p {
    margin: 0;
    color: #4a5754;
    font-size: 0.93rem;
  }

  h2 {
    margin: 0 0 0.25rem;
    font-size: 1.35rem;
    font-weight: 700;
  }

  label {
    display: grid;
    gap: 0.3rem;
    color: #3f4d4a;
    font-size: 0.86rem;
    font-weight: 650;
  }

  label small {
    color: #6b7673;
    font-size: 0.8rem;
    font-weight: 400;
  }

  .form-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem 1.25rem;
    margin: 1.25rem 0;
  }

  .wide {
    grid-column: 1 / -1;
  }

  .field-row {
    display: flex;
    gap: 0.5rem;
    align-items: flex-end;
  }

  .field-row label {
    flex: 1 1 auto;
  }

  .field-row button {
    min-height: 42px;
    white-space: nowrap;
  }

  .preview {
    margin-top: 1.25rem;
    padding: 1.15rem 1.25rem;
    background: #f5f9f9;
    border: 1px solid #cfe0e0;
    border-radius: 10px;
  }

  .preview h3 {
    margin: 0 0 0.35rem;
    font-size: 1.05rem;
    font-weight: 700;
  }

  .preview > p {
    margin: 0 0 0.75rem;
    color: #4a5754;
    font-size: 0.9rem;
  }

  .preview summary {
    color: #2f666b;
    font-weight: 650;
    cursor: pointer;
  }

  .preview ol {
    margin: 0.75rem 0 0;
    padding-left: 1.4rem;
  }

  .preview li {
    margin: 0.9rem 0;
  }

  .preview li strong {
    display: block;
    margin-bottom: 0.35rem;
    font-weight: 650;
  }

  .diff {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.7rem;
  }

  .diff span {
    display: block;
    margin-bottom: 0.25rem;
    color: #6b7673;
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  pre {
    max-height: 320px;
    margin: 0.4rem 0 0;
    padding: 0.7rem 0.8rem;
    overflow: auto;
    color: #e7f0ee;
    font-size: 0.75rem;
    white-space: pre-wrap;
    background: #1c2726;
    border-radius: 8px;
  }

  .dialog-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.6rem;
    margin-top: 1.25rem;
    padding-top: 1.25rem;
    border-top: 1px solid #e4e9e7;
  }

  @media (max-width: 700px) {
    .operation,
    .reauth {
      padding: 1.15rem 1.15rem;
    }

    .form-grid,
    .diff {
      grid-template-columns: 1fr;
    }

    .wide {
      grid-column: auto;
    }
  }
</style>
