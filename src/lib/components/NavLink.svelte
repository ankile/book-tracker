<script lang="ts">
  import { page } from '$app/stores';
  import type { Snippet } from 'svelte';

  interface Props {
    to?: string;
    children: Snippet;
  }

  let { to = "", children }: Props = $props();

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

  /* Keep all three links on one row on phone screens. */
  @media only screen and (max-width: 500px) {
    a {
      font-size: 0.95rem;
      padding: 0.5rem 0.4rem;
    }
  }
</style>

<a
  href={to}
  class="nav-link"
  class:active={isActive}
  aria-current={isActive ? 'page' : undefined}>
  {@render children()}
</a>
