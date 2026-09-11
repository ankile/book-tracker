<script lang="ts">
  import type { Snippet } from 'svelte';
  import { page } from '$app/state';
  import { user } from '$lib/firebase/auth.ts';
  import { adminCatalogOwner, startAdminPrefetch } from '$lib/admin.ts';

  let { children }: { children: Snippet } = $props();

  // Catalog child pages share one owner; /admin/users uses its callable only.
  // Sign-out, account changes and leaving the catalog release the listener.
  const catalogOwner = $derived(adminCatalogOwner($user?.uid, page.route.id));
  $effect(() => startAdminPrefetch(catalogOwner));
</script>

{@render children()}
