// Author name handling, shared verbatim between the client (db.js,
// AuthorInput, BookList) and the migration/audit scripts — plain module
// with no Firebase imports so Node can load it directly.

// Deterministic author doc id from a display name — at creation time ONLY.
// Ids are opaque afterward: rename edits name/nameLower in place, so a
// doc's id need not match its current name, and nothing may assert
// id === authorIdFor(name) against a live author doc. '/' would read as a
// path separator in a document id.
export function authorIdFor(name) {
  return name.trim().replace(/\s+/g, ' ').toLowerCase().replaceAll('/', '_');
}

// Every author doc stores an explicit kind — 'person' (has a last name to
// abbreviate to), 'entity' (corporate/collective, "Harvard Business
// Review"), or 'placeholder' ("Various Authors") — so non-person authors
// are modeled as data instead of hardcoded name sets.
export const AUTHOR_KINDS = ['person', 'entity', 'placeholder'];

// Split a pasted or legacy author string into names: split on commas and
// ampersands, never on the word "and" inside a name — but a segment
// LEADING with "and" is an Oxford-comma conjunction ("Dawkins, Dennett,
// Harris, and Hitchens"), not part of the name. Dedupe by id so
// "Tolkien, tolkien" is one author.
export function splitAuthors(text) {
  const seen = new Set();
  const names = [];
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
export function joinAuthors(names) {
  return names.join(', ');
}

// Resolve a typed name against the loaded author list into a chip:
// {id, name} for an existing author, {id: null, name} for a new one (the
// id is minted at write time). The second, by-id pass is load-bearing:
// after a rename, authorIdFor(oldName) still equals the renamed doc's id,
// and without it a typed pre-rename name would mint a "new" author whose
// merge-set lands on the renamed doc and reverts the rename.
export function resolveChip(name, authors) {
  const normalized = name.trim().replace(/\s+/g, ' ');
  const lower = normalized.toLowerCase();
  const byName = authors.find((a) => a.nameLower === lower);
  if (byName) return { id: byName.id, name: byName.name };
  const byId = authors.find((a) => a.id === authorIdFor(normalized));
  if (byId) return { id: byId.id, name: byId.name };
  return { id: null, name: normalized };
}

// Legacy-wins resolution of a book's authorship. Legacy fields present
// means the last writer was a pre-authorIds client and any authorIds
// alongside them are stale, so legacy is the truth; otherwise authorIds
// resolve strictly against the loaded author map (a dangling id crashes —
// that is corrupt data, not a state to paper over). Returns null while
// the author store is still loading (authorMap === null) for books that
// need the join.
export function bookAuthors(book, authorMap) {
  if (book.author !== undefined || book.authors !== undefined) {
    if (Array.isArray(book.authors) && book.authors.length > 0) return book.authors;
    return splitAuthors(book.author ?? '').map((name) => ({ name }));
  }
  if (authorMap === null) return null;
  return book.authorIds.map((id) => authorMap.get(id));
}

// Presentation-only: never stored. sortName is the per-author escape
// hatch for names the last-token rule mangles ("Le Guin" → "Guin");
// non-person kinds keep their full name. Legacy {id, name} entries
// embedded on unmigrated books carry no kind and are all persons.
export function abbreviatedName(author) {
  if (author.sortName) return author.sortName;
  const normalized = author.name.trim().replace(/\s+/g, ' ');
  if (author.kind !== undefined && author.kind !== 'person') return normalized;
  const tokens = normalized.split(' ');
  return tokens[tokens.length - 1];
}

// Compact list display: a lone author keeps their full name ("J. R. R.
// Tolkien"); only multi-author lists abbreviate ("Kahneman & Tversky",
// "Kahneman et al.") — full names belong in the tooltip.
export function formatAuthors(authors) {
  if (authors.length === 0) return '';
  if (authors.length === 1) return authors[0].name;
  const names = authors.map(abbreviatedName);
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names[0]} et al.`;
}
