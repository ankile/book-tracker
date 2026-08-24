export interface BookMetadata {
  coverUrl: string;
  publisher: string;
  publishedDate: string;
  subjects: string[];
  fiction: boolean | null;
}

export interface BookLookupResult extends BookMetadata {
  title: string;
  authorNames: string[];
  pageCount: number | undefined;
}

export type BookMetadataPatch = Partial<BookMetadata>;
