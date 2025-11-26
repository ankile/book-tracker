<script>
  import { user } from '$lib/firebase/auth.js';
  import BookList from '$lib/components/BookList.svelte';
</script>

{#if $user}
  <BookList finished={true} userId={$user.uid} />
{/if}
