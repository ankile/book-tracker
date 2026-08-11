export interface Book {
  id: string;
  currentPage: number;
  pageCount: number;
  title: string;
  // Legacy joined string, kept in sync with authors by every write.
  author: string;
  // Refs into users/{uid}/authors; absent only on docs written by clients
  // predating the authors migration.
  authors?: { id: string; name: string }[];
  // entryId is only present for Toggl-backed timers; local timers store just the start time
  activeTimer?: { entryId?: number; start: string } | null;
}
