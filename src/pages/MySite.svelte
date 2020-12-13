<script>
  import { navigate } from "svelte-routing";
  import NewBookModal from "../components/NewBookModal.svelte";

  export let auth;
  export let user;
  let newBookModal = false;

  function signOut() {
    auth.signOut();
    navigate("/", { replace: true });
  }

  const toggleModal = () => (newBookModal = !newBookModal);
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

<NewBookModal open={newBookModal} on:close={toggleModal} userId={user.uid} />

<h1>Hi {user.email}</h1>
<div class="container">
  <button on:click={toggleModal}>Add new book</button>

  <button on:click={signOut}>Sign out</button>
</div>
