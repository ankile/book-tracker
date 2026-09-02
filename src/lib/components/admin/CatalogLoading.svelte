<script lang="ts">
  import type { CatalogSourceProgress } from '$lib/firebase/adminCatalog.ts';

  // What has arrived so far while the first snapshot from every source is
  // still on its way: a fresh device fills the persistent cache from seven
  // listeners, and the operator sees which are outstanding, not a spinner.
  // Styled by admin.css, which the page imports.
  interface Props {
    progress: CatalogSourceProgress[];
  }

  let { progress }: Props = $props();
</script>

<section class="card loading" aria-live="polite">
  <p>Waiting for the first snapshot from every source. A fresh device fills its local cache once; later opens are served from it.</p>
  <ul class="progress">
    {#each progress as source (source.label)}
      <li class:done={source.count !== null}>
        <span aria-hidden="true">{source.count === null ? '…' : '✓'}</span>
        {source.label}{#if source.count !== null} · {source.count}{/if}
      </li>
    {/each}
  </ul>
</section>
