<script lang="ts">
  import '$lib/components/admin/admin.css';
  import { page } from '$app/state';
  import CatalogHeader from '$lib/components/admin/CatalogHeader.svelte';
  import CatalogLoading from '$lib/components/admin/CatalogLoading.svelte';
  import CatalogOperationDialog from '$lib/components/admin/CatalogOperationDialog.svelte';
  import ReviewAction from '$lib/components/admin/ReviewAction.svelte';
  import { adminAccountEmails, adminCatalogProgress, adminCatalogScan } from '$lib/firebase/adminCatalog.ts';
  import {
    authorNamesById,
    catalogAuthorNames,
    creatorLabel,
    editAuthorDraft,
    isoDay,
    reviewLabel,
    reviewStatus,
    mergeAuthorsDraft,
    worksByAuthor,
    type OperationDraft,
  } from '$lib/utils/adminCatalogView.ts';

  // One catalog author: the record, its aliases, the works that name it
  // (directly or through an alias merged into it), and the operations that
  // start from it.
  const scan = $derived($adminCatalogScan ?? null);
  const emails = $derived($adminAccountEmails ?? new Map<string, string>());
  const progress = $derived($adminCatalogProgress);
  const authorId = $derived(page.params.authorId ?? '');

  let draft = $state<OperationDraft | null>(null);
  let statusMessage = $state('');
  let statusOk = $state(true);
  function report(message: string, ok: boolean): void {
    statusMessage = message;
    statusOk = ok;
  }

  const author = $derived(scan?.authors.find((row) => row.authorId === authorId) ?? null);
  const names = $derived(authorNamesById(scan ?? {authors: []}));
  const works = $derived(worksByAuthor(scan ?? {works: [], authors: []}, authorId));
</script>

<svelte:head><title>{author?.canonicalName ?? 'Author'} · Catalog · Book Tracker</title></svelte:head>

<main class="admin-console">
  <CatalogHeader crumbs={[{label: 'Authors', href: '/admin?tab=authors'}, {label: author?.canonicalName ?? authorId}]} {scan} {progress} />
  {#if statusMessage}<div class="notice {statusOk ? 'success' : 'error'}" role="status">{statusMessage}</div>{/if}

  {#if scan === null}
    <CatalogLoading {progress} />
  {:else if author === null}
    <section class="card">
      <h1>Author not found</h1>
      <p>No catalog author <code>{authorId}</code> exists. <a href="/admin">Back to the catalog</a>.</p>
    </section>
  {:else}
    <section class="card">
      <div class="entity-head">
        <div class="no-cover" aria-hidden="true"></div>
        <div>
          <h1>{author.canonicalName}</h1>
          <p class="byline">Sorted as {author.sortName} · {author.kind}</p>
          <p class="meta">
            <span class="status {author.status}">{author.status}</span>
            <span class="review {reviewStatus(author)}">{reviewLabel(author)}</span>
            <span>Created {isoDay(author.createdAt)} by {creatorLabel(author.createdBy, emails)}</span>
            <code>{author.authorId}</code>
          </p>
          {#if author.warnings.length > 0}<p class="warning">{author.warnings.join(' · ')}</p>{/if}
          {#if author.status === 'merged'}
            <p class="warning">An alias: it redirects to <a href="/admin/authors/{author.mergedInto}">{names.get(author.mergedInto ?? '') ?? author.mergedInto}</a>, and every operation starts from there.</p>
          {/if}
        </div>
        <div class="actions">
          {#if author.status === 'merged'}
            <a class="button-link" href="/admin/authors/{author.mergedInto}">Open the survivor</a>
          {:else}
            <ReviewAction kind="author" ids={[author.authorId]} reviewed={reviewStatus(author) !== 'done'} primary={reviewStatus(author) !== 'done'}
              label={reviewStatus(author) === 'done' ? 'Mark unreviewed' : 'Mark reviewed'} onresult={report} />
          {/if}
          {#if author.status === 'active'}
            <button type="button" onclick={() => (draft = editAuthorDraft(author))}>Edit author…</button>
            <button type="button" onclick={() => (draft = mergeAuthorsDraft(author.authorId, ''))}>Merge into another author…</button>
          {/if}
        </div>
      </div>
      <dl class="facts">
        <div><dt>Alternate names</dt><dd>{author.alternateNames.join(' · ') || '—'}</dd></div>
        <div><dt>Merged into</dt><dd>{#if author.mergedInto}<a href="/admin/authors/{author.mergedInto}">{names.get(author.mergedInto) ?? author.mergedInto}</a>{:else}—{/if}</dd></div>
        <div><dt>Absorbed authors</dt><dd>{#each author.mergedFrom as id, index (id)}{#if index > 0}, {/if}<a href="/admin/authors/{id}">{names.get(id) ?? id}</a>{:else}—{/each}</dd></div>
        <div><dt>Works</dt><dd>{author.workCount}</dd></div>
      </dl>
    </section>

    <section class="card" aria-labelledby="author-works-heading">
      <h2 id="author-works-heading">Works <span>{works.length}</span></h2>
      <p>Every work naming this author, newest first. The creator is the reader whose book first brought the work into the catalog.</p>
      {#if works.length === 0}
        <p class="empty">No work names this author.</p>
      {:else}
        <div class="table-scroll">
          <table>
            <thead><tr><th>Work</th><th>Created</th><th>Status</th><th>Editions</th><th>Readers</th><th>Warnings</th></tr></thead>
            <tbody>
              {#each works as work (work.workId)}
                <tr>
                  <td><strong><a href="/admin/works/{work.workId}">{work.canonicalTitle}</a></strong><small>{catalogAuthorNames(names, work.authorIds)} · {work.workId}</small></td>
                  <td>{isoDay(work.createdAt)}<small>{creatorLabel(work.createdBy, emails)}</small></td>
                  <td><span class="status {work.status}">{work.status}</span></td>
                  <td class="numeric">{work.editionCount}</td>
                  <td class="numeric">{work.linkedBookCount}</td>
                  <td>{work.warnings.length === 0 ? '—' : work.warnings.join(' · ')}</td>
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
