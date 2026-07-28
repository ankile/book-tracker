export interface Book {
  id: string;
  currentPage: number;
  pageCount: number;
  title: string;
  author: string;
  // entryId is only present for Toggl-backed timers; local timers store just the start time
  activeTimer?: { entryId?: number; start: string } | null;
}
