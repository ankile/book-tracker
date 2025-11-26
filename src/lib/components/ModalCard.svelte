<script lang="ts">
  import Button from "$lib/components/Button.svelte";

  let {
    header = undefined,
    open,
    primaryAction = undefined,
    primaryText = "Do it!",
    secondaryText = "Close",
    hideSecondary = false,
    onclose
  }: {
    header?: string;
    open: boolean;
    primaryAction?: () => void;
    primaryText?: string;
    secondaryText?: string;
    hideSecondary?: boolean;
    onclose: () => void;
  } = $props();

  $effect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  const close = () => onclose();

  function handleKeyDown(event: KeyboardEvent) {
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
  <div
    role="presentation"
    onclick={close}
    onkeydown={(e) => e.key === 'Escape' && close()}
    class="background">
    <div
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
      class="card hover">
      {#if header}
        <h4 class="header">{header}</h4>
        <div class="divider" />
      {/if}
      <div class="content">
        <slot>No content</slot>
      </div>
      <div class="divider" />
      <div class="buttons">
        {#if !hideSecondary}
          <Button onclick={close}>{secondaryText}</Button>
        {/if}
        {#if primaryAction}
          <Button primary onclick={primaryAction}>{primaryText}</Button>
        {/if}
      </div>
    </div>
  </div>
{/if}
