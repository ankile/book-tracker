<script>
  import { user } from '$lib/firebase/auth.js';
  import BookList from '$lib/components/BookList.svelte';
</script>

{#if $user}
  <BookList finished={false} userId={$user.uid} />
{/if}
