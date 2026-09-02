<script lang="ts">
  import { adminReview } from '$lib/firebase/functions.ts';

  // One button that marks (or unmarks) works or authors reviewed through
  // the admin.review callable. Ids beyond one call's page go as further
  // calls; the listener shows the marks as they land.
  interface Props {
    kind: 'work' | 'author';
    ids: readonly string[];
    reviewed: boolean;
    label: string;
    primary?: boolean;
    onresult: (message: string, ok: boolean) => void;
  }

  let { kind, ids, reviewed, label, primary = false, onresult }: Props = $props();
  let pending = $state(false);

  async function run(): Promise<void> {
    pending = true;
    try {
      let updated = 0;
      for (let start = 0; start < ids.length; start += 100) {
        updated += (await adminReview({ kind, ids: ids.slice(start, start + 100), reviewed })).updated;
      }
      const noun = kind === 'work' ? (updated === 1 ? 'work' : 'works') : (updated === 1 ? 'author' : 'authors');
      onresult(`${updated} ${noun} marked ${reviewed ? 'reviewed' : 'unreviewed'}.`, true);
    } catch (error) {
      onresult(error instanceof Error ? error.message : String(error), false);
    } finally {
      pending = false;
    }
  }
</script>

<button type="button" class:primary disabled={pending || ids.length === 0} onclick={run}>{pending ? 'Saving…' : label}</button>
