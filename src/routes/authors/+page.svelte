<script>
  import { user } from '$lib/firebase/auth.js';
  import { Database } from '$lib/firebase/db.js';
  import ModalCard from '$lib/components/ModalCard.svelte';
  import Input from '$lib/components/Input.svelte';
  import { AUTHOR_KINDS, splitPersonName, joinPersonName } from '$lib/utils/authors.js';

  let authorList = $state(undefined);
  $effect(() => {
    if ($user) {
      const authorsStore = Database.getAuthors($user.uid);
      const unsubscribe = authorsStore.subscribe((data) => (authorList = data));
      return () => {
        unsubscribe();
        authorsStore.unsubscribe();
      };
    }
  });

  let allBooks = $state([]);
  $effect(() => {
    if ($user) {
      const booksStore = Database.getAllBooks($user.uid);
      const unsubscribe = booksStore.subscribe((data) => (allBooks = data ?? []));
      return () => {
        unsubscribe();
        booksStore.unsubscribe();
      };
    }
  });

  // Persons sort by their explicit family name — the point of storing it.
  const sortKey = (a) => (a.kind === 'person' && a.familyName ? `${a.familyName} ${a.name}` : a.name).toLowerCase();
  const authors = $derived((authorList ?? []).toSorted((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0)));

  // Books still carrying legacy fields reference authors through their
  // embedded {id, name} entries; those references count too — delete
  // safety and merge completeness depend on stragglers counting.
  function effectiveIds(book) {
    if (book.author !== undefined || book.authors !== undefined) {
      return (book.authors ?? []).map((a) => a.id);
    }
    return book.authorIds;
  }

  const bookCounts = $derived.by(() => {
    const counts = new Map();
    for (const book of allBooks) {
      for (const id of effectiveIds(book)) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    return counts;
  });

  let editAuthor = $state(null);
  let editName = $state('');
  let editKind = $state('person');
  let editGivenName = $state('');
  let editFamilyName = $state('');
  function openEdit(author) {
    editAuthor = author;
    editName = author.name;
    // Docs written before the kind/parts migrations lack the fields; the
    // form defaults kind to person and prefills the parts from the split,
    // and saving backfills both.
    editKind = author.kind ?? 'person';
    const parts = author.familyName !== undefined ? author : splitPersonName(author.name);
    editGivenName = parts.givenName ?? '';
    editFamilyName = parts.familyName;
  }
  function saveEdit() {
    Database.updateAuthor({
      userId: $user.uid,
      authorId: editAuthor.id,
      // name is the write value for non-person kinds and the error-banner
      // label either way.
      name: editKind === 'person' ? joinPersonName({ givenName: editGivenName, familyName: editFamilyName }) : editName,
      kind: editKind,
      givenName: editGivenName,
      familyName: editFamilyName,
    });
    editAuthor = null;
  }

  let mergeSource = $state(null);
  let mergeTargetId = $state('');
  function openMerge(author) {
    mergeSource = author;
    mergeTargetId = '';
  }
  function doMerge() {
    const target = authors.find((a) => a.id === mergeTargetId);
    const books = allBooks
      .filter((book) => effectiveIds(book).includes(mergeSource.id))
      .map((book) => ({ id: book.id, authorIds: effectiveIds(book) }));
    const confirmed = confirm(
      `Merge "${mergeSource.name}" into "${target.name}"? ${books.length} book(s) will be updated and "${mergeSource.name}" deleted.`
    );
    if (!confirmed) return;
    Database.mergeAuthors({
      userId: $user.uid,
      sourceId: mergeSource.id,
      targetId: target.id,
      sourceName: mergeSource.name,
      targetName: target.name,
      books,
    });
    mergeSource = null;
  }

  function deleteAuthor(author) {
    const confirmed = confirm(`Delete author "${author.name}"? No books reference them.`);
    if (confirmed) {
      Database.deleteAuthor({ userId: $user.uid, authorId: author.id, name: author.name });
    }
  }
</script>

<style>
  .authors-container {
    max-width: 900px;
    margin: 0 auto;
    padding: 0 1rem 2rem;
  }

  h1 {
    font-size: 1.6rem;
    margin: 1rem 0;
  }

  .hint {
    color: #666;
    font-size: 0.9rem;
    margin-bottom: 1.5rem;
  }

  .authors-card {
    background: white;
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    padding: 1rem 1.5rem;
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }

  th,
  td {
    text-align: left;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid #eee;
  }

  th {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: #666;
  }

  tr:last-child td {
    border-bottom: none;
  }

  .kind,
  .sort-name {
    color: #666;
    font-size: 0.9rem;
  }

  .count {
    text-align: right;
  }

  .actions-cell {
    text-align: right;
    white-space: nowrap;
  }

  .row-action {
    background: none;
    border: none;
    color: #007bff;
    cursor: pointer;
    font-size: 0.9rem;
    text-decoration: underline;
    padding: 0 0.3rem;
  }

  .row-action.danger {
    color: #d9534f;
  }
</style>

<div class="authors-container">
  <h1>Authors</h1>
  <p class="hint">
    Renames and sort-name changes apply to every book instantly. Merge fixes
    duplicate spellings; delete is offered once no book references an author.
  </p>

  {#if authorList === undefined}
    <p>Loading…</p>
  {:else if authors.length === 0}
    <p>No authors yet — they appear as you add books.</p>
  {:else}
    <div class="authors-card">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Kind</th>
            <th>Family name</th>
            <th class="count">Books</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each authors as author (author.id)}
            {@const count = bookCounts.get(author.id) ?? 0}
            <tr>
              <td>{author.name}</td>
              <td class="kind">{author.kind ?? 'person'}</td>
              <td class="sort-name">{author.familyName ?? '—'}</td>
              <td class="count">{count}</td>
              <td class="actions-cell">
                <button type="button" class="row-action" onclick={() => openEdit(author)}>Edit</button>
                {#if authors.length > 1}
                  <button type="button" class="row-action" onclick={() => openMerge(author)}>Merge</button>
                {/if}
                {#if count === 0}
                  <button type="button" class="row-action danger" onclick={() => deleteAuthor(author)}>Delete</button>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<ModalCard
  open={editAuthor !== null}
  onclose={() => (editAuthor = null)}
  header="Edit author"
  primaryText="Save"
  primaryAction={saveEdit}>
  <Input label="Kind" inputId="author-kind">
    <select id="author-kind" class="form-select" bind:value={editKind}>
      {#each AUTHOR_KINDS as kind (kind)}
        <option value={kind}>{kind}</option>
      {/each}
    </select>
  </Input>
  <div style="height: 1em"></div>
  {#if editKind === 'person'}
    <Input label="First name(s)" inputId="author-given-name">
      <input
        id="author-given-name"
        class="form-control"
        type="text"
        bind:value={editGivenName}
        placeholder="Empty for mononyms (Homer)" />
    </Input>
    <div style="height: 1em"></div>
    <Input label="Last name" inputId="author-family-name">
      <input
        id="author-family-name"
        class="form-control"
        type="text"
        required
        bind:value={editFamilyName}
        placeholder='Sorts and abbreviates, e.g. "Le Guin"' />
    </Input>
  {:else}
    <Input label="Name" inputId="author-name">
      <input id="author-name" class="form-control" type="text" required bind:value={editName} />
    </Input>
  {/if}
</ModalCard>

<ModalCard
  open={mergeSource !== null}
  onclose={() => (mergeSource = null)}
  header={`Merge "${mergeSource?.name ?? ''}"`}
  primaryText="Merge"
  primaryAction={doMerge}>
  <Input label="Merge into" inputId="merge-target">
    <select id="merge-target" class="form-select" required bind:value={mergeTargetId}>
      <option value="" disabled>Choose an author…</option>
      {#each authors.filter((a) => a.id !== mergeSource?.id) as author (author.id)}
        <option value={author.id}>{author.name}</option>
      {/each}
    </select>
  </Input>
</ModalCard>
