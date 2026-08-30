<script lang="ts">
  import type { Book } from '../interfaces/book.ts';
  import type { CatalogSearchResult, CatalogSelection } from '../interfaces/catalog.ts';

  let {
    suggestions,
    selected,
    selectedResult,
    duplicates,
    loading,
    online,
    message,
    onselect,
    onremove,
  }: {
    suggestions: CatalogSearchResult[];
    selected: CatalogSelection | null;
    selectedResult: CatalogSearchResult | null;
    duplicates: Book[];
    loading: boolean;
    online: boolean;
    message: string;
    onselect: (result: CatalogSearchResult) => void;
    onremove: () => void;
  } = $props();

  const editionDetail = (result: CatalogSearchResult): string => [
    result.edition?.publisher,
    result.edition?.publishedDate,
    result.edition?.isbn13 ? `ISBN ${result.edition.isbn13}` : '',
    result.edition?.suggestedPageCount ? `${result.edition.suggestedPageCount} suggested pages` : '',
  ].filter(Boolean).join(' · ');
</script>

<section class="catalog-panel" aria-label="Shared book catalog">
  <div class="catalog-heading">
    <div>
      <strong>Shared work</strong>
      <div class="catalog-explanation">
        Connect this reading record to the same admin-curated work across readers. Your personal page count stays editable and authoritative. Reading history is shared only through the separate opt-in.
      </div>
    </div>
    {#if loading}<span class="catalog-state">Checking…</span>{/if}
  </div>

  {#if selected}
    <div class="selected-work">
      {#if selectedResult}
        <div class="candidate-main">
          {#if selectedResult.work.coverUrl}
            <img src={selectedResult.work.coverUrl} alt="" referrerpolicy="no-referrer" />
          {/if}
          <div>
            <strong>{selectedResult.work.canonicalTitle}</strong>
            <div>{selectedResult.work.authors.map((author) => author.canonicalName).join(', ')}</div>
            {#if editionDetail(selectedResult)}<small>{editionDetail(selectedResult)}</small>{/if}
          </div>
        </div>
      {:else}
        <strong>Linked work</strong>
      {/if}
      <button type="button" class="text-button" onclick={onremove}>Remove link</button>
    </div>
  {/if}

  {#if duplicates.length > 0}
    <div class="duplicate-warning" role="status">
      You already have {duplicates.length === 1 ? 'a reading record' : `${duplicates.length} reading records`} for this work:
      {duplicates.map((book) => book.title).join(', ')}. You can still add this as a reread.
    </div>
  {/if}

  {#if suggestions.length > 0}
    <div class="candidate-list">
      {#each suggestions as result (result.workId + ':' + (result.editionId ?? 'work'))}
        <article class:selected-candidate={selected?.workId === result.workId && selected?.editionId === result.editionId}>
          <div class="candidate-main">
            {#if result.work.coverUrl}
              <img src={result.work.coverUrl} alt="" loading="lazy" referrerpolicy="no-referrer" />
            {/if}
            <div>
              <strong>{result.work.canonicalTitle}</strong>
              <div>{result.work.authors.map((author) => author.canonicalName).join(', ')}</div>
              <small>{result.reason}{editionDetail(result) ? ` · ${editionDetail(result)}` : ''}</small>
            </div>
          </div>
          <button type="button" onclick={() => onselect(result)}>
            {selected?.workId === result.workId && selected?.editionId === result.editionId
              ? 'Selected'
              : 'Use this work'}
          </button>
        </article>
      {/each}
    </div>
  {/if}

  {#if message}<div class="catalog-message" role="status">{message}</div>{/if}

  {#if !selected}
    <div class="catalog-message">No match? Save the personal book unlinked. An administrator can create or connect its shared work later.</div>
    {#if !online}
      <div class="catalog-message">Offline. You can save now and find a matching work after reconnecting.</div>
    {/if}
  {/if}
</section>

<style>
  .catalog-panel {
    margin-top: 1rem;
    padding: 0.9rem;
    border: 1px solid #d7dfdc;
    border-radius: 6px;
    background: #f8faf9;
    text-align: left;
  }

  .catalog-heading, .selected-work, article {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    align-items: center;
  }

  .catalog-explanation, .catalog-state, small, .catalog-message {
    color: #64706d;
    font-size: 0.82rem;
  }

  .selected-work {
    margin-top: 0.75rem;
    padding: 0.7rem;
    border-radius: 5px;
    background: #e7f3ed;
  }

  .candidate-list {
    display: grid;
    gap: 0.55rem;
    margin-top: 0.75rem;
  }

  article {
    padding: 0.65rem;
    border: 1px solid #d7dfdc;
    border-radius: 5px;
    background: white;
  }

  article.selected-candidate {
    border-color: #2f7664;
  }

  .candidate-main {
    display: flex;
    gap: 0.65rem;
    align-items: flex-start;
    min-width: 0;
  }

  .candidate-main img {
    width: 36px;
    aspect-ratio: 2 / 3;
    object-fit: cover;
    border-radius: 2px;
  }

  article button {
    flex: 0 0 auto;
    padding: 0.4rem 0.65rem;
    border: 1px solid #2f7664;
    border-radius: 4px;
    color: #24594c;
    background: white;
    cursor: pointer;
  }

  button:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .text-button {
    border: 0;
    background: none;
    color: #24594c;
    text-decoration: underline;
    cursor: pointer;
  }

  .duplicate-warning {
    margin-top: 0.65rem;
    padding: 0.6rem;
    border-radius: 4px;
    color: #664d03;
    background: #fff3cd;
    font-size: 0.85rem;
  }

  .catalog-message {
    margin-top: 0.55rem;
  }

  @media (max-width: 520px) {
    article, .selected-work {
      align-items: flex-start;
      flex-direction: column;
    }
  }
</style>
