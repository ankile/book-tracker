<script lang="ts" module>
  import type { PlannedAuthor } from '../../interfaces/readingPlan.ts';
  import type { CatalogSelection } from '../../interfaces/catalog.ts';
  import type { BookMetadata } from '../../interfaces/metadata.ts';

  export interface PlannedEntryFields {
    title: string;
    authors: PlannedAuthor[];
    pageCount: number | null;
    isbn: string;
    metadata: BookMetadata;
    catalogLink: CatalogSelection | null;
  }
</script>

<script lang="ts">
  // Add or edit a planned book. The same catalog search, ISBN lookup and
  // author chips as the add-book modal, through the shared CatalogDraft and
  // completeBookDraft; a title alone is enough to save an intention.
  import AuthorInput from '../AuthorInput.svelte';
  import CatalogMatchPanel from '../CatalogMatchPanel.svelte';
  import Input from '../Input.svelte';
  import ModalCard from '../ModalCard.svelte';
  import { CatalogDraft } from '../catalogDraft.svelte.ts';
  import { Database } from '../../firebase/db.ts';
  import { user } from '../../firebase/auth.ts';
  import { catalogAddEdition, catalogCreate, lookupIsbn } from '../../firebase/functions.ts';
  import { effectiveLanguage, languageLabel } from '../../../../shared/language.ts';
  import type { Author, AuthorChip } from '../../interfaces/author.ts';
  import type { Book } from '../../interfaces/book.ts';
  import type { CatalogSearchResult } from '../../interfaces/catalog.ts';
  import type { PlannedEntry } from '../../interfaces/readingPlan.ts';
  import { AUTHOR_KINDS, resolveChip } from '../../utils/authors.ts';
  import { completeBookDraft } from '../../utils/bookDraft.ts';
  import { fillMissingItems, fillMissingPageCount, fillMissingText, MAX_BOOK_AUTHORS } from '../../utils/bookForm.ts';
  import { EMPTY_METADATA, selectLookupMetadata } from '../../utils/bookMetadata.ts';
  import { buildCatalogSearchRequest, linkedBooksForWork } from '../../utils/catalogClient.ts';
  import { normalizeIsbn } from '../../utils/isbn.ts';
  import { lookupIsbnSources } from '../../utils/isbnLookup.ts';
  import { acceptReportedWrite } from '../../utils/offlineWrite.ts';
  import { validateBookTitle } from '../../utils/validation.ts';

  let { open, userId, entry = null, plannedEntries, onsave, onclose }: {
    open: boolean;
    userId: string;
    entry?: PlannedEntry | null;
    plannedEntries: PlannedEntry[];
    onsave: (fields: PlannedEntryFields) => Promise<void>;
    onclose: () => void;
  } = $props();

  let authorChips = $state<AuthorChip[]>([]);
  let authorList = $state<Author[]>([]);
  let authorsLoaded = $state(false);
  $effect(() => {
    if (!open || !userId) return;
    const unsubscribe = Database.getAuthors().subscribe((authors) => {
      if (authors === undefined) return;
      authorList = authors;
      authorsLoaded = true;
    });
    return () => {
      unsubscribe();
      authorList = [];
      authorsLoaded = false;
    };
  });
  let allBooks = $state<Book[]>([]);
  $effect(() => {
    if (!open || !userId) return;
    return Database.getAllBooks(userId).subscribe((books) => {
      if (books !== undefined) allBooks = books;
    });
  });
  let online = $state(true);
  $effect(() => {
    const update = () => (online = navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  });

  let title = $state('');
  let pageCount = $state<number | null | undefined>(undefined);
  let isbn = $state('');
  let metadata = $state<BookMetadata>({ ...EMPTY_METADATA });
  const catalog = new CatalogDraft();
  let lookingUp = $state(false);
  let error = $state('');
  let settling = $state(false);
  let write = $state({ accepted: false });
  let request = 0;

  // Seed once per opened entry; a reopen for a different entry reseeds.
  let seededFor: string | null | undefined;
  $effect(() => {
    if (!open) {
      seededFor = undefined;
      authorChips = [];
      write.accepted = false;
      request += 1;
      settling = false;
      error = '';
      catalog.reset();
      return;
    }
    const id = entry?.id ?? null;
    if (seededFor === id) return;
    seededFor = id;
    title = entry?.title ?? '';
    pageCount = entry?.pageCount ?? undefined;
    isbn = entry?.isbn ?? '';
    metadata = entry === null ? { ...EMPTY_METADATA } : {
      coverUrl: entry.coverUrl, publisher: entry.publisher, publishedDate: entry.publishedDate,
      subjects: entry.subjects, fiction: entry.fiction, language: entry.language,
    };
    authorChips = entry === null ? [] : entry.authors.map((author) => (
      author.id === null ? { id: null, name: author.name, kind: 'person', ...splitName(author.name) } : { id: author.id, name: author.name }
    ));
    catalog.seed(entry?.catalogLink ?? null, entry?.catalogLink?.matchMethod === 'isbn' ? normalizeIsbn(entry.isbn) : null);
    error = '';
  });

  function splitName(name: string): { givenName: string; familyName: string } {
    const parts = name.trim().split(/\s+/);
    return { givenName: parts.slice(0, -1).join(' '), familyName: parts.at(-1) ?? '' };
  }

  const catalogAuthorNames = $derived(authorChips.map((chip) => chip.name).filter(Boolean));
  $effect(() => {
    if (!open || !authorsLoaded) return;
    const search = buildCatalogSearchRequest({ isbn, title, authorNames: catalogAuthorNames });
    return catalog.sync(search, online, (exact) => selectCatalogResult(exact, false));
  });

  // Books already in the library and intentions already in the plan for
  // the chosen work, so a duplicate is a choice rather than an accident.
  const duplicateBooks = $derived(catalog.selectedResult === null
    ? []
    : linkedBooksForWork(allBooks, catalog.selectedResult.work, null));
  const duplicatePlanned = $derived.by(() => {
    const work = catalog.selectedResult?.work;
    if (work === undefined) return [];
    const ids = new Set([work.workId, ...work.mergedFrom]);
    return plannedEntries.filter((planned) => planned.id !== entry?.id && planned.catalogLink !== null && ids.has(planned.catalogLink.workId));
  });
  const isbnMatches = $derived.by(() => {
    const normalized = normalizeIsbn(isbn);
    if (normalized === null) return [];
    return allBooks.filter((book) => normalizeIsbn(book.isbn) === normalized);
  });

  function selectCatalogResult(result: CatalogSearchResult, touched = true) {
    catalog.select(result, touched, isbn);
    title = fillMissingText(title, result.edition?.title || result.work.canonicalTitle);
    authorChips = fillMissingItems(
      authorChips,
      result.work.authors.slice(0, MAX_BOOK_AUTHORS).map((author) => resolveChip(author.canonicalName, authorList)),
    );
    pageCount = fillMissingPageCount(pageCount, [result.edition?.suggestedPageCount ?? undefined]);
    metadata = {
      coverUrl: fillMissingText(metadata.coverUrl, result.edition?.coverUrl || result.work.coverUrl),
      publisher: fillMissingText(metadata.publisher, result.edition?.publisher ?? ''),
      publishedDate: fillMissingText(metadata.publishedDate, result.edition?.publishedDate ?? ''),
      subjects: fillMissingItems(metadata.subjects, result.work.subjects),
      fiction: metadata.fiction ?? result.work.fiction,
      language: fillMissingText(metadata.language, effectiveLanguage(result.edition?.language ?? '', result.work.language)),
    };
  }

  async function lookupISBN() {
    const normalized = normalizeIsbn(isbn);
    if (normalized === null) {
      error = 'Not a valid ISBN-10 or ISBN-13 (check digit mismatch?)';
      return;
    }
    isbn = normalized;
    lookingUp = true;
    error = '';
    try {
      const { openLibrary, google, nb } = await lookupIsbnSources(normalized, {
        google: async (isbn13) => (await lookupIsbn({ isbn: isbn13 })).data,
      });
      const primary = openLibrary ?? google ?? nb;
      if (primary === null) {
        error = 'No book found for this ISBN';
        return;
      }
      title = fillMissingText(title, primary.title);
      authorChips = fillMissingItems(
        authorChips,
        primary.authorNames.slice(0, MAX_BOOK_AUTHORS).map((name) => resolveChip(name, authorList)),
      );
      pageCount = fillMissingPageCount(pageCount, [primary.pageCount, google?.pageCount, nb?.pageCount]);
      metadata = selectLookupMetadata(openLibrary, google, nb);
    } catch (failure) {
      error = 'Failed to look up ISBN. Please try again.';
      console.error('ISBN lookup error:', failure);
    } finally {
      lookingUp = false;
    }
  }

  function plannedAuthors(chips: AuthorChip[]): PlannedAuthor[] {
    return chips.map((chip) => ({ id: chip.id, name: chip.name }));
  }

  async function submit() {
    if (settling) return;
    error = '';
    if ($user && !$user.emailVerified) {
      error = 'Verify your email address to plan books.';
      return;
    }
    if (!authorsLoaded) {
      error = 'Authors loading.';
      return;
    }
    const titleResult = validateBookTitle(title);
    if (!titleResult.valid) {
      error = titleResult.message;
      return;
    }
    if (authorChips.length > MAX_BOOK_AUTHORS) {
      error = `A book may reference at most ${MAX_BOOK_AUTHORS} authors.`;
      return;
    }
    if (authorChips.some((chip) => chip.id !== null && 'unresolved' in chip)) {
      error = 'Remove each unresolved author and select or create a replacement before saving.';
      return;
    }
    // A cleared number input binds as null; an untouched one as undefined.
    const pages = pageCount === null || pageCount === undefined ? null : Number(pageCount);
    if (pages !== null && (!Number.isInteger(pages) || pages <= 0)) {
      error = 'Page count must be a positive whole number, or left empty.';
      return;
    }
    const trimmedIsbn = normalizeIsbn(isbn) ?? isbn.trim();
    if (trimmedIsbn.length > 32) {
      error = 'ISBN must be at most 32 characters — enter just the number.';
      return;
    }
    let chips = authorChips;
    let link = $state.snapshot(catalog.selection);
    // Online, new authors are minted and the catalog link completed the way
    // a book's would be; offline, typed names are kept as names and the
    // link stays as chosen, so a title is always enough to save.
    if (online) {
      const current = ++request;
      settling = true;
      const completion = await completeBookDraft({
        online,
        authorChips,
        catalogSelection: link,
        selectedWorkLanguage: catalog.selectedResult?.work.language ?? '',
        catalogChoiceTouched: catalog.choiceTouched,
        title: titleResult.title,
        isbn: trimmedIsbn,
        pageCount: pages,
        metadata: $state.snapshot(metadata),
      }, {
        resolveAuthors: (toResolve) => Database.resolveBookAuthors(toResolve),
        addEdition: catalogAddEdition,
        createWork: catalogCreate,
        cancelled: () => !open || current !== request,
      });
      settling = false;
      if (!open || current !== request) return;
      if (!completion.ok) {
        error = completion.message;
        return;
      }
      chips = completion.authorChips;
      link = completion.catalogSelection;
      authorChips = chips;
      catalog.selection = link;
      catalog.choiceTouched = completion.catalogChoiceTouched;
    }
    const fields: PlannedEntryFields = {
      title: titleResult.title,
      authors: plannedAuthors(chips),
      pageCount: pages,
      isbn: trimmedIsbn,
      metadata: $state.snapshot(metadata),
      catalogLink: link,
    };
    void acceptReportedWrite(
      write,
      () => onsave(fields),
      onclose,
      (failure) => { error = failure instanceof Error ? failure.message : String(failure); },
    );
  }
</script>

<style>
  .space {
    height: 1em;
  }

  .new-author-detail {
    display: flex;
    gap: 0.4rem;
    margin: 0.4rem 2em 0;
  }

  .new-author-detail .detail-kind {
    flex: 0 0 auto;
    width: auto;
  }

  .new-author-detail input {
    min-width: 0;
  }

  .isbn-container {
    display: flex;
    gap: 0.5rem;
    align-items: flex-start;
  }

  .isbn-input-wrapper {
    flex: 1;
  }

  .lookup-button {
    padding: 0.375rem 0.75rem;
    background-color: #1b7179;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.9rem;
    white-space: nowrap;
    height: fit-content;
    min-height: 44px;
    margin-top: 1.6rem;
  }

  .lookup-button:disabled {
    background-color: #6c757d;
    cursor: not-allowed;
  }

  .error {
    color: #d9534f;
    font-size: 0.85rem;
    margin: 0.25rem 2em 0;
  }

  .hint {
    color: #53636a;
    font-size: 0.85rem;
    margin: 0.25rem 2em 0;
  }

  .metadata-preview {
    display: flex;
    gap: 0.75rem;
    align-items: flex-start;
    margin: 0.75rem 2em 0;
    font-size: 0.85rem;
    color: #6c757d;
  }

  .cover-thumb {
    width: 3.5rem;
    flex: 0 0 auto;
    border-radius: 3px;
  }
</style>

<ModalCard
  {open}
  onclose={() => onclose()}
  header={entry === null ? 'Add to plan' : 'Edit planned book'}
  primaryText={entry === null ? 'Add to plan' : 'Save changes'}
  primaryDisabled={!authorsLoaded || settling || write.accepted}
  primaryAction={submit}>
  <Input label="Book title" inputId="plan-title">
    <input id="plan-title" class="form-control" type="text" bind:value={title} placeholder="Book title" />
  </Input>

  <div class="space"></div>

  <Input label="Author (optional)" inputId="plan-author">
    <AuthorInput bind:chips={authorChips} authors={authorList} inputId="plan-author" disabled={settling} />
  </Input>

  {#each authorChips.filter((c) => c.id === null) as chip (chip)}
    <div class="new-author-detail">
      <select class="form-select detail-kind" aria-label={`Kind of new author ${chip.name}`} disabled={settling} bind:value={chip.kind}>
        {#each AUTHOR_KINDS as kind (kind)}<option value={kind}>{kind}</option>{/each}
      </select>
      {#if chip.kind === 'person'}
        <input type="text" class="form-control" placeholder="First name(s)" aria-label={`First name(s) of ${chip.name}`} disabled={settling} bind:value={chip.givenName} />
        <input type="text" class="form-control" placeholder="Last name" aria-label={`Last name of ${chip.name}`} required disabled={settling} bind:value={chip.familyName} />
      {:else}
        <input type="text" class="form-control" placeholder="Name" aria-label={`Name of ${chip.name}`} required disabled={settling} bind:value={chip.name} />
      {/if}
    </div>
  {/each}

  <div class="space"></div>

  <Input label="Page count (optional)" inputId="plan-page-count">
    <input id="plan-page-count" class="form-control" type="number" inputmode="numeric" min="1" bind:value={pageCount} placeholder="Add it later if you don't know" />
  </Input>
  <p class="hint">Without a page count the book keeps its place but has no finish date yet.</p>

  <div class="space"></div>

  <div class="isbn-container">
    <div class="isbn-input-wrapper">
      <Input label="ISBN number (optional)" inputId="plan-isbn">
        <input id="plan-isbn" class="form-control" type="text" bind:value={isbn} placeholder="ISBN" />
      </Input>
    </div>
    <button type="button" class="lookup-button" onclick={lookupISBN} disabled={lookingUp || !isbn.trim()}>
      {lookingUp ? 'Looking up...' : 'Look up'}
    </button>
  </div>

  {#if isbnMatches.length > 0}
    <p class="hint" role="status">You already have {isbnMatches.map((book) => book.title).join(', ')} with this ISBN.</p>
  {/if}
  {#if duplicatePlanned.length > 0}
    <p class="hint" role="status">Already in your plan: {duplicatePlanned.map((planned) => planned.title).join(', ')}.</p>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}

  {#if metadata.coverUrl || metadata.subjects.length > 0}
    <div class="metadata-preview">
      {#if metadata.coverUrl}
        <img class="cover-thumb" src={metadata.coverUrl} alt="Cover of {title}" referrerpolicy="no-referrer" />
      {/if}
      <div>
        {#if metadata.fiction !== null}<div>{metadata.fiction ? 'Fiction' : 'Non-fiction'}</div>{/if}
        {#if metadata.subjects.length > 0}<div>{metadata.subjects.slice(0, 6).join(' · ')}</div>{/if}
        {#if metadata.publisher || metadata.publishedDate}<div>{[metadata.publisher, metadata.publishedDate].filter(Boolean).join(', ')}</div>{/if}
        {#if metadata.language}<div>{languageLabel(metadata.language)}</div>{/if}
      </div>
    </div>
  {/if}

  <CatalogMatchPanel
    suggestions={catalog.results}
    selected={catalog.selection}
    selectedResult={catalog.selectedResult}
    duplicates={duplicateBooks}
    loading={catalog.loading}
    {online}
    message={catalog.message}
    onselect={selectCatalogResult}
    onremove={() => catalog.remove()} />
</ModalCard>
