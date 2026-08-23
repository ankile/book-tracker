<script>
  import 'bootstrap/dist/css/bootstrap.min.css';
  import { page } from '$app/state';
  import { user } from '$lib/firebase/auth.js';
  import Navbar from '$lib/components/Navbar.svelte';
  import Login from '$lib/components/Login.svelte';
  import LaunchScreen from '$lib/components/LaunchScreen.svelte';
  import ErrorBanner from '$lib/components/ErrorBanner.svelte';

  let { children } = $props();

  // /profiles/<username> is the shareable public page: no auth gate and no
  // launch screen (the page doesn't need the session, so there is nothing
  // to wait for). It gets a minimal header instead of the app navbar —
  // just a "Go to app" link to /, which the gate below resolves to the
  // login screen when signed out and Currently Reading when signed in.
  const publicRoute = $derived(page.route.id?.startsWith('/profiles') ?? false);
</script>

<style>
  :global(body) {
    margin: 0;
    padding: 0;
  }

  main {
    text-align: center;
    padding: 0;
    margin: 0 auto;
  }

  .public-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.6rem 1rem;
    background: #212529;
    color: white;
  }

  .public-bar .brand {
    font-weight: 600;
  }

  .public-bar .go-to-app {
    color: white;
    text-decoration: none;
    font-weight: 600;
    padding: 0.35rem 1rem;
    border: 1px solid rgba(255, 255, 255, 0.5);
    border-radius: 5px;
  }

  .public-bar .go-to-app:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  .app-view {
    min-height: calc(
      100vh - env(safe-area-inset-top) - env(safe-area-inset-bottom)
    );
    min-height: calc(
      100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom)
    );
    background: white;
  }
</style>

<ErrorBanner />

{#if publicRoute}
  <div class="app-view">
    <header class="public-bar">
      <span class="brand">Book Tracker</span>
      <a class="go-to-app" href="/">Go to app</a>
    </header>
    <main>
      {@render children()}
    </main>
  </div>
{:else if $user === undefined}
  <LaunchScreen />
{:else}
  <div class="app-view">
    {#if $user}
      <Navbar />
      <main>
        {@render children()}
      </main>
    {:else}
      <Login />
    {/if}
  </div>
{/if}
