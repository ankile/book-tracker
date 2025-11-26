<script>
  let { primary = false, onclick } = $props();
</script>

<style lang="scss">
  .hover {
    border: none;
    color: black;
    background-color: white;
    margin: 0.5em;
    padding: 0.5em 1em;
    box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.2), 0 6px 20px 0 rgba(0, 0, 0, 0.19);
    border-radius: 5px;
    transition: box-shadow 0.2s;

    &:hover {
      box-shadow: 0 2px 4px 0 rgba(0, 0, 0, 0.2),
        0 3px 10px 0 rgba(0, 0, 0, 0.19);
    }

    &:focus {
      outline: none;
    }
  }

  .primary {
    color: white;
    background-color: cadetblue;
  }

  .btn-container {
    display: flex;
    flex-direction: row;
    justify-content: center;
  }
</style>

<div class="btn-container">
  <button class="hover" class:primary {onclick}>
    <slot>Click</slot>
  </button>
</div>
