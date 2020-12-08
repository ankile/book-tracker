<script>
  import NavLink from "../components/NavLink.svelte";
  import { Navbar, NavbarBrand } from "sveltestrap";
</script>

<nav>
  <Navbar color="dark" dark class="mb-2">
    <NavLink to="/finished">Finished</NavLink>
    <NavLink to="/">Currently Reading</NavLink>
    <NavLink to="#">Stats</NavLink>
  </Navbar>
</nav>
