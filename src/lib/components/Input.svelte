<script lang="ts">
  import { createEventDispatcher } from "svelte";

  const dispatch = createEventDispatcher();

  export let label: string;
  export let inputId: string | undefined = undefined;
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
  <slot>Yeet</slot>
</div>
