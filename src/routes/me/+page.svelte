<script>
  import { user, signOut } from '$lib/firebase/auth.js';
  import { goto } from '$app/navigation';
  import NewBookModal from '$lib/components/NewBookModal.svelte';

  let newBookModal = $state(false);

  async function handleSignOut() {
    await signOut();
    goto('/', { replaceState: true });
  }

  const toggleModal = () => (newBookModal = !newBookModal);
  const closeModal = () => (newBookModal = false);
</script>

<style lang="scss">
  .container {
    display: flex;
    flex-direction: column;
    align-items: center;

    button {
      width: 200px;
      border: none;
      background-color: white;
      margin: 1em;
      padding: 1em;
      box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.2),
        0 6px 20px 0 rgba(0, 0, 0, 0.19);
      border-radius: 5px;

      &:hover {
        box-shadow: 0 2px 4px 0 rgba(0, 0, 0, 0.2),
          0 3px 10px 0 rgba(0, 0, 0, 0.19);
      }

      &:focus {
        outline: none;
      }
    }
  }
</style>

{#if $user}
  <NewBookModal open={newBookModal} onclose={closeModal} userId={$user.uid} />

  <h1>Hi {$user.email}</h1>
  <div class="container">
    <button onclick={toggleModal}>Add new book</button>

    <button onclick={handleSignOut}>Sign out</button>
  </div>
{/if}
