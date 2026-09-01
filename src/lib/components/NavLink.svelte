<script lang="ts">
  import { page } from '$app/stores';
  import type { Snippet } from 'svelte';

  interface Props {
    to?: string;
    children: Snippet;
  }

  let { to = '', children }: Props = $props();

  const isActive = $derived(
    to === '/' ? $page.url.pathname === '/' : $page.url.pathname.startsWith(to)
  );
</script>

<style>
  a {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: 0.55rem 0.9rem;
    color: #dce9e9;
    font-size: 0.95rem;
    font-weight: 600;
    line-height: 1;
    text-decoration: none;
    border-radius: 9px;
    transition: color 0.15s ease-in-out, background 0.15s ease-in-out;
  }

  a:hover {
    color: white;
    background: rgba(255, 255, 255, 0.1);
  }

  a.active {
    color: #294f52;
    font-weight: 750;
    background: #edf5f5;
  }

  a:focus-visible {
    outline: 2px solid white;
    outline-offset: 2px;
  }

  @media only screen and (max-width: 720px) {
    a {
      width: 100%;
      padding-right: 0.4rem;
      padding-left: 0.4rem;
      font-size: 0.9rem;
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
