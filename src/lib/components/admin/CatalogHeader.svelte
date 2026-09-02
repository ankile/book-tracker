<script lang="ts">
  import type { CatalogSourceProgress } from '$lib/firebase/adminCatalog.ts';
  import type { CatalogScan } from '$lib/interfaces/catalog.ts';

  // The chrome every catalog console page shares: the console switcher,
  // the breadcrumb back to the overview, and the live line. The scan is
  // the same store on every page, so the line reads the same everywhere.
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

<header>
  <nav class="consoles"><strong>Catalog</strong> · <a href="/admin/users">Accounts and issues</a></nav>
  {#if crumbs.length > 0}
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/admin">Catalog</a>
      {#each crumbs as crumb (crumb.label)}
        <span aria-hidden="true">›</span>
        {#if crumb.href}<a href={crumb.href}>{crumb.label}</a>{:else}<span>{crumb.label}</span>{/if}
      {/each}
    </nav>
  {/if}
  <p class="toolbar">
    {#if scan === null}
      <small>Connecting to the catalog… {loadedSources} of {progress.length} sources loaded</small>
    {:else}
      <small><span class="live"></span>Live · {scan.books.length} books across {scan.works.length} works · updated {updatedAt?.toLocaleTimeString() ?? ''}</small>
    {/if}
  </p>
</header>

<style>
  header { margin-bottom: 1rem; }
  nav { font-size: .95rem; color: #64706d; }
  nav a { color: #24635a; }
  .consoles strong { color: #244f49; }
  .crumbs { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .4rem; }
  .toolbar { display: flex; align-items: center; gap: .8rem; margin: .4rem 0 0; }
  .toolbar small { color: #71807d; }
  .live { display: inline-block; width: .55rem; height: .55rem; margin-right: .4rem; border-radius: 50%; background: #2e9e6b; vertical-align: middle; }
</style>
