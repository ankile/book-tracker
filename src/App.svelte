<script>
  import { Router, Route } from "svelte-routing";
  import { FirebaseApp, User } from "sveltefire";
  import Reading from "./pages/Reading.svelte";
  import Finished from "./pages/Finished.svelte";
  import MySite from "./pages/MySite.svelte";
  import Navbar from "./components/Navbar.svelte";
  import Login from "./components/Login.svelte";
</script>

<style>
  main {
    text-align: center;
    padding: 0;
    margin: 0 auto;
  }
</style>

<Router>
  <FirebaseApp>
    <User persist={sessionStorage} let:user let:auth on:user>
      <Navbar {auth} />

      <div slot="signed-out">
        <Login {auth} />
      </div>

      <div slot="default">
        <main>
          <Route path="/finished" component={Finished} />
          <Route path="/me">
            <MySite {auth} />
          </Route>
          <Route path="/" component={Reading} />
        </main>
      </div>
    </User>
  </FirebaseApp>
</Router>
