// Author name handling, shared verbatim between the client (db.ts,
// AuthorInput, BookList) and the migration/audit scripts — plain module
// with no Firebase imports so Node can load it directly.

// Deterministic author doc id from a display name — at creation time ONLY.
// Ids are opaque afterward: rename edits name/nameLower in place, so a
// doc's id need not match its current name, and nothing may assert
// id === authorIdFor(name) against a live author doc. '/' would read as a
// path separator in a document id.
import type {
  Author,
  AuthorChip,
  AuthorKind,
  AuthorRetirement,
  LegacyEmbeddedAuthor,
} from '../interfaces/author.ts';

export interface PersonNameParts {
  givenName: string;
  familyName: string;
}

export interface DisplayAuthor {
  id?: string;
  name: string;
  kind?: AuthorKind;
  givenName?: string;
  familyName?: string;
}

export interface ResolvableAuthor {
  id: string;
  name: string;
  nameLower: string;
  alternateNames?: readonly string[];
  retirement?: AuthorRetirement;
}

export interface UnresolvedAuthorReference {
  id: string;
  problem: string;
}

export interface EditableAuthorChips {
  chips: AuthorChip[];
  unresolved: UnresolvedAuthorReference[];
}

export function selectableAuthors<T extends ResolvableAuthor>(authors: readonly T[]): T[] {
  return authors.filter((author) => author.retirement === undefined);
}

type AuthorRedirectResult<T extends ResolvableAuthor> =
  | { ok: true; author: T }
  | { ok: false; problem: string };

function inspectAuthorRedirect<T extends ResolvableAuthor>(
  author: T,
  authorMap: ReadonlyMap<string, T>,
): AuthorRedirectResult<T> {
  let current = author;
  const visited = new Set<string>();
  while (current.retirement?.reason === 'merged') {
    if (visited.has(current.id)) {
      return { ok: false, problem: `Cyclic author merge at ${current.id}` };
    }
    visited.add(current.id);
    const target = authorMap.get(current.retirement.targetId);
    if (target === undefined) {
      return {
        ok: false,
        problem: `Merged author ${current.id} has missing target ${current.retirement.targetId}`,
      };
    }
    current = target;
  }
  return { ok: true, author: current };
}

export function resolveAuthorRedirect(
  author: Author,
  authorMap: ReadonlyMap<string, Author>,
): Author {
  const result = inspectAuthorRedirect(author, authorMap);
  if (!result.ok) throw new Error(result.problem);
  return result.author;
}

export function canonicalAuthorIds(
  ids: readonly string[],
  authorMap: ReadonlyMap<string, Author>,
): string[] {
  const canonical: string[] = [];
  for (const id of ids) {
    const author = authorMap.get(id);
    if (author === undefined) throw new Error(`Missing author document: ${id}`);
    const targetId = resolveAuthorRedirect(author, authorMap).id;
    if (!canonical.includes(targetId)) canonical.push(targetId);
  }
  return canonical;
}

// Read-only identity projection. Legacy fields remain authoritative, valid
// merge redirects canonicalize, and an unresolvable reference keeps its raw
// id. Keeping that id is important for book counts and aggregate analytics:
// a corrupt reference must not crash the page or make a referenced author
// look safe to delete. Mutation paths deliberately keep using the strict
// canonicalAuthorIds/editable-chip boundary instead.
export function effectiveBookAuthorIds(book: AuthorshipBookView): string[] {
  if (book.author !== undefined || book.authors !== undefined) {
    return (book.authors ?? []).map((author) => author.id);
  }
  if (book.authorIds === undefined) {
    throw new Error('Book has neither legacy authorship nor authorIds.');
  }
  return [...book.authorIds];
}

export function readableBookAuthorIds(
  book: AuthorshipBookView,
  authorMap: ReadonlyMap<string, Author>,
): string[] {
  const result: string[] = [];
  for (const id of effectiveBookAuthorIds(book)) {
    const source = authorMap.get(id);
    const resolution = source === undefined
      ? { ok: false as const }
      : inspectAuthorRedirect(source, authorMap);
    const readableId = resolution.ok ? resolution.author.id : id;
    if (!result.includes(readableId)) result.push(readableId);
  }
  return result;
}

export function bookAuthorReferenceCounts(
  books: readonly AuthorshipBookView[],
  authorMap: ReadonlyMap<string, Author>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const book of books) {
    for (const id of readableBookAuthorIds(book, authorMap)) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

export function booksReferencingAuthor<T extends AuthorshipBookView>(
  books: readonly T[],
  authorId: string,
  authorMap: ReadonlyMap<string, Author>,
): T[] {
  return books.filter((book) => readableBookAuthorIds(book, authorMap).includes(authorId));
}

// The regular join stays deliberately strict so corrupt authorship cannot be
// rendered as if it were valid. The edit modal is the repair boundary: it
// needs to open even when a referenced author is missing or has a broken
// redirect. Such references become visibly marked, removable chips and are
// reported separately so the caller can prevent them from being saved.
export function editableBookAuthorChips(
  book: AuthorshipBookView,
  authors: readonly Author[],
): EditableAuthorChips {
  const authorMap = new Map(authors.map((author) => [author.id, author]));
  const addedIds = new Set<string>();
  if (book.author !== undefined || book.authors !== undefined) {
    if (!Array.isArray(book.authors) || book.authors.length === 0) {
      const chips: AuthorChip[] = [];
      const unresolved: UnresolvedAuthorReference[] = [];
      for (const name of splitAuthors(book.author ?? '')) {
        const normalized = normalizeAuthorName(name);
        const existing = matchingAuthor(normalized, authors);
        if (existing === undefined) {
          chips.push(newPersonChip(normalized));
          continue;
        }
        const resolution = inspectAuthorRedirect(existing, authorMap);
        if (!resolution.ok) {
          if (addedIds.has(existing.id)) continue;
          addedIds.add(existing.id);
          chips.push({ id: existing.id, name: `[Unresolved author] ${existing.name}`, unresolved: true });
          unresolved.push({ id: existing.id, problem: resolution.problem });
        } else if (resolution.author.retirement?.reason === 'deleted') {
          chips.push(newPersonChip(normalized));
        } else {
          if (addedIds.has(resolution.author.id)) continue;
          addedIds.add(resolution.author.id);
          chips.push({ id: resolution.author.id, name: resolution.author.name });
        }
      }
      return { chips, unresolved };
    }
  }

  const embeddedNames = new Map((book.authors ?? []).map((author) => [author.id, author.name]));
  const ids = book.authors?.map((author) => author.id) ?? book.authorIds;
  if (ids === undefined) throw new Error('Book has neither legacy authorship nor authorIds.');

  const chips: AuthorChip[] = [];
  const unresolved: UnresolvedAuthorReference[] = [];

  for (const id of ids) {
    const source = authorMap.get(id);
    const resolution = source === undefined
      ? { ok: false as const, problem: `Missing author document: ${id}` }
      : inspectAuthorRedirect(source, authorMap);

    if (!resolution.ok) {
      if (addedIds.has(id)) continue;
      addedIds.add(id);
      const fallbackName = embeddedNames.get(id) ?? source?.name ?? id;
      chips.push({ id, name: `[Unresolved author] ${fallbackName}`, unresolved: true });
      unresolved.push({ id, problem: resolution.problem });
      continue;
    }

    if (addedIds.has(resolution.author.id)) continue;
    addedIds.add(resolution.author.id);
    chips.push({ id: resolution.author.id, name: resolution.author.name });
  }

  return { chips, unresolved };
}

// A row containing corrupt authorship must retain its Edit/Fix control so the
// tolerant modal above is reachable. Other consumers keep using bookAuthors,
// whose strict join continues to expose corruption immediately.
export function repairableBookAuthors(
  book: AuthorshipBookView,
  authorMap: ReadonlyMap<string, Author> | null,
): DisplayAuthor[] | null {
  if (
    (book.author !== undefined || book.authors !== undefined)
    && (!Array.isArray(book.authors) || book.authors.length === 0)
  ) {
    return splitAuthors(book.author ?? '').map((name) => ({ name }));
  }
  if (authorMap === null) return bookAuthors(book, null);
  const result = editableBookAuthorChips(book, [...authorMap.values()]);
  return result.chips.map((chip) => {
    if (chip.id === null) return { name: chip.name };
    if ('unresolved' in chip) {
      return { id: chip.id, name: chip.name, kind: 'placeholder' };
    }
    const author = authorMap.get(chip.id);
    if (author === undefined) throw new Error(`Missing repaired author document: ${chip.id}`);
    return author;
  });
}

interface AuthorshipBookView {
  authorIds?: readonly string[];
  author?: string;
  authors?: LegacyEmbeddedAuthor[];
}

export function authorIdFor(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase().replaceAll('/', '_');
}

// Every author doc stores an explicit kind — 'person' (has a last name to
// abbreviate to), 'entity' (corporate/collective, "Harvard Business
// Review"), or 'placeholder' ("Various Authors") — so non-person authors
// are modeled as data instead of hardcoded name sets.
export const AUTHOR_KINDS = ['person', 'entity', 'placeholder'] as const satisfies readonly AuthorKind[];

// Split a pasted or legacy author string into names: split on commas and
// ampersands, never on the word "and" inside a name — but a segment
// LEADING with "and" is an Oxford-comma conjunction ("Dawkins, Dennett,
// Harris, and Hitchens"), not part of the name. Dedupe by id so
// "Tolkien, tolkien" is one author.
export function splitAuthors(text: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const piece of text.split(/[,&]/)) {
    const name = piece.replace(/^\s*and\s+/i, '').trim().replace(/\s+/g, ' ');
    if (name === '') continue;
    const id = authorIdFor(name);
    if (seen.has(id)) continue;
    seen.add(id);
    names.push(name);
  }
  return names;
}

// Display join for tooltips and search; the inverse of splitAuthors.
export function joinAuthors(names: readonly string[]): string {
  return names.join(', ');
}

// Split a person's display name into explicit parts: last token is the
// family name, the rest the given name(s). This is only a PREFILL — the
// split is shown and editable wherever a new person is created, so "Le
// Guin"-style corrections happen at entry, and it runs nowhere at render
// time. Mononyms (Homer) are family-name-only.
export function splitPersonName(name: string): PersonNameParts {
  const tokens = name.trim().replace(/\s+/g, ' ').split(' ');
  return {
    givenName: tokens.slice(0, -1).join(' '),
    familyName: tokens[tokens.length - 1],
  };
}

// The stored display name derived from parts; for persons, name is always
// this join (audited), so the typed parts are the single source of truth.
export function joinPersonName({
  givenName,
  familyName,
}: { givenName?: string; familyName?: string }): string {
  return [givenName, familyName].filter(Boolean).join(' ');
}

// Resolve a typed name against the loaded author list into a chip:
// {id, name} for an existing author, or a new-person chip carrying the
// editable split parts (the id is minted at write time). The second,
// by-id pass is load-bearing: after a rename, authorIdFor(oldName) still
// equals the renamed doc's id, and without it a typed pre-rename name
// would mint a "new" author whose merge-set lands on the renamed doc and
// reverts the rename.
export function resolveChip(name: string, authors: readonly ResolvableAuthor[]): AuthorChip {
  const normalized = normalizeAuthorName(name);
  const existing = matchingAuthor(normalized, authors);
  if (existing) {
    const byAuthorId = new Map(authors.map((author) => [author.id, author]));
    const resolution = inspectAuthorRedirect(existing, byAuthorId);
    if (!resolution.ok) {
      return {
        id: existing.id,
        name: `[Unresolved author] ${existing.name}`,
        unresolved: true,
      };
    }
    const current = resolution.author;
    if (current.retirement?.reason !== 'deleted') {
      return { id: current.id, name: current.name };
    }
  }
  return newPersonChip(normalized);
}

function normalizeAuthorName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

function matchingAuthor<T extends ResolvableAuthor>(normalized: string, authors: readonly T[]): T | undefined {
  const lower = normalized.toLowerCase();
  const byName = authors.find((author) => author.nameLower === lower);
  const byAlternateName = authors.find((author) =>
    author.alternateNames?.some((name) => name.toLowerCase() === lower),
  );
  return byName ?? byAlternateName;
}

function newPersonChip(normalized: string): AuthorChip {
  return { id: null, name: normalized, kind: 'person', ...splitPersonName(normalized) };
}

// Legacy-wins resolution of a book's authorship. Legacy fields present
// means the last writer was a pre-authorIds client and any authorIds
// alongside them are stale, so legacy is the truth; otherwise authorIds
// resolve strictly against the loaded author map (a dangling id crashes —
// that is corrupt data, not a state to paper over). Returns null while
// the author store is still loading (authorMap === null) for books that
// need the join.
export function bookAuthors(
  book: AuthorshipBookView,
  authorMap: ReadonlyMap<string, Author> | null,
): DisplayAuthor[] | null {
  if (book.author !== undefined || book.authors !== undefined) {
    if (Array.isArray(book.authors) && book.authors.length > 0) {
      if (authorMap === null) return book.authors;
      return canonicalAuthorIds(book.authors.map((author) => author.id), authorMap).map((id) => {
        const author = authorMap.get(id);
        if (author === undefined) throw new Error(`Missing canonical author document: ${id}`);
        return author;
      });
    }
    return splitAuthors(book.author ?? '').map((name) => ({ name }));
  }
  if (authorMap === null) return null;
  if (book.authorIds === undefined) {
    throw new Error('Book has neither legacy authorship nor authorIds.');
  }
  return canonicalAuthorIds(book.authorIds, authorMap).map((id) => {
    const author = authorMap.get(id);
    if (author === undefined) throw new Error(`Missing canonical author document: ${id}`);
    return author;
  });
}

// Presentation-only: persons abbreviate to their explicit familyName —
// no heuristic runs here — and non-person kinds keep their full name.
// Legacy {id, name} entries embedded on unmigrated books carry neither
// kind nor parts; they get the last-token split until the straggler
// cleanup removes the legacy path.
export function abbreviatedName(author: DisplayAuthor): string {
  if (author.kind === undefined) return splitPersonName(author.name).familyName;
  if (author.kind !== 'person') return author.name.trim().replace(/\s+/g, ' ');
  if (!author.familyName) throw new Error(`Person author is missing familyName: ${author.name}`);
  return author.familyName;
}

// Compact list display: a lone author keeps their full name ("J. R. R.
// Tolkien"); only multi-author lists abbreviate ("Kahneman & Tversky",
// "Kahneman et al.") — full names belong in the tooltip.
export function formatAuthors(authors: readonly DisplayAuthor[]): string {
  if (authors.length === 0) return '';
  if (authors.length === 1) return authors[0].name;
  const names = authors.map(abbreviatedName);
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names[0]} et al.`;
}
