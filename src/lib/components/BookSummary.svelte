<script lang="ts">
  import type { Snippet } from 'svelte';

  let { label, testId, stats, completion, note, children }: {
    label: string;
    testId?: string;
    stats: { label: string; value: string; hint?: string }[];
    completion?: number;
    note?: string;
    children?: Snippet;
  } = $props();
</script>

<section aria-label={label} data-testid={testId}>
  <dl>
    {#each stats as stat}
      <div class="stat">
        <dt>{stat.label}</dt>
        <dd>{stat.value}{#if stat.hint}<span class="hint">{stat.hint}</span>{/if}</dd>
      </div>
    {/each}
  </dl>
  {#if completion !== undefined}
    <progress max="100" value={completion} aria-label="Overall reading completion"></progress>
  {/if}
  {#if note}<p>{note}</p>{/if}
  {#if children}<div class="controls">{@render children()}</div>{/if}
</section>

<style>
  section { background: white; padding: 1.5rem 2rem; border: 1px solid #e2e8e8; border-radius: 8px; box-shadow: 0 2px 4px #0000000d; text-align: left; }
  dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 1.25rem 2rem; margin: 0; }
  .stat { min-width: 0; }
  dt { font-size: .8rem; color: #53636a; text-transform: uppercase; font-weight: 600; }
  dd { font-size: 1.5rem; color: #253237; font-weight: 700; font-variant-numeric: tabular-nums; margin: .35rem 0 0; }
  .hint, p { font-size: .75rem; color: #53636a; font-weight: 400; }
  .hint { display: block; margin-top: .3rem; }
  progress { display: block; width: 100%; height: 6px; margin-top: 1.25rem; border: 0; border-radius: 3px; overflow: hidden; background: #e9eeee; accent-color: #1b7179; }
  progress::-webkit-progress-bar { background: #e9eeee; }
  progress::-webkit-progress-value { background: #1b7179; }
  progress::-moz-progress-bar { background: #1b7179; }
  p { margin: .75rem 0 0; line-height: 1.5; }
  .controls { border-top: 1px solid #e2e8e8; margin-top: 1.5rem; padding-top: 1.25rem; }
  @media (max-width: 770px) {
    section { padding: 1rem; }
    dl { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.25rem 1rem; }
    dd { font-size: 1.2rem; }
  }
</style>
