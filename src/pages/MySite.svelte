<script>
  import { navigate } from "svelte-routing";

  export let auth;

  function signOut() {
    auth.signOut();
    navigate("/", { replace: true });
  }
</script>

<h1>Hi</h1>

<button on:click={signOut}>Sign out</button>
