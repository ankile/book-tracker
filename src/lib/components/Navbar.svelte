<script lang="ts">
  import { user } from '$lib/firebase/auth.ts';
  import { ADMIN_UID } from '$lib/admin-uid.ts';
  import NavLink from './NavLink.svelte';
  import NewBookModal from './NewBookModal.svelte';

  let addBookModal = $state(false);
</script>

<style>
  .app-bar {
    margin-bottom: 0.75rem;
    padding: 0.7rem 1rem;
    color: #edf5f5;
    background: #294f52;
    border-bottom: 3px solid #6f9b9d;
  }

  .app-bar-inner {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 1rem;
    width: min(100%, 1100px);
    margin: 0 auto;
  }

  .brand {
    display: inline-flex;
    align-items: center;
    gap: 0.65rem;
    min-height: 44px;
    color: white;
    font-size: 1.05rem;
    font-weight: 750;
    text-decoration: none;
    white-space: nowrap;
  }

  .brand-mark {
    display: inline-grid;
    place-items: center;
    width: 34px;
    height: 34px;
    color: #294f52;
    background: #edf5f5;
    border-radius: 9px;
  }

  .brand-mark svg {
    width: 21px;
    height: 21px;
  }

  .primary-links {
    display: flex;
    justify-content: center;
    gap: 0.25rem;
  }

  .add-book {
    min-height: 44px;
    padding: 0.55rem 0.95rem;
    color: #294f52;
    font-size: 0.92rem;
    font-weight: 700;
    line-height: 1;
    background: #edf5f5;
    border: 1px solid #edf5f5;
    border-radius: 9px;
    cursor: pointer;
    transition: background 0.15s ease-in-out, border-color 0.15s ease-in-out;
    white-space: nowrap;
  }

  .add-book:hover {
    background: white;
    border-color: white;
  }

  .brand:focus-visible,
  .add-book:focus-visible {
    outline: 2px solid white;
    outline-offset: 3px;
  }

  @media only screen and (max-width: 720px) {
    .app-bar {
      padding: 0.55rem 0.75rem 0.6rem;
    }

    .app-bar-inner {
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 0.35rem 0.75rem;
    }

    .primary-links {
      display: grid;
      grid-column: 1 / -1;
      grid-row: 2;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 0.25rem;
      padding-top: 0.45rem;
      border-top: 1px solid rgba(237, 245, 245, 0.2);
    }

    .add-book {
      grid-column: 2;
      grid-row: 1;
    }
  }

  @media only screen and (max-width: 360px) {
    .brand {
      gap: 0.45rem;
      font-size: 0.96rem;
    }

    .brand-mark {
      width: 32px;
      height: 32px;
    }

    .add-book {
      padding-right: 0.7rem;
      padding-left: 0.7rem;
      font-size: 0.86rem;
    }
  }
</style>

<nav class="app-bar" aria-label="Primary navigation">
  <div class="app-bar-inner">
    <a class="brand" href="/" aria-label="Book Tracker home">
      <span class="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <rect x="4" y="3" width="16" height="18" rx="2"></rect>
          <path d="M8 3v18M11.5 7h5M11.5 11h5"></path>
        </svg>
      </span>
      <span>Book Tracker</span>
    </a>

    <div class="primary-links">
      <NavLink to="/">{#snippet children()}Reading{/snippet}</NavLink>
      <NavLink to="/finished">{#snippet children()}Finished{/snippet}</NavLink>
      <NavLink to="/me">{#snippet children()}Dashboard{/snippet}</NavLink>
      {#if $user?.uid === ADMIN_UID}
        <NavLink to="/admin">{#snippet children()}Admin{/snippet}</NavLink>
      {/if}
    </div>

    <button class="add-book" type="button" onclick={() => (addBookModal = true)}>
      + Add book
    </button>
  </div>
</nav>

{#if $user}
  <NewBookModal open={addBookModal} onclose={() => (addBookModal = false)} userId={$user.uid} />
{/if}
