<script>
  import NavLink from "./NavLink.svelte";
  import { Navbar } from "sveltestrap";
</script>

<nav>
  <Navbar color="dark" dark class="mb-2">
    <NavLink to="/finished">{#snippet children()}Finished{/snippet}</NavLink>
    <NavLink to="/">{#snippet children()}Right Now{/snippet}</NavLink>
    <NavLink to="/me">{#snippet children()}My site{/snippet}</NavLink>
  </Navbar>
</nav>
