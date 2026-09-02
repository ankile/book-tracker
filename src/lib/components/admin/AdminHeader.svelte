<script lang="ts">
  import type { Snippet } from 'svelte';

  // The chrome every admin page shares: the console switcher, the
  // breadcrumb back into the console, and whatever the page wants to say
  // about how current it is (the catalog's live line, the accounts page's
  // refresh). Styled by admin.css, which the page imports.
  interface Crumb {
    label: string;
    href?: string;
  }

  interface Props {
    active: 'catalog' | 'accounts';
    crumbs?: Crumb[];
    status?: Snippet;
  }

  let { active, crumbs = [], status }: Props = $props();
</script>

<header class="console-head">
  <div class="console-bar">
    <nav class="console-switch" aria-label="Admin consoles">
      <span class="eyebrow">Admin</span>
      <a href="/admin" aria-current={active === 'catalog' ? 'page' : undefined}>Catalog</a>
      <a href="/admin/users" aria-current={active === 'accounts' ? 'page' : undefined}>Accounts and issues</a>
    </nav>
    {#if status}<div class="console-status">{@render status()}</div>{/if}
  </div>
  {#if crumbs.length > 0}
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/admin">Catalog</a>
      {#each crumbs as crumb (crumb.label)}
        <span aria-hidden="true">›</span>
        {#if crumb.href}<a href={crumb.href}>{crumb.label}</a>{:else}<span>{crumb.label}</span>{/if}
      {/each}
    </nav>
  {/if}
</header>
