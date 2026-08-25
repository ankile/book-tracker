<script lang="ts">
  // Chips author field: the bound value is a list of chips {id, name}
  // (id null = new author, minted at write time), so the field shows
  // exactly the author entities the book will reference — new authors
  // dashed, existing ones solid. Hand-rolled (bundle budget): a relative
  // wrapper with an absolutely positioned suggestion list, which works
  // inside the <dialog> top layer without a portal.
  import { resolveChip, selectableAuthors, splitAuthors, joinPersonName } from "../utils/authors.ts";
  import type { Author, AuthorChip } from "../interfaces/author.ts";

  let {
    chips = $bindable(),
    authors,
    inputId,
  }: { chips: AuthorChip[]; authors: Author[]; inputId: string } = $props();

  let text = $state("");
  let focused = $state(false);
  let dismissed = $state(false);
  let highlighted = $state(0);
  let inputEl = $state<HTMLInputElement | null>(null);

  const draft = $derived(text.trim().toLowerCase());
  const chipIds = $derived(new Set(chips.filter((c) => c.id !== null).map((c) => c.id)));
  const chipNamesLower = $derived(new Set(chips.map((c) => c.name.toLowerCase())));
  const availableAuthors = $derived(selectableAuthors(authors));

  const suggestions = $derived(
    focused && !dismissed && draft !== ""
      ? availableAuthors.filter((a) => a.nameLower.includes(draft) && !chipIds.has(a.id)).slice(0, 6)
      : []
  );

  function isDuplicate(chip: AuthorChip) {
    return chip.id !== null ? chipIds.has(chip.id) : chipNamesLower.has(chip.name.toLowerCase());
  }

  function commit(name: string) {
    const chip = resolveChip(name, authors);
    if (chip.name !== "" && !isDuplicate(chip)) chips = [...chips, chip];
    text = "";
    highlighted = 0;
  }

  function select(author: Author) {
    if (!chipIds.has(author.id)) chips = [...chips, { id: author.id, name: author.name }];
    text = "";
    highlighted = 0;
  }

  function removeChip(index: number) {
    chips = chips.filter((_, i) => i !== index);
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === ",") {
      event.preventDefault();
      commit(text);
    } else if (event.key === "Enter") {
      if (suggestions.length > 0) {
        // The list is open: Enter picks, it must not submit the form.
        event.preventDefault();
        select(suggestions[Math.min(highlighted, suggestions.length - 1)]);
      } else if (text.trim() !== "") {
        // Chip the draft; a second Enter (now empty) submits the form.
        event.preventDefault();
        commit(text);
      }
    } else if (event.key === "Backspace" && text === "" && chips.length > 0) {
      chips = chips.slice(0, -1);
    } else if (event.key === "ArrowDown" && suggestions.length > 0) {
      highlighted = (highlighted + 1) % suggestions.length;
      event.preventDefault();
    } else if (event.key === "ArrowUp" && suggestions.length > 0) {
      highlighted = (highlighted - 1 + suggestions.length) % suggestions.length;
      event.preventDefault();
    } else if (event.key === "Escape" && suggestions.length > 0) {
      // Close only the list, not the surrounding dialog.
      dismissed = true;
      event.preventDefault();
    }
  }

  // Pasted author lists ("Kahneman, Tversky & Thaler") split into chips;
  // plain pastes fall through to normal input.
  function onpaste(event: ClipboardEvent) {
    const pasted = event.clipboardData?.getData("text") ?? '';
    if (!pasted.includes(",") && !pasted.includes("&")) return;
    event.preventDefault();
    for (const name of splitAuthors(text + pasted)) commit(name);
  }
</script>

<style>
  .autocomplete {
    position: relative;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    align-items: center;
    cursor: text;
  }

  .chips input {
    flex: 1;
    min-width: 8ch;
    border: none;
    outline: none;
    padding: 0;
    background: transparent;
    font: inherit;
    color: inherit;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.05rem 0.5rem;
    border: 1px solid #ced4da;
    border-radius: 999px;
    background: #e9ecef;
    font-size: 0.9rem;
    white-space: nowrap;
  }

  .chip.new-author {
    background: transparent;
    border-style: dashed;
  }

  .chip-remove {
    border: none;
    background: none;
    padding: 0;
    cursor: pointer;
    line-height: 1;
    font-size: 1.1rem;
    color: #6c757d;
  }

  .chip-remove:hover {
    color: #212529;
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
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="chips form-control"
    onmousedown={(event) => {
      // Clicking the field (not a chip button) focuses the inner input;
      // preventDefault stops the click from blurring it again.
      if (event.target === event.currentTarget) {
        event.preventDefault();
        inputEl?.focus();
      }
    }}>
    {#each chips as chip, index (chip.id ?? `new:${chip.name.toLowerCase()}`)}
      <span class="chip" class:new-author={chip.id === null} title={chip.id === null ? "New author" : chip.name}>
        {chip.id === null && chip.kind === "person" ? joinPersonName(chip) : chip.name}
        <button
          type="button"
          class="chip-remove"
          aria-label={`Remove ${chip.name}`}
          onclick={() => removeChip(index)}>×</button>
      </span>
    {/each}
    <input
      bind:this={inputEl}
      id={inputId}
      type="text"
      autocomplete="off"
      role="combobox"
      aria-controls={`${inputId}-listbox`}
      aria-expanded={suggestions.length > 0}
      aria-autocomplete="list"
      aria-activedescendant={suggestions.length > 0 ? `${inputId}-option-${highlighted}` : undefined}
      bind:value={text}
      placeholder={chips.length === 0 ? "Name of author(s)" : ""}
      onfocus={() => (focused = true)}
      onblur={() => {
        // Committing on blur keeps an uncommitted draft from being lost
        // when the user clicks straight to "Add book": blur fires first
        // and state updates synchronously, so the chip lands before
        // submit reads it.
        focused = false;
        commit(text);
      }}
      oninput={() => {
        dismissed = false;
        highlighted = 0;
      }}
      {onkeydown}
      {onpaste} />
  </div>
  {#if suggestions.length > 0}
    <ul class="suggestions" id={`${inputId}-listbox`} role="listbox">
      {#each suggestions as author, index (author.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
        <li
          id={`${inputId}-option-${index}`}
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
