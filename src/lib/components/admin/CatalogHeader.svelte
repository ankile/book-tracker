<script lang="ts">
  import AdminHeader from './AdminHeader.svelte';
  import type { CatalogSourceProgress } from '$lib/firebase/adminCatalog.ts';
  import type { CatalogScan } from '$lib/interfaces/catalog.ts';

  // The admin chrome with the catalog's live line: the scan is the same
  // store on every catalog page, so the line reads the same everywhere.
  interface Crumb {
    label: string;
    href?: string;
  }

  interface Props {
    crumbs?: Crumb[];
    scan: CatalogScan | null;
    progress: CatalogSourceProgress[];
  }

  let { crumbs = [], scan, progress }: Props = $props();

  const loadedSources = $derived(progress.filter((source) => source.count !== null).length);
  let updatedAt = $state<Date | null>(null);
  $effect(() => {
    if (scan !== null) updatedAt = new Date();
  });
</script>

<AdminHeader active="catalog" {crumbs}>
  {#snippet status()}
    {#if scan === null}
      <span class="live-line waiting"><span class="live-dot" aria-hidden="true"></span>Connecting · {loadedSources} of {progress.length} sources loaded</span>
    {:else}
      <span class="live-line"><span class="live-dot" aria-hidden="true"></span>Live · {scan.books.length} books across {scan.works.length} works · updated {updatedAt?.toLocaleTimeString() ?? ''}</span>
    {/if}
  {/snippet}
</AdminHeader>
