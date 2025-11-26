<script>
  import Button from "./Button.svelte";
  import { signIn, signUp } from "$lib/firebase/auth.js";

  let login = $state(true);
  let email = $state("");
  let password = $state("");

  async function signInOrUp() {
    try {
      if (login) {
        await signIn(email, password);
      } else {
        await signUp(email, password);
      }
    } catch (error) {
      alert(error.message);
    }
  }
</script>

<style lang="scss">
  $color: cadetblue;
  $width: 400px;

  .container {
    display: flex;
    flex-direction: column;
    align-items: center;
    max-width: $width;
  }

  .left {
    width: 100%;
    text-align: left;
  }

  h1 {
    margin: 1em;
  }

  h3 {
    font-size: 1.5rem;
  }

  .link {
    color: $color;
    cursor: pointer;

    &:hover {
      filter: brightness(0.8);
      text-decoration: underline;
    }
  }

  input {
    border: none;
    border-bottom: 1px solid darkgray;
    margin-bottom: 1.5em;
    padding-bottom: 2px;

    &:focus {
      outline: none;
      border-bottom: 3px solid $color;
      padding-bottom: 0;
    }
  }

  .column {
    display: flex;
    flex-direction: column;
    align-items: stretch;
  }

  .form {
    width: $width;
  }

  .hover {
    border: none;
    background-color: white;
    margin: 1em;
    padding: 1em;
    box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.2), 0 6px 20px 0 rgba(0, 0, 0, 0.19);
    border-radius: 5px;
    transition: box-shadow 0.2s;
  }

  .bottom-text {
    margin-top: 1em;
    font-size: smaller;
    color: darkgray;
  }
</style>

<div class="container">
  <h1>Book Tracker</h1>
  <div class="left">
    <h3>
      {#if login}
        Log in to use the service
      {:else}Register to start using the service{/if}
    </h3>
  </div>
  <div
    class="column form"
    on:keypress={(event) => event.key === 'Enter' && signInOrUp()}>
    <div class="column hover">
      <label for="email">Email address</label>
      <input id="email" placeholder="Email" type="email" bind:value={email} />
      <label for="password">Password</label>
      <input
        id="password"
        placeholder="Password"
        type="password"
        bind:value={password} />
    </div>
    <Button onclick={signInOrUp}>{login ? 'Log in' : 'Register'}</Button>
  </div>

  <div class="left">
    <p class="bottom-text">
      {#if login}
        If you're not already registered, press
        <span
          role="button"
          tabindex="0"
          on:click={() => (login = !login)}
          on:keypress={(e) => e.key === 'Enter' && (login = !login)}
          class="link">here</span>
        to register instead.
      {:else}
        If you're already registered, press
        <span
          role="button"
          tabindex="0"
          on:click={() => (login = !login)}
          on:keypress={(e) => e.key === 'Enter' && (login = !login)}
          class="link">here</span>
        to log in instead.
      {/if}
    </p>
  </div>
</div>
