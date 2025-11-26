<script>
  import { page } from '$app/stores';

  let { to = "", children } = $props();

  const isActive = $derived(
    to === '/' ? $page.url.pathname === '/' : $page.url.pathname.startsWith(to)
  );
</script>

<style>
  a {
    color: rgba(255, 255, 255, 0.75);
    text-decoration: none;
    padding: 0.5rem 1rem;
    font-size: 1.25rem;
    font-weight: 500;
    transition: color 0.15s ease-in-out;
  }

  a:hover {
    color: rgba(255, 255, 255, 1);
  }

  a.active {
    color: white;
    font-weight: 700;
  }
</style>

<a href={to} class="nav-link" class:active={isActive}>
  {@render children?.()}
</a>
