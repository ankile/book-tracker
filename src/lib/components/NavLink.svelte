<script>
  import { page } from '$app/stores';

  let { to = "", children } = $props();

  const isActive = $derived(
    to === '/' ? $page.url.pathname === '/' : $page.url.pathname.startsWith(to)
  );
</script>

<a href={to} class:active={isActive}>
  {@render children?.()}
</a>
