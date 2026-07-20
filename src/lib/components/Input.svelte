<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    label,
    inputId = undefined,
    children
  }: {
    label: string;
    inputId?: string;
    children: Snippet;
  } = $props();
</script>

<style lang="scss">
  .column {
    display: flex;
    flex-direction: column;
    margin: 0 2em 0.5em;
    text-align: start;
  }
</style>

<div class="column">
  {#if label}<label for={inputId}>{label}</label>{/if}
  {@render children()}
</div>
