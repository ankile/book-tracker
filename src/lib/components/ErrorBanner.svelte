<script>
  import { errors, dismissError } from '$lib/stores/errors.js';

  // Mounted twice: once in +layout.svelte and once inside ModalCard's
  // <dialog>. A modal dialog makes everything outside its subtree inert —
  // even other top-layer elements — so a single global banner would be
  // visible but untouchable behind an open modal (and a tap on it would
  // land on the dialog backdrop and close the modal). The instance inside
  // the topmost dialog is never inert; when no modal is open only the
  // layout instance exists. Both render fixed at identical viewport
  // coordinates, so stacked instances overlap exactly and read as one.
</script>

<style>
  /* Below the navbar so nav links stay clickable while errors are shown.
     pointer-events splits so the empty container never intercepts taps. */
  .error-banner {
    position: fixed;
    left: 0.75rem;
    right: 0.75rem;
    top: calc(env(safe-area-inset-top) + 3.5rem);
    margin: 0 auto;
    max-width: 500px;
    max-height: 50vh;
    overflow-y: auto;
    z-index: 1080;
    pointer-events: none;
  }

  .error-banner .alert {
    pointer-events: auto;
  }
</style>

<div class="error-banner">
  {#each $errors as error (error.id)}
    <div class="alert alert-danger alert-dismissible mb-2" role="alert">
      {error.message}
      <button
        type="button"
        class="btn-close"
        aria-label="Dismiss"
        onclick={() => dismissError(error.id)}></button>
    </div>
  {/each}
</div>
