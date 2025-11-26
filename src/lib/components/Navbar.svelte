<script>
  import NavLink from "../components/NavLink.svelte";
  import { Navbar } from "sveltestrap";
</script>

<nav>
  <Navbar color="dark" dark class="mb-2">
    <NavLink to="/finished">Finished</NavLink>
    <NavLink to="/">Right Now</NavLink>
    <NavLink to="/me">My site</NavLink>
  </Navbar>
</nav>
