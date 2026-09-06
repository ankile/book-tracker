<script lang="ts">
  import type { Book } from '../interfaces/book.ts';
  import { readingSummary } from '../utils/readingSummary.ts';
  import { formatReadingTime } from '../utils/format.ts';
  import BookSummary from './BookSummary.svelte';

  // The whole library, finished books included, lends a pace to books
  // without sessions (utils/paceEstimate.ts).
  let { books, library }: { books: Book[]; library: Book[] } = $props();
  const stats = $derived(readingSummary(books, library));
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
      hint: stats.borrowedBooks > 0 && stats.unknownBooks < stats.count
        ? `${stats.borrowedBooks} ${stats.borrowedBooks === 1 ? 'book' : 'books'} estimated from your pace elsewhere`
        : undefined,
    },
  ]}
  completion={stats.completion}
/>
