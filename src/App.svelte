<script>
  import { Router, Route } from "svelte-routing";
  import Reading from "./pages/Reading.svelte";
  import Finished from "./pages/Finished.svelte";
  import Navbar from "./components/Navbar.svelte";
</script>

<style>
  main {
    text-align: center;
    padding: 0;
    margin: 0 auto;
  }
</style>

<Router>
  <Navbar />

  <main>
    <Route path="/finished" component={Finished} />
    <Route path="/" component={Reading} />
  </main>
</Router>
