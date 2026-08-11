// Author name handling, shared verbatim between the client (db.js,
// AuthorInput, BookList) and the migration/audit scripts — plain module
// with no Firebase imports so Node can load it directly.

// Deterministic author doc id from a display name, so offline merge-set
// upserts converge on one doc per author with no prior read. '/' would
// read as a path separator in a document id.
export function authorIdFor(name) {
  return name.trim().replace(/\s+/g, ' ').toLowerCase().replaceAll('/', '_');
}

// Placeholder attributions ("Various Authors" on the Bible) are display
// text, not people: splitAuthors drops them so no author entity is ever
// created, and the book keeps the raw string with authors: [].
const PLACEHOLDERS = new Set(['various', 'various authors', 'unknown', 'unknown author']);
export function isPlaceholderAuthor(name) {
  return PLACEHOLDERS.has(authorIdFor(name));
}

// One input field holds all authors: split on commas and ampersands, never
// on the word "and" inside a name — but a segment LEADING with "and" is an
// Oxford-comma conjunction ("Dawkins, Dennett, Harris, and Hitchens"), not
// part of the name. Dedupe by id so "Tolkien, tolkien" is one author.
export function splitAuthors(text) {
  const seen = new Set();
  const names = [];
  for (const piece of text.split(/[,&]/)) {
    const name = piece.replace(/^\s*and\s+/i, '').trim().replace(/\s+/g, ' ');
    if (name === '' || isPlaceholderAuthor(name)) continue;
    const id = authorIdFor(name);
    if (seen.has(id)) continue;
    seen.add(id);
    names.push(name);
  }
  return names;
}

// The canonical legacy `author` string kept on every book: /finished
// search, stats, and old clients all keep reading it.
export function joinAuthors(names) {
  return names.join(', ');
}

// Presentation-only: never stored.
export function lastNameOf(name) {
  const tokens = name.trim().split(/\s+/);
  return tokens[tokens.length - 1];
}

// Compact list display: a lone author keeps their full name ("J. R. R.
// Tolkien"); only multi-author lists abbreviate to last names ("Kahneman
// & Tversky", "Kahneman et al.") — full names belong in the tooltip.
export function formatAuthors(authors) {
  if (authors.length === 0) return '';
  if (authors.length === 1) return authors[0].name;
  const names = authors.map((author) => lastNameOf(author.name));
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names[0]} et al.`;
}
