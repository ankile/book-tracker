<script lang="ts">
  import { FirebaseError } from "firebase/app";
  import Button from "./Button.svelte";
  import { signIn, signUp } from "$lib/firebase/auth.ts";
  import { logIssue } from "$lib/firebase/db.ts";

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
      if (!(error instanceof FirebaseError)) throw error;
      // No session exists yet, so the row is anonymous; detail.email keeps
      // the attempt attributable. Only an address-shaped value is recorded:
      // typing a password into the email box is a common slip, and logging
      // whatever was in the field would write that credential to the issue
      // log verbatim. The password field itself is never read here.
      const isAddress = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      logIssue({
        level: "warn",
        event: login ? "auth.sign_in_failed" : "auth.sign_up_failed",
        message: error.message,
        code: error.code,
        detail: isAddress ? { email } : null,
      });
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
    appearance: none;
    background: none;
    border: 0;
    color: $color;
    cursor: pointer;
    font: inherit;
    padding: 0;
    text-decoration: none;

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
    width: min($width, calc(100vw - 2rem));
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
  <form
    class="column form"
    onsubmit={(event) => {
      event.preventDefault();
      signInOrUp();
    }}>
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
    <Button type="submit">{login ? 'Log in' : 'Register'}</Button>
  </form>

  <div class="left">
    <p class="bottom-text">
      {#if login}
        If you're not already registered, press
        <button
          type="button"
          onclick={() => (login = !login)}
          class="link">here</button>
        to register instead.
      {:else}
        If you're already registered, press
        <button
          type="button"
          onclick={() => (login = !login)}
          class="link">here</button>
        to log in instead.
      {/if}
    </p>
  </div>
</div>
