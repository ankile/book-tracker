// ISBN-derived book metadata: the field set, its empty defaults, and the
// parser for Open Library `api/books?jscmd=data` records. Shared by the
// add/edit modal's Look up button and migrate-enrich-books.js so the two
// write identical shapes. The fields are advisory display data — owners
// have blanket write on book docs, so nothing may ever trust them.
//
// Defaults follow the normalize convention: always present, empty when
// unknown. `fiction: null` is the explicit unknown — Open Library subjects
// don't always answer the question.
export const EMPTY_METADATA = {
  coverUrl: "",
  publisher: "",
  publishedDate: "",
  subjects: [],
  fiction: null,
};

export const METADATA_FIELDS = Object.keys(EMPTY_METADATA);

const MAX_SUBJECTS = 25;

// Returns { title, authorNames, pageCount, ...metadata fields }. The first
// three are lookup conveniences for the modal; the migration reads only the
// metadata fields (title/pageCount are user-owned on existing books).
// coverUrl stores the -M size; -S/-L are the same URL with the suffix
// swapped, so one stored URL serves every display size.
export function parseOpenLibraryBook(record) {
  const subjects = cleanSubjects(record.subjects);
  return {
    title: record.title ?? "",
    authorNames: (record.authors ?? []).map((a) => a.name),
    pageCount: record.number_of_pages,
    coverUrl: record.cover?.medium ?? "",
    publisher: record.publishers?.[0]?.name ?? "",
    publishedDate: record.publish_date ?? "",
    subjects,
    fiction: deriveFiction(subjects),
  };
}

// Open Library subjects mix genres with catalog noise. Feed tags like
// "nyt:combined-print-and-e-book-fiction=2018-04-29" carry ':' or '=' and
// are dropped; the rest (including MARC composites like "Fiction, fantasy,
// historical") are kept verbatim — curation is a display concern.
function cleanSubjects(subjects) {
  const seen = new Set();
  const out = [];
  for (const subject of subjects ?? []) {
    const name = subject.name.trim();
    if (name === "" || name.includes(":") || name.includes("=")) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length === MAX_SUBJECTS) break;
  }
  return out;
}

// Heuristic: a subject saying nonfiction classifies that subject, a subject
// saying fiction classifies the book. Books occasionally carry both (e.g. a
// stray "Juvenile Nonfiction" tag on a novel), so a fiction match wins;
// nonfiction-only means false; neither means unknown (null).
export function deriveFiction(subjectNames) {
  let sawNonfiction = false;
  for (const name of subjectNames) {
    const lower = name.toLowerCase();
    if (lower.includes("nonfiction") || lower.includes("non-fiction")) {
      sawNonfiction = true;
    } else if (/\bfiction\b/.test(lower)) {
      return true;
    }
  }
  return sawNonfiction ? false : null;
}
