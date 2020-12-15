<script lang="ts">
  import { createEventDispatcher, onMount } from "svelte";
  import Button from "../components/Button.svelte";

  export let header: string | undefined;
  export let open: boolean;
  export let primaryAction: () => void | undefined;
  export let primaryText = "Do it!";
  export let secondaryText = "Close";

  onMount(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  const dispatch = createEventDispatcher();

  const close = () => dispatch("close");

  function handleKeyDown(event) {
    if (primaryAction && event.key === "Enter") {
      primaryAction();
    } else if (event.key === "Escape") {
      close();
    }
  }
</script>

<style lang="scss">
  .background {
    background-color: rgba(0, 0, 0, 0.4);
    height: 100vh;
    width: 100vw;
    position: fixed;
    top: 0;
    left: 0;
    z-index: 100;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
  }

  .card {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    padding: 1em 3em;
    margin: 1em 2em;
    max-width: 400px;
    width: 100%;
    border: none;
    background-color: white;
    margin: 1em;
    padding: 1em;
    box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.2), 0 6px 20px 0 rgba(0, 0, 0, 0.19);
    border-radius: 5px;
  }

  .content {
    padding: 2em 0;
  }

  .divider {
    display: none;
    height: 1px;
    background: darkgray;
    margin: 0.2em -1em;
  }

  .buttons {
    display: flex;
    flex-direction: row;
    justify-content: center;
  }
</style>

{#if open}
  <div on:click={close} class="background">
    <div on:click={(e) => e.stopPropagation()} class="card hover">
      {#if header}
        <h4 class="header">{header}</h4>
        <div class="divider" />
      {/if}
      <div class="content">
        <slot>No content</slot>
      </div>
      <div class="divider" />
      <div class="buttons">
        <Button on:click={close}>{secondaryText}</Button>
        {#if primaryAction}
          <Button primary on:click={primaryAction}>{primaryText}</Button>
        {/if}
      </div>
    </div>
  </div>
{/if}
