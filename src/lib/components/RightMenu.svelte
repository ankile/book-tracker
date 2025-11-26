<script lang="ts">
  import Login from "./Login.svelte";

  export let x: number;
  export let y: number;
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
