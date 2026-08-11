export interface Book {
  id: string;
  currentPage: number;
  pageCount: number;
  title: string;
  // Author doc ids into users/{uid}/authors, in display order.
  authorIds?: string[];
  // Legacy authorship, present only on docs last written by pre-authorIds
  // clients. Legacy wins on read: its presence proves an old client wrote
  // last, so any authorIds alongside it are stale. Removed once the
  // straggler migration passes clean.
  author?: string;
  authors?: { id: string; name: string }[];
  // entryId is only present for Toggl-backed timers; local timers store just the start time
  activeTimer?: { entryId?: number; start: string } | null;
}
