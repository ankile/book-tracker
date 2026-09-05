<script lang="ts">
  import Button from "$lib/components/Button.svelte";
  import ErrorBanner from "$lib/components/ErrorBanner.svelte";
  import type { Snippet } from "svelte";

  interface Props {
    header?: string;
    open: boolean;
    primaryAction?: () => void;
    primaryDisabled?: boolean;
    primaryText?: string;
    secondaryText?: string;
    hideSecondary?: boolean;
    wide?: boolean;
    onclose: () => void;
    children: Snippet;
  }

  let {
    header = undefined,
    open,
    primaryAction = undefined,
    primaryDisabled = false,
    primaryText = "Do it!",
    secondaryText = "Close",
    hideSecondary = false,
    wide = false,
    onclose,
    children
  }: Props = $props();

  let dialogElement = $state<HTMLDialogElement>();

  $effect(() => {
    if (!open || !dialogElement) {
      return;
    }

    // Capture the element: by teardown time bind:this has already reset
    // dialogElement to null when the {#if open} branch is destroyed.
    const dialog = dialogElement;
    dialog.showModal();

    return () => {
      if (dialog.open) {
        dialog.close();
      }
    };
  });

  const close = () => {
    // Close while connected so the browser restores focus before the
    // parent removes the component.
    dialogElement?.close();
    onclose();
  };

  function handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    if (primaryAction) {
      primaryAction();
    }
  }

  function handleBackdropClick(event: MouseEvent) {
    if (event.currentTarget === event.target) {
      close();
    }
  }

  function handleCancel(event: Event) {
    event.preventDefault();
    close();
  }
</script>

<style lang="scss">
  .background {
    align-items: center;
    background-color: rgba(0, 0, 0, 0.4);
    border: 0;
    box-sizing: border-box;
    height: 100vh;
    height: 100dvh;
    justify-content: center;
    max-height: none;
    max-width: none;
    margin: 0;
    padding:
      max(1rem, env(safe-area-inset-top))
      max(1rem, env(safe-area-inset-right))
      max(1rem, env(safe-area-inset-bottom))
      max(1rem, env(safe-area-inset-left));
    width: 100vw;
    width: 100dvw;
  }

  // Only show the dialog once showModal() has flipped the open attribute;
  // an unconditional display would render it in-flow, outside the top layer.
  .background[open] {
    display: flex;
  }

  .card {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    box-sizing: border-box;
    max-height: 100%;
    max-width: 400px;
    overflow-y: auto;
    width: 100%;
    border: none;
    background-color: white;
    margin: 0;
    padding: 1em;
    box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.2), 0 6px 20px 0 rgba(0, 0, 0, 0.19);
    border-radius: 5px;
  }

  .content {
    padding: 2em 0;
  }

  .card.wide {
    max-width: 1080px;
    padding: 0;
    text-align: left;
  }

  .wide .modal-heading {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 1rem 1.5rem;
    background: white;
    border-bottom: 1px solid #e1e5e5;
  }

  .wide .header { margin: 0; font-size: 1rem; }
  .wide .content { padding: 1.5rem; }
  .wide .buttons { padding: 0 1.5rem 1.5rem; }
  .top-close { border: 1px solid #ccd4d4; border-radius: 5px; background: white; padding: .35rem .75rem; }
  .top-close:focus-visible { outline: 3px solid #1b7179; outline-offset: 2px; }

  @media (max-width: 600px) {
    .wide .modal-heading, .wide .content { padding: 1rem; }
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
  <dialog
    bind:this={dialogElement}
    aria-label={header ?? "Dialog"}
    onclick={handleBackdropClick}
    oncancel={handleCancel}
    class="background">
    <form class="card hover" class:wide onsubmit={handleSubmit}>
      {#if header}
        <div class="modal-heading">
          <h4 class="header">{header}</h4>
          {#if wide}<button type="button" class="top-close" onclick={close}>Close</button>{/if}
        </div>
        <div class="divider"></div>
      {/if}
      <div class="content">
        {@render children()}
      </div>
      <div class="divider"></div>
      <div class="buttons">
        {#if !hideSecondary}
          <Button type="button" onclick={close}>{secondaryText}</Button>
        {/if}
        {#if primaryAction}
          <Button primary type="submit" disabled={primaryDisabled}>{primaryText}</Button>
        {/if}
      </div>
    </form>
    <!-- Inside the dialog subtree so it stays interactive while this modal
         is open (see ErrorBanner.svelte for the inertness rationale), and
         after the form so showModal()'s initial focus lands on the modal's
         first field, not the banner's dismiss button. -->
    <ErrorBanner />
  </dialog>
{/if}
