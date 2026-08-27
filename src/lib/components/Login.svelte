<script lang="ts">
  import Button from "./Button.svelte";
  import { signIn, signUp } from "$lib/firebase/auth.ts";
  import { logIssue } from "$lib/firebase/db.ts";
  import {
    runAuthAttempt,
    type AuthAttemptState,
  } from "$lib/utils/authFailure.ts";

  let login = $state(true);
  let email = $state("");
  let password = $state("");
  let errorMessage = $state("");
  let authAttempt = $state<AuthAttemptState>({ pending: false });

  async function signInOrUp() {
    const operation = login ? 'sign_in' : 'sign_up';
    errorMessage = "";
    const result = await runAuthAttempt(authAttempt, operation, () => (
      operation === 'sign_in'
        ? signIn(email, password)
        : signUp(email, password)
    ));
    if (result.status === 'failed') {
      if (result.failure.issue) logIssue(result.failure.issue);
      errorMessage = result.failure.userMessage;
    }
  }

  function switchMode() {
    login = !login;
    errorMessage = "";
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

    &:disabled {
      cursor: default;
      opacity: 0.6;
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

  .error {
    color: firebrick;
    margin: 0.75rem 0 0;
  }

  .hint {
    margin: -1em 0 1.5em;
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
    aria-busy={authAttempt.pending}
    onsubmit={(event) => {
      event.preventDefault();
      signInOrUp();
    }}>
    <div class="column hover">
      <label for="email">Email address</label>
      <input id="email" placeholder="Email" type="email" bind:value={email} required />
      <label for="password">Password</label>
      <input
        id="password"
        placeholder="Password"
        type="password"
        required
        minlength={login ? undefined : 12}
        bind:value={password} />
      {#if !login}
        <p class="hint">At least 12 characters.</p>
      {/if}
    </div>
    <Button type="submit" disabled={authAttempt.pending}>
      {authAttempt.pending ? 'Please wait…' : login ? 'Log in' : 'Register'}
    </Button>
    {#if errorMessage}
      <p class="error" role="alert">{errorMessage}</p>
    {/if}
  </form>

  <div class="left">
    <p class="bottom-text">
      {#if login}
        If you're not already registered, press
        <button
          type="button"
          onclick={switchMode}
          disabled={authAttempt.pending}
          class="link">here</button>
        to register instead.
      {:else}
        If you're already registered, press
        <button
          type="button"
          onclick={switchMode}
          disabled={authAttempt.pending}
          class="link">here</button>
        to log in instead.
      {/if}
    </p>
  </div>
</div>
