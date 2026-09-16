// The network steps that turn a book form's draft into something the
// personal-book rules admit: new authors become shared catalog authors, a
// chosen work without a matching edition gets this book's edition, and a
// book that matched nothing seeds a shared work (catalog data is public,
// owner decision 2026-08-31). Shared by the add/edit book modal and the
// to-read planner's add flow, so the planner does not copy the sequence.
// The services are injected: tests run it without Firebase.
import type { AuthorChip } from '../interfaces/author.ts';
import type {
  CatalogAddEditionRequest,
  CatalogAddEditionResponse,
  CatalogCreateRequest,
  CatalogCreateResponse,
  CatalogSelection,
} from '../interfaces/catalog.ts';
import type { BookMetadata } from '../interfaces/metadata.ts';
import { buildCatalogAddEditionRequest, buildCatalogCreateRequest } from './catalogClient.ts';

export interface BookDraft {
  online: boolean;
  authorChips: AuthorChip[];
  catalogSelection: CatalogSelection | null;
  // The chosen work's default language, for the edition override.
  selectedWorkLanguage: string;
  // The reader explicitly chose or removed a link; never seed a work then.
  catalogChoiceTouched: boolean;
  title: string;
  isbn: string;
  // null for a planned book without a length: the catalog steps that need
  // an edition are skipped and the link stays as chosen.
  pageCount: number | null;
  metadata: BookMetadata;
}

export interface BookDraftServices {
  resolveAuthors(chips: AuthorChip[]): Promise<AuthorChip[]>;
  addEdition(request: CatalogAddEditionRequest): Promise<CatalogAddEditionResponse>;
  createWork(request: CatalogCreateRequest): Promise<CatalogCreateResponse>;
}

export type BookDraftPhase = 'authors' | 'catalog' | null;

export type BookDraftCompletion =
  | {
    ok: true;
    authorChips: AuthorChip[];
    catalogSelection: CatalogSelection | null;
    catalogChoiceTouched: boolean;
  }
  | { ok: false; message: string };

export async function completeBookDraft(
  draft: BookDraft,
  services: BookDraftServices,
  onPhase: (phase: BookDraftPhase) => void = () => {},
): Promise<BookDraftCompletion> {
  let { authorChips, catalogSelection, catalogChoiceTouched } = draft;
  try {
    if (authorChips.some((chip) => chip.id === null)) {
      if (!draft.online) {
        return { ok: false, message: 'Connect to create a new shared author, then try again.' };
      }
      onPhase('authors');
      try {
        authorChips = await services.resolveAuthors(authorChips);
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : 'Could not create the shared author. Try again.',
        };
      }
    }
    // A chosen work without a matching edition gets this book's edition
    // added to it, so every linked book stands on an edition (owner
    // decision 2026-09-01). Needs the network and a page count.
    if (catalogSelection !== null && catalogSelection.editionId === null && draft.pageCount !== null) {
      if (!draft.online) {
        return { ok: false, message: 'Connect to add your edition to the shared work, then try again.' };
      }
      onPhase('catalog');
      const request = buildCatalogAddEditionRequest({
        workId: catalogSelection.workId,
        workLanguage: draft.selectedWorkLanguage,
        title: draft.title,
        isbn: draft.isbn,
        pageCount: draft.pageCount,
        metadata: draft.metadata,
      });
      try {
        const added = await services.addEdition(request);
        catalogSelection = { workId: added.workId, editionId: added.editionId, matchMethod: 'catalog-choice' };
        catalogChoiceTouched = true;
      } catch (error) {
        console.error('Catalog edition creation failed', error);
        return {
          ok: false,
          message: 'Could not add your edition to the shared work. Try again, or remove the link to save the book unlinked.',
        };
      }
    }
    // A book that matched nothing and that the reader did not explicitly
    // save unlinked seeds the shared catalog itself. Offline it stays
    // unlinked, as the panel says.
    if (catalogSelection === null && !catalogChoiceTouched && draft.online && draft.pageCount !== null) {
      const request = buildCatalogCreateRequest({
        title: draft.title,
        authorIds: authorChips.flatMap((chip) => (chip.id === null ? [] : [chip.id])),
        isbn: draft.isbn,
        pageCount: draft.pageCount,
        metadata: draft.metadata,
      });
      if (request !== null) {
        onPhase('catalog');
        try {
          const created = await services.createWork(request);
          catalogSelection = { workId: created.workId, editionId: created.editionId, matchMethod: 'catalog-choice' };
          catalogChoiceTouched = true;
        } catch (error) {
          console.error('Catalog creation failed', error);
          return {
            ok: false,
            message: 'Could not create the shared work. Try again, or remove the link to save the book unlinked.',
          };
        }
      }
    }
    return { ok: true, authorChips, catalogSelection, catalogChoiceTouched };
  } finally {
    onPhase(null);
  }
}
