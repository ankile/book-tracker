<script>
  import { user } from '$lib/firebase/auth.js';
  import Navbar from '$lib/components/Navbar.svelte';
  import Login from '$lib/components/Login.svelte';
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
</style>

{#if $user}
  <Navbar />
  <main>
    <slot />
  </main>
{:else}
  <Login />
{/if}
