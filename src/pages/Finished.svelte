<script>
  import BookList from "../components/BookList.svelte";
  export let userId;
</script>

<BookList finished={true} {userId} />
