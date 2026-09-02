export interface BookMetadata {
  coverUrl: string;
  publisher: string;
  publishedDate: string;
  subjects: string[];
  fiction: boolean | null;
  // ISO 639 code ('' unknown): a copy of the linked edition's effective
  // language, or what a lookup found (shared/language.ts).
  language: string;
}

export interface BookLookupResult extends BookMetadata {
  title: string;
  authorNames: string[];
  pageCount: number | undefined;
}

export type BookMetadataPatch = Partial<BookMetadata>;
