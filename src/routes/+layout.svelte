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
  // to wait for). Signed-in visitors still get the navbar so their own app
  // stays reachable.
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
    {#if $user}
      <Navbar />
    {/if}
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
