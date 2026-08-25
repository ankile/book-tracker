<script lang="ts">
  import ModalCard from "$lib/components/ModalCard.svelte";
  import Input from "$lib/components/Input.svelte";
  import AuthorInput from "$lib/components/AuthorInput.svelte";

  import { Database } from "../firebase/db.ts";
  import { editableBookAuthorChips, resolveChip, AUTHOR_KINDS } from "../utils/authors.ts";
  import { normalizeIsbn } from "../utils/isbn.ts";
  import { EMPTY_METADATA, parseOpenLibraryBook } from "../utils/bookMetadata.ts";
  import { parseGoogleVolume, mergeMetadata } from "../utils/googleBooks.ts";
  import { nbSearchUrl, nbModsUrl, parseNbItem, extractModsGenres } from "../utils/nasjonalbiblioteket.ts";
  import { lookupIsbn } from "../firebase/functions.ts";
  import type { Author, AuthorChip } from "../interfaces/author.ts";
  import type { Book } from "../interfaces/book.ts";
  import type { BookMetadata, BookLookupResult } from "../interfaces/metadata.ts";
  import { bookDeletionPolicy, executeBookWrite, prepareBookWrite } from "../utils/bookForm.ts";
  import { acceptReportedWrite } from "../utils/offlineWrite.ts";

  let {
    open, userId, book = null, onclose,
  }: { open: boolean; userId: string; book?: Book | null; onclose: () => void } = $props();

  let authorChips = $state<AuthorChip[]>([]);
  // Existing authors for autocomplete and chip seeding; the listener only
  // lives while the modal is open. undefined from the store means still
  // loading (near-instant from the persistent cache, even offline).
  let authorList = $state<Author[]>([]);
  let authorsLoaded = $state(false);
  $effect(() => {
    if (!open || !userId) return;
    const store = Database.getAuthors(userId);
    const unsubscribeStore = store.subscribe((authors) => {
      if (authors === undefined) return;
      authorList = authors;
      authorsLoaded = true;
    });
    return () => {
      unsubscribeStore();
      authorList = [];
      authorsLoaded = false;
    };
  });
  let title = $state("");
  let pageCount = $state<number | null | undefined>(undefined);
  let currentPage = $state<number | null | undefined>(1);
  let isbn = $state("");
  // ISBN-derived metadata (bookMetadata.ts shape). Seeded from the book in
  // edit mode so saving without a fresh lookup preserves what's stored.
  let metadata = $state<BookMetadata>({ ...EMPTY_METADATA });

  let isEditMode = $derived(!!book);
  let deletionPolicy = $derived(book === null ? null : bookDeletionPolicy(book.activeTimer));
  let isLookingUp = $state(false);
  let lookupError = $state("");
  let bookWrite = $state({ accepted: false });
  const unresolvedAuthorCount = $derived(authorChips.filter(
    (chip) => chip.id !== null && 'unresolved' in chip,
  ).length);

  $effect(() => {
    title = book?.title ?? "";
    pageCount = book?.pageCount;
    currentPage = book?.currentPage ?? 1;
    isbn = book?.isbn ?? "";
    metadata = {
      coverUrl: book?.coverUrl ?? "",
      publisher: book?.publisher ?? "",
      publishedDate: book?.publishedDate ?? "",
      subjects: book?.subjects ?? [],
      fiction: book?.fiction ?? null,
    };
  });

  // Chips seed separately from the plain fields: resolving authorIds
  // needs the author docs, and the seed must run exactly once per opened
  // book so a later authors snapshot can't wipe in-progress edits.
  // Plain variable, not $state — bookkeeping the effect must not track.
  let seededBookId: string | null | undefined;
  $effect(() => {
    if (!open) {
      bookWrite.accepted = false;
      seededBookId = undefined;
      authorChips = [];
      lookupError = "";
      return;
    }
    if (!authorsLoaded) return;
    const bookId = book?.id ?? null;
    if (seededBookId === bookId) return;
    seededBookId = bookId;
    if (book === null) {
      authorChips = [];
      return;
    }
    const seeded = editableBookAuthorChips(book, authorList);
    authorChips = seeded.chips;
    for (const reference of seeded.unresolved) {
      console.error(`Cannot resolve author reference ${reference.id}: ${reference.problem}`);
    }
  });

  function handleSubmit() {
    lookupError = "";
    if (!authorsLoaded) {
      lookupError = 'Authors loading.';
      return;
    }
    const prepared = prepareBookWrite({
      userId,
      book,
      authorChips,
      title,
      pageCount,
      currentPage,
      isbn,
      metadata: $state.snapshot(metadata),
    });
    if (!prepared.valid) {
      lookupError = prepared.message;
      return;
    }
    // The SDK has accepted the mutation into its offline queue once the
    // wrapped method returns its promise. Close now; waiting for that promise
    // would leave the modal open until server acknowledgement after reconnect.
    // reportWriteFailures surfaces a later rejection in the global banner.
    void acceptReportedWrite(
      bookWrite,
      () => executeBookWrite(Database, prepared.write),
      onclose,
      (error) => {
        lookupError = error instanceof Error ? error.message : String(error);
      },
    );
  }

  function handleDelete() {
    if (book === null) throw new Error('Cannot delete a book before it is loaded.');
    const policy = bookDeletionPolicy(book.activeTimer);
    if (!policy.allowed) {
      lookupError = policy.guidance;
      return;
    }
    const warning = policy.confirmationWarning === null
      ? ''
      : ` ${policy.confirmationWarning}`;
    const confirmed = confirm(`Are you sure you want to delete "${book.title}"? This will delete all reading sessions for this book.${warning}`);
    if (confirmed) {
      // Not awaited: offline, the promise only resolves after reconnect,
      // but the local cache removes the book from the list instantly. A
      // flush-time rejection surfaces via the global error banner.
      void Database.deleteBook(userId, book.id, book.title, book.activeTimer);
      onclose();
    }
  }

  async function lookupISBN() {
    if (!isbn.trim()) {
      lookupError = "Please enter an ISBN first";
      return;
    }

    const normalized = normalizeIsbn(isbn);
    if (normalized === null) {
      lookupError = "Not a valid ISBN-10 or ISBN-13 (check digit mismatch?)";
      return;
    }
    // The stored isbn is the normalized ISBN-13 from here on.
    isbn = normalized;

    isLookingUp = true;
    lookupError = "";

    try {
      // Three sources, same order as the backfill migrations: Open Library
      // is primary (richer subject lists, stable cover URLs), Google Books
      // fills what it left empty — above all fiction/non-fiction, which
      // its BISAC categories answer and OL's subjects often don't — and
      // Nasjonalbiblioteket covers Norwegian editions neither one knows.
      const openLibrary = await fetchOpenLibrary(normalized);
      const google = await fetchGoogleBooks(normalized);
      const nb = await fetchNasjonalbiblioteket(normalized);

      if (openLibrary === null && google === null && nb === null) {
        lookupError = "No book found for this ISBN";
        return;
      }

      // Auto-fill fields (always overwrite when looking up). Whichever
      // source answered wins for the plain fields, in source order.
      const primary = openLibrary ?? google ?? nb;
      if (primary === null) throw new Error('Metadata source selection failed.');

      if (primary.title) {
        title = primary.title;
      }

      if (primary.authorNames.length > 0) {
        authorChips = primary.authorNames.map((name) => resolveChip(name, authorList));
      }

      pageCount = primary.pageCount || google?.pageCount || nb?.pageCount || pageCount;

      // Each source in turn fills only what is still empty.
      let merged = {
        coverUrl: primary.coverUrl,
        publisher: primary.publisher,
        publishedDate: primary.publishedDate,
        subjects: primary.subjects,
        fiction: primary.fiction,
      };
      for (const source of [google, nb]) {
        if (source !== null) merged = { ...merged, ...mergeMetadata(merged, source) };
      }
      metadata = merged;

    } catch (error) {
      lookupError = "Failed to look up ISBN. Please try again.";
      console.error("ISBN lookup error:", error);
    } finally {
      isLookingUp = false;
    }
  }

  async function fetchOpenLibrary(isbn13: string): Promise<BookLookupResult | null> {
    const response = await fetch(
      `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn13}&format=json&jscmd=data`
    );

    if (!response.ok) {
      throw new Error("Network error");
    }

    const data = requireRecord(await response.json(), 'Open Library response');
    const record = data[`ISBN:${isbn13}`];
    return record === undefined ? null : parseOpenLibraryBook(record);
  }

  // Nasjonalbiblioteket is called straight from the browser (open, no key,
  // and it reflects CORS origins). Genres — the fiction/non-fiction signal
  // for Norwegian books — live in the separate MODS record. Cover scans
  // are skipped here: they are restricted for in-copyright books, and the
  // modal has no way to verify one before showing it.
  async function fetchNasjonalbiblioteket(isbn13: string): Promise<BookLookupResult | null> {
    try {
      const response = await fetch(nbSearchUrl(isbn13));
      if (!response.ok) throw new Error(`Nasjonalbiblioteket ${response.status}`);
      const body = requireRecord(await response.json(), 'Nasjonalbiblioteket response');
      const embedded = optionalRecord(body._embedded);
      const items = embedded?.items;
      const item = Array.isArray(items) ? items[0] : undefined;
      if (item === undefined) return null;

      const itemData = requireRecord(item, 'Nasjonalbiblioteket item');
      if (typeof itemData.id !== 'string') throw new Error('Nasjonalbiblioteket item id must be a string.');
      const mods = await fetch(nbModsUrl(itemData.id));
      if (!mods.ok) throw new Error(`Nasjonalbiblioteket MODS ${mods.status}`);
      const parsed = parseNbItem(item, extractModsGenres(await mods.text()));
      return {
        title: parsed.title,
        authorNames: parsed.authorNames,
        pageCount: parsed.pageCount,
        coverUrl: parsed.coverUrl,
        publisher: parsed.publisher,
        publishedDate: parsed.publishedDate,
        subjects: parsed.subjects,
        fiction: parsed.fiction,
      };
    } catch (error) {
      console.error("Nasjonalbiblioteket lookup failed", error);
      return null;
    }
  }

  // Google Books runs through a callable (it proxies a metered API key).
  // A failure here must not discard the Open Library result the user is
  // waiting on, so it degrades to "no second source" rather than throwing.
  async function fetchGoogleBooks(isbn13: string): Promise<BookLookupResult | null> {
    try {
      const { data } = await lookupIsbn({ isbn: isbn13 });
      return data.volume === null ? null : parseGoogleVolume(data.volume);
    } catch (error) {
      console.error("Google Books lookup failed", error);
      return null;
    }
  }

  type Data = Record<string, unknown>;

  function requireRecord(value: unknown, context: string): Data {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError(`${context} must be an object.`);
    }
    return value as Data;
  }

  function optionalRecord(value: unknown): Data | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    return value as Data;
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

  .delete-button {
    background: none;
    border: none;
    color: #d9534f;
    cursor: pointer;
    font-size: 0.9rem;
    text-decoration: underline;
    padding: 0;
    margin-top: 1rem;
  }

  .delete-button:hover {
    color: #c9302c;
  }

  .delete-button:disabled,
  .delete-button:disabled:hover {
    color: #6c757d;
    cursor: not-allowed;
    text-decoration: none;
  }

  .delete-note {
    color: #6c757d;
    font-size: 0.85rem;
    margin-top: 0.4rem;
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
    background-color: #007bff;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.9rem;
    white-space: nowrap;
    height: fit-content;
    margin-top: 1.6rem;
  }

  .lookup-button:hover:not(:disabled) {
    background-color: #0056b3;
  }

  .lookup-button:disabled {
    background-color: #6c757d;
    cursor: not-allowed;
  }

  .lookup-error {
    color: #d9534f;
    font-size: 0.85rem;
    margin-top: 0.25rem;
  }

  .metadata-preview {
    display: flex;
    gap: 0.75rem;
    align-items: flex-start;
    margin-top: 0.75rem;
    font-size: 0.85rem;
    color: #6c757d;
  }

  .cover-thumb {
    width: 3.5rem;
    flex: 0 0 auto;
    border-radius: 3px;
  }

  .metadata-text {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }

  .fiction-label {
    font-weight: 600;
  }

</style>

<ModalCard
  {open}
  onclose={() => onclose()}
  header={isEditMode ? 'Edit book' : 'Add new book'}
  primaryText={isEditMode ? 'Update book' : 'Add book'}
  primaryDisabled={!authorsLoaded || bookWrite.accepted}
  primaryAction={handleSubmit}>
  <Input label="Author" inputId="author">
    <AuthorInput bind:chips={authorChips} authors={authorList} inputId="author" />
  </Input>

  {#if unresolvedAuthorCount > 0}
    <div class="lookup-error" role="alert">
      This book has {unresolvedAuthorCount} unresolved author {unresolvedAuthorCount === 1 ? 'reference' : 'references'}.
      Remove each marked chip and select or create a replacement before saving.
    </div>
  {/if}

  <!-- Each new author gets its parts confirmed at entry: the last-token
       split is only a prefill, so "Le Guin"-style surnames are fixed in
       the box, not by a heuristic later. Existing authors need nothing. -->
  {#each authorChips.filter((c) => c.id === null) as chip (chip)}
    <div class="new-author-detail">
      <select
        class="form-select detail-kind"
        aria-label={`Kind of new author ${chip.name}`}
        bind:value={chip.kind}>
        {#each AUTHOR_KINDS as kind (kind)}
          <option value={kind}>{kind}</option>
        {/each}
      </select>
      {#if chip.kind === "person"}
        <input
          type="text"
          class="form-control"
          placeholder="First name(s)"
          aria-label={`First name(s) of ${chip.name}`}
          bind:value={chip.givenName} />
        <input
          type="text"
          class="form-control"
          placeholder="Last name"
          aria-label={`Last name of ${chip.name}`}
          required
          bind:value={chip.familyName} />
      {:else}
        <input
          type="text"
          class="form-control"
          placeholder="Name"
          aria-label={`Name of ${chip.name}`}
          required
          bind:value={chip.name} />
      {/if}
    </div>
  {/each}

  <div class="space"></div>

  <Input label="Book title" inputId="title">
    <input id="title" class="form-control" type="text" bind:value={title} placeholder="Book title" />
  </Input>

  <div class="space"></div>

  <Input label="Number of pages" inputId="pageCount">
    <input
      id="pageCount"
      class="form-control"
      type="number"
      inputmode="numeric"
      bind:value={pageCount}
      placeholder="How many pages are there?" />
  </Input>

  <div class="space"></div>

  <Input label="Current page" inputId="currentPage">
    <input
      id="currentPage"
      class="form-control"
      type="number"
      inputmode="numeric"
      bind:value={currentPage}
      placeholder="Have you already started reading?" />
  </Input>

  <div class="space"></div>

  <div class="isbn-container">
    <div class="isbn-input-wrapper">
      <Input label="ISBN number (optional)" inputId="isbn">
        <input id="isbn" class="form-control" type="text" bind:value={isbn} placeholder="ISBN" />
      </Input>
    </div>
    <button
      type="button"
      class="lookup-button"
      onclick={lookupISBN}
      disabled={isLookingUp || !isbn.trim()}>
      {isLookingUp ? 'Looking up...' : 'Look up'}
    </button>
  </div>

  {#if lookupError}
    <div class="lookup-error" role="alert">{lookupError}</div>
  {/if}

  {#if metadata.coverUrl || metadata.subjects.length > 0}
    <div class="metadata-preview">
      {#if metadata.coverUrl}
        <img class="cover-thumb" src={metadata.coverUrl} alt="Cover of {title}" />
      {/if}
      <div class="metadata-text">
        {#if metadata.fiction !== null}
          <div class="fiction-label">{metadata.fiction ? "Fiction" : "Non-fiction"}</div>
        {/if}
        {#if metadata.subjects.length > 0}
          <div>{metadata.subjects.slice(0, 6).join(" · ")}</div>
        {/if}
        {#if metadata.publisher || metadata.publishedDate}
          <div>{[metadata.publisher, metadata.publishedDate].filter(Boolean).join(", ")}</div>
        {/if}
      </div>
    </div>
  {/if}

  {#if isEditMode}
    <button
      type="button"
      class="delete-button"
      onclick={handleDelete}
      disabled={deletionPolicy !== null && !deletionPolicy.allowed}
      aria-describedby={deletionPolicy !== null && !deletionPolicy.allowed
        ? 'delete-book-guidance'
        : undefined}>
      Delete this book
    </button>
    {#if deletionPolicy !== null && !deletionPolicy.allowed}
      <div id="delete-book-guidance" class="delete-note">
        {deletionPolicy.guidance}
      </div>
    {/if}
  {/if}
</ModalCard>
