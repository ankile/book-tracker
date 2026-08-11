<script>
  // Author field with autocomplete against the user's existing authors.
  // Hand-rolled (bundle budget): a relative wrapper with an absolutely
  // positioned list, which works inside the <dialog> top layer without a
  // portal. Multi-author entry is comma-separated, so suggestions match
  // only the segment after the last comma and selection replaces only
  // that segment.
  let { value = $bindable(), authors, inputId } = $props();

  let focused = $state(false);
  let dismissed = $state(false);
  let highlighted = $state(0);

  const lastComma = $derived(value.lastIndexOf(","));
  const segment = $derived(value.slice(lastComma + 1).trim().toLowerCase());
  const enteredLower = $derived(
    new Set(value.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s !== ""))
  );

  const suggestions = $derived(
    focused && !dismissed && segment !== ""
      ? authors
          .filter((a) => a.nameLower.includes(segment) && !enteredLower.has(a.nameLower))
          .slice(0, 6)
      : []
  );

  function select(author) {
    const prefix = lastComma === -1 ? "" : value.slice(0, lastComma + 1) + " ";
    value = prefix + author.name;
    highlighted = 0;
  }

  function onkeydown(event) {
    if (suggestions.length === 0) return;
    if (event.key === "ArrowDown") {
      highlighted = (highlighted + 1) % suggestions.length;
      event.preventDefault();
    } else if (event.key === "ArrowUp") {
      highlighted = (highlighted - 1 + suggestions.length) % suggestions.length;
      event.preventDefault();
    } else if (event.key === "Enter") {
      // The list is open: Enter picks, it must not submit the form.
      select(suggestions[Math.min(highlighted, suggestions.length - 1)]);
      event.preventDefault();
    } else if (event.key === "Escape") {
      // Close only the list, not the surrounding dialog.
      dismissed = true;
      event.preventDefault();
    }
  }
</script>

<style>
  .autocomplete {
    position: relative;
  }

  .suggestions {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    z-index: 10;
    margin: 0;
    padding: 0;
    list-style: none;
    background: white;
    border: 1px solid #ced4da;
    border-radius: 0 0 4px 4px;
    max-height: 12rem;
    overflow-y: auto;
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
  }

  .suggestions li {
    padding: 0.375rem 0.75rem;
    cursor: pointer;
    text-align: start;
  }

  .suggestions li.highlighted {
    background-color: #e9ecef;
  }
</style>

<div class="autocomplete">
  <input
    id={inputId}
    class="form-control"
    type="text"
    autocomplete="off"
    bind:value
    placeholder="Name of author(s)"
    onfocus={() => (focused = true)}
    onblur={() => (focused = false)}
    oninput={() => {
      dismissed = false;
      highlighted = 0;
    }}
    {onkeydown} />
  {#if suggestions.length > 0}
    <ul class="suggestions" role="listbox">
      {#each suggestions as author, index (author.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
        <li
          role="option"
          aria-selected={index === highlighted}
          class:highlighted={index === highlighted}
          onmousedown={(event) => {
            // preventDefault keeps focus in the input (blur would empty
            // the list before click could land).
            event.preventDefault();
            select(author);
          }}>
          {author.name}
        </li>
      {/each}
    </ul>
  {/if}
</div>
