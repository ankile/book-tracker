<script>
  import NavLink from "./NavLink.svelte";
</script>

<nav class="navbar bg-dark mb-2" data-bs-theme="dark" aria-label="Primary navigation">
  <div class="container-fluid">
    <NavLink to="/finished">{#snippet children()}Finished{/snippet}</NavLink>
    <NavLink to="/">{#snippet children()}Currently Reading{/snippet}</NavLink>
    <NavLink to="/me">{#snippet children()}My site{/snippet}</NavLink>
  </div>
</nav>
