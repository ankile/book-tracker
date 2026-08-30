import type { BookLookupResult, BookMetadata } from '../interfaces/metadata.ts';

// ISBN-derived book metadata: the field set, its empty defaults, and the
// parser for Open Library `api/books?jscmd=data` records. Shared by the
// add/edit modal's Look up button and migrate-enrich-books.ts so the two
// write identical shapes. The fields are advisory display data. Rules
// allowlist and validate them, but authorization must never trust catalog
// metadata to describe an owner's permissions.
//
// Defaults follow the normalize convention: always present, empty when
// unknown. `fiction: null` is the explicit unknown — Open Library subjects
// don't always answer the question.
export const EMPTY_METADATA: BookMetadata = {
  coverUrl: "",
  publisher: "",
  publishedDate: "",
  subjects: [],
  fiction: null,
};

export const METADATA_FIELDS = [
  'coverUrl', 'publisher', 'publishedDate', 'subjects', 'fiction',
] as const satisfies readonly (keyof BookMetadata)[];

const MAX_SUBJECTS = 25;
const GENERIC_SUBJECTS = new Set([
  'fiction',
  'fiction, general',
  'general fiction',
  'nonfiction',
  'non-fiction',
  'non fiction',
]);

// Returns { title, authorNames, pageCount, ...metadata fields }. The first
// three are lookup conveniences for the modal; the migration reads only the
// metadata fields (title/pageCount are user-owned on existing books).
// coverUrl stores the -M size; -S/-L are the same URL with the suffix
// swapped, so one stored URL serves every display size.
export interface OpenLibraryBookRecord {
  title?: string;
  authors?: { name: string }[];
  number_of_pages?: number;
  cover?: { small?: string; medium?: string; large?: string };
  publishers?: { name: string }[];
  publish_date?: string;
  subjects?: { name: string }[];
}

type Data = Record<string, unknown>;

function isRecord(value: unknown): value is Data {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, source: string): Data {
  if (!isRecord(value)) {
    throw new TypeError(`${source} must be an object.`);
  }
  return value;
}

function optionalRecord(value: unknown): Data | undefined {
  return isRecord(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalPageCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function namedEntries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const data = optionalRecord(entry);
    const name = optionalString(data?.name);
    return name === undefined ? [] : [name];
  });
}

export function parseOpenLibraryBook(value: unknown): BookLookupResult {
  const record = requireRecord(value, 'Open Library book record');
  const subjects = cleanSubjects(record.subjects);
  const cover = optionalRecord(record.cover);
  const publisher = namedEntries(record.publishers)[0];
  return {
    title: optionalString(record.title) ?? "",
    authorNames: namedEntries(record.authors),
    pageCount: optionalPageCount(record.number_of_pages),
    coverUrl: optionalString(cover?.medium) ?? "",
    publisher: publisher ?? "",
    publishedDate: optionalString(record.publish_date) ?? "",
    subjects,
    fiction: deriveFiction(subjects),
  };
}

// Open Library subjects mix useful detail with catalog noise. Feed tags like
// "nyt:combined-print-and-e-book-fiction=2018-04-29" carry ':' or '=' and
// are dropped. Generic classification labels are also dropped because they
// add no subject detail and are unreliable enough to misclassify nonfiction.
function cleanSubjects(subjects: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawName of namedEntries(subjects)) {
    const name = rawName.trim();
    if (name === "" || name.includes(":") || name.includes("=")) continue;
    const key = name.toLowerCase();
    if (GENERIC_SUBJECTS.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length === MAX_SUBJECTS) break;
  }
  return out;
}

// Source quality differs by field. Google Books is the most consistent cover
// and fiction classifier. Open Library has the richer subject vocabulary and
// remains the first choice for publisher and publication date. The national
// library fills any remaining gaps and has a stronger classification signal
// than Open Library's free-form subjects.
export function selectLookupMetadata(
  openLibrary: BookMetadata | null,
  google: BookMetadata | null,
  nationalLibrary: BookMetadata | null,
): BookMetadata {
  return {
    coverUrl: firstText([
      google?.coverUrl,
      openLibrary?.coverUrl,
      nationalLibrary?.coverUrl,
    ]),
    publisher: firstText([
      openLibrary?.publisher,
      google?.publisher,
      nationalLibrary?.publisher,
    ]),
    publishedDate: firstText([
      openLibrary?.publishedDate,
      google?.publishedDate,
      nationalLibrary?.publishedDate,
    ]),
    subjects: firstItems([
      openLibrary?.subjects,
      google?.subjects,
      nationalLibrary?.subjects,
    ]),
    fiction: firstClassification([
      google?.fiction,
      nationalLibrary?.fiction,
      openLibrary?.fiction,
    ]),
  };
}

function firstText(values: readonly (string | undefined)[]): string {
  return values.find((value) => value !== undefined && value.trim() !== '') ?? '';
}

function firstItems(values: readonly (string[] | undefined)[]): string[] {
  return values.find((value) => value !== undefined && value.length > 0) ?? [];
}

function firstClassification(
  values: readonly (boolean | null | undefined)[],
): boolean | null {
  return values.find((value) => value !== undefined && value !== null) ?? null;
}

// Heuristic: a subject saying nonfiction classifies that subject, a subject
// saying fiction classifies the book. Books occasionally carry both (e.g. a
// stray "Juvenile Nonfiction" tag on a novel), so a fiction match wins;
// nonfiction-only means false; neither means unknown (null).
export function deriveFiction(subjectNames: readonly string[]): boolean | null {
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
