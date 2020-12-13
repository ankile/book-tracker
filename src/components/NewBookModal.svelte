<script>
  import { createEventDispatcher } from "svelte";

  import ModalCard from "../components/ModalCard.svelte";
  import Input from "../components/Input.svelte";

  import { Database } from "../firebase/db";

  const dispatch = createEventDispatcher();

  export let open;
  export let userId;

  let author = "";
  let title = "";
  let pageCount;
  let currentPage = 1;
  let isbn = "";

  function addBook() {
    Database.addBook({
      userId,
      author,
      title,
      pageCount,
      currentPage,
      isbn,
    });
    dispatch("close");
  }
</script>

<style>
  .space {
    height: 1em;
  }
</style>

<ModalCard
  {open}
  on:close={() => dispatch('close')}
  header="Add new book"
  primaryText="Add book"
  primaryAction={addBook}>
  <Input label="Author">
    <input type="text" bind:value={author} placeholder="Name of author(s)" />
  </Input>

  <div class="space" />

  <Input label="Book title">
    <input type="text" bind:value={title} placeholder="Book title" />
  </Input>

  <div class="space" />

  <Input label="Number of pages">
    <input
      type="number"
      bind:value={pageCount}
      placeholder="How many pages are there?" />
  </Input>

  <div class="space" />

  <Input label="Current page">
    <input
      type="number"
      bind:value={currentPage}
      placeholder="Have you already started reading?" />
  </Input>

  <div class="space" />

  <Input label="ISBN number (optional)">
    <input type="text" bind:value={isbn} placeholder="ISBN" />
  </Input>
</ModalCard>
