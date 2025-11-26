<script lang="ts">
  import Login from "$lib/components/Login.svelte";

  let { x, y } = $props();
</script>

<style>
  .menu {
    height: 100px;
    width: 100px;
    background: cadetblue;
    position: fixed;
    z-index: 101;
  }
</style>

<div style={`left: ${x}px; top: ${y}px;`} class="menu">Hello</div>
