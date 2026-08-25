<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
</script>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 1.5rem;
    margin-bottom: 2rem;
  }

  @media (max-width: 768px) {
    .grid {
      grid-template-columns: 1fr;
    }
  }
</style>

<div class="grid">
  {@render children()}
</div>
