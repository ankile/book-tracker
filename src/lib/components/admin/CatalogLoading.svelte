<script lang="ts">
  import type { CatalogSourceProgress } from '$lib/firebase/adminCatalog.ts';

  // What has arrived so far while the first snapshot from every source is
  // still on its way: a fresh device fills the persistent cache from seven
  // listeners, and the operator sees which are outstanding, not a spinner.
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
        <span class="mark" aria-hidden="true">{source.count === null ? '…' : '✓'}</span>
        {source.label}{#if source.count !== null} · {source.count}{/if}
      </li>
    {/each}
  </ul>
</section>

<style>
  .loading { color: #697572; }
  .loading p { margin: 0 0 .75rem; }
  .progress { display: flex; flex-wrap: wrap; gap: .5rem 1.25rem; margin: 0; padding: 0; list-style: none; }
  .progress li { color: #8a9693; }
  .progress li.done { color: #244f49; }
  .mark { display: inline-block; width: 1.1rem; }
</style>
