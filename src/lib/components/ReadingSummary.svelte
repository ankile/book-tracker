<script lang="ts">
  import type { Book } from '../interfaces/book.ts';
  import { readingSummary } from '../utils/readingSummary.ts';
  import { formatReadingTime } from '../utils/format.ts';
  import BookSummary from './BookSummary.svelte';

  let { books }: { books: Book[] } = $props();
  const stats = $derived(readingSummary(books));
</script>

<BookSummary
  label="Currently reading summary"
  testId="reading-summary"
  stats={[
    { label: 'Currently reading', value: stats.count + (stats.count === 1 ? ' book' : ' books') },
    { label: 'Overall completion', value: stats.completion.toFixed(1) + '%' },
    { label: 'Pages remaining', value: stats.pagesLeft.toLocaleString() },
    { label: 'Time read', value: formatReadingTime(stats.minutesRead) },
    {
      label: 'Est. reading left',
      value: stats.unknownBooks === stats.count ? 'Not enough data' : formatReadingTime(stats.minutesLeft) + (stats.unknownBooks ? ' +' : ''),
    },
  ]}
  completion={stats.completion}
/>
