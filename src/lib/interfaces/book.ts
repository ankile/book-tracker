export interface Book {
  id: string;
  currentPage: number;
  pageCount: number;
  title: string;
  author: string;
  activeTimer?: { entryId: number; start: string } | null;
}
