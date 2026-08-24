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
  retirement?: AuthorRetirement;
}

export function selectableAuthors<T extends ResolvableAuthor>(authors: readonly T[]): T[] {
  return authors.filter((author) => author.retirement === undefined);
}

export function resolveAuthorRedirect(
  author: Author,
  authorMap: ReadonlyMap<string, Author>,
): Author {
  let current = author;
  const visited = new Set<string>();
  while (current.retirement?.reason === 'merged') {
    if (visited.has(current.id)) throw new Error(`Cyclic author merge at ${current.id}`);
    visited.add(current.id);
    const target = authorMap.get(current.retirement.targetId);
    if (target === undefined) {
      throw new Error(`Merged author ${current.id} has missing target ${current.retirement.targetId}`);
    }
    current = target;
  }
  return current;
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
  const normalized = name.trim().replace(/\s+/g, ' ');
  const lower = normalized.toLowerCase();
  const byName = authors.find((a) => a.nameLower === lower);
  const byId = authors.find((a) => a.id === authorIdFor(normalized));
  const existing = byName ?? byId;
  if (existing) {
    const byAuthorId = new Map(authors.map((author) => [author.id, author]));
    let current = existing;
    const visited = new Set<string>();
    while (current.retirement?.reason === 'merged') {
      if (visited.has(current.id)) throw new Error(`Cyclic author merge at ${current.id}`);
      visited.add(current.id);
      const target = byAuthorId.get(current.retirement.targetId);
      if (target === undefined) {
        throw new Error(`Merged author ${current.id} has missing target ${current.retirement.targetId}`);
      }
      current = target;
    }
    if (current.retirement?.reason !== 'deleted') {
      return { id: current.id, name: current.name };
    }
  }
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
