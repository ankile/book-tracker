<script>
  import Icon from 'svelte-awesome';
  import { times } from 'svelte-awesome/icons';
  import BrandIcon from '$lib/components/BrandIcon.svelte';
  import {
    linkBrandIcon,
    linkDisplay,
    linkHref,
    linkIcon,
    linkTypeName,
  } from '$lib/utils/links.js';

  let { links = [], editable = false, onremove = undefined } = $props();
</script>

<style>
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .public-links {
    display: flex;
    justify-content: center;
    flex-wrap: wrap;
    gap: 0.6rem;
  }

  .public-link {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 42px;
    padding: 0.55rem 0.8rem;
    color: #333;
    font-size: 0.88rem;
    font-weight: 600;
    line-height: 1;
    text-decoration: none;
    background: #fff;
    border: 1px solid #dedede;
    border-radius: 999px;
    transition: color 0.15s, border-color 0.15s, box-shadow 0.15s, transform 0.15s;
  }

  .public-link:hover {
    color: #111;
    border-color: #aaa;
    box-shadow: 0 3px 10px rgba(0, 0, 0, 0.08);
    transform: translateY(-1px);
  }

  .public-link:focus-visible,
  .remove:focus-visible {
    outline: 3px solid rgba(31, 111, 120, 0.28);
    outline-offset: 2px;
  }

  .editor-links {
    overflow: hidden;
    background: #fff;
    border: 1px solid #e2e2e2;
    border-radius: 10px;
  }

  .editor-row {
    display: grid;
    grid-template-columns: 36px minmax(0, 1fr) 36px;
    align-items: center;
    gap: 0.75rem;
    min-height: 62px;
    padding: 0.55rem 0.65rem 0.55rem 0.8rem;
    border-bottom: 1px solid #ededed;
  }

  .editor-row:last-child {
    border-bottom: none;
  }

  .icon-box {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    color: #333;
    background: #f2f3f3;
    border-radius: 8px;
  }

  .link-copy {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .service {
    color: #2f2f2f;
    font-size: 0.9rem;
    font-weight: 650;
    line-height: 1.25;
  }

  .destination {
    overflow: hidden;
    margin-top: 0.12rem;
    color: #6f6f6f;
    font-size: 0.82rem;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    padding: 0;
    color: #8a8a8a;
    background: transparent;
    border: 0;
    border-radius: 8px;
    cursor: pointer;
    transition: color 0.15s, background 0.15s;
  }

  .remove:hover {
    color: #b42318;
    background: #fff1f0;
  }

  @media (max-width: 520px) {
    .public-links {
      gap: 0.5rem;
    }

    .public-link {
      min-height: 40px;
      padding: 0.5rem 0.72rem;
      font-size: 0.84rem;
    }
  }
</style>

{#if editable}
  <ul class="editor-links" aria-label="Profile links">
    {#each links as link, index}
      {@const brandIcon = linkBrandIcon(link)}
      <li class="editor-row">
        <span class="icon-box">
          {#if brandIcon}
            <BrandIcon icon={brandIcon} size={18} />
          {:else}
            <Icon data={linkIcon(link)} />
          {/if}
        </span>
        <span class="link-copy">
          <span class="service">{linkTypeName(link)}</span>
          <span class="destination" title={link.value}>{linkDisplay(link)}</span>
        </span>
        <button
          type="button"
          class="remove"
          aria-label="Remove {linkTypeName(link)}"
          onclick={() => onremove(index)}>
          <Icon data={times} />
        </button>
      </li>
    {/each}
  </ul>
{:else}
  <ul class="public-links" aria-label="Profile links">
    {#each links as link}
      {@const brandIcon = linkBrandIcon(link)}
      <li>
        <a
          class="public-link"
          href={linkHref(link)}
          target="_blank"
          rel="noopener noreferrer nofollow"
          title={linkDisplay(link)}
          aria-label="{linkTypeName(link)}: {linkDisplay(link)}">
          {#if brandIcon}
            <BrandIcon icon={brandIcon} size={17} />
          {:else}
            <Icon data={linkIcon(link)} />
          {/if}
          <span>{linkTypeName(link)}</span>
        </a>
      </li>
    {/each}
  </ul>
{/if}
