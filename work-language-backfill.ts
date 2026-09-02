// Planner for migrate-work-languages.ts: a default language for every work
// that has none, and the carried copy on every personal book that has none.
//
// A work's language is what its editions are in unless one overrides it
// (owner decision 2026-09-02). Works predating the field are inferred from
// their active editions' evidence, an edition's override or else its ISBN
// registration group (shared/language.ts): one language they all agree on,
// else unknown ('') and listed for review. Books carry the effective language of the
// edition they stand on (override, else the work's default), resolved one
// hop through merged aliases; an unlinked book has none. Idempotent: a work
// that carries the field and a book that carries a language, or carries ''
// where nothing better is known, are left alone. Pure and deterministic.
import { effectiveLanguage, languageForIsbn } from './shared/language.ts';

type Doc = Record<string, unknown>;

export interface LanguageBook {
  uid: string;
  bookId: string;
  data: Doc;
}

export interface LanguageInput {
  works: ReadonlyMap<string, Doc>;
  editions: ReadonlyMap<string, Doc>;
  books: readonly LanguageBook[];
}

export type LanguageSource = 'editions' | 'isbn-group' | 'none';

export interface PlannedWorkLanguage {
  id: string;
  language: string;
  source: LanguageSource;
}

export interface PlannedBookLanguage {
  uid: string;
  bookId: string;
  language: string;
}

export interface LanguagePlan {
  works: PlannedWorkLanguage[];
  books: PlannedBookLanguage[];
  review: Array<{id: string; reason: string}>;
}

function text(value: unknown, label: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function inferWorkLanguage(
  id: string,
  editions: ReadonlyMap<string, Doc>,
): {language: string; source: LanguageSource; reason: string | null} {
  // Each active edition is one piece of evidence: its override where it
  // has one, else the language its ISBN's registration group implies. The
  // work takes a language only when every piece agrees; an override beside
  // an ISBN that says otherwise is exactly the case where an operator
  // knows better than a rule.
  const active = [...editions].filter(([, edition]) =>
    edition.workId === id && edition.status !== 'merged');
  const evidence = new Set<string>();
  let fromOverride = false;
  let anyIsbn = false;
  for (const [editionId, edition] of active) {
    const override = text(edition.language, `editions/${editionId}.language`);
    const isbn13 = text(edition.isbn13, `editions/${editionId}.isbn13`);
    if (isbn13 !== '') anyIsbn = true;
    if (override !== '') {
      evidence.add(override);
      fromOverride = true;
    } else if (isbn13 !== '') {
      const group = languageForIsbn(isbn13);
      if (group !== '') evidence.add(group);
    }
  }
  if (evidence.size === 1) {
    return {language: [...evidence][0], source: fromOverride ? 'editions' : 'isbn-group', reason: null};
  }
  if (evidence.size > 1) {
    return {language: '', source: 'none', reason: `evidence disagrees (${[...evidence].sort().join(', ')})`};
  }
  return {language: '', source: 'none', reason: anyIsbn ? 'ISBN group unknown' : 'no ISBN'};
}

export function planWorkLanguages({works, editions, books}: LanguageInput): LanguagePlan {
  const plannedWorks: PlannedWorkLanguage[] = [];
  const review: Array<{id: string; reason: string}> = [];
  const languageOf = new Map<string, string>();
  for (const id of [...works.keys()].sort()) {
    const work = works.get(id)!;
    if (work.language !== undefined) {
      languageOf.set(id, text(work.language, `works/${id}.language`));
      continue;
    }
    const inferred = inferWorkLanguage(id, editions);
    plannedWorks.push({id, language: inferred.language, source: inferred.source});
    languageOf.set(id, inferred.language);
    // Only a live work needs an operator's answer; aliases redirect and a
    // hidden work is out of the catalog.
    if (inferred.reason !== null && work.status === 'active') review.push({id, reason: inferred.reason});
  }

  const resolveWork = (id: string): string | null => {
    const work = works.get(id);
    if (work === undefined) return null;
    if (work.status !== 'merged') return id;
    return typeof work.mergedInto === 'string' && works.has(work.mergedInto) ? work.mergedInto : null;
  };
  const resolveEdition = (id: string): Doc | null => {
    const edition = editions.get(id);
    if (edition === undefined) return null;
    if (edition.status !== 'merged') return edition;
    return typeof edition.mergedInto === 'string' ? editions.get(edition.mergedInto) ?? null : null;
  };

  const plannedBooks: PlannedBookLanguage[] = [];
  const sorted = [...books].sort((left, right) =>
    `${left.uid}/${left.bookId}`.localeCompare(`${right.uid}/${right.bookId}`));
  for (const {uid, bookId, data} of sorted) {
    const label = `users/${uid}/books/${bookId}`;
    const current = data.language;
    if (current !== undefined && text(current, `${label}.language`) !== '') continue;
    let effective = '';
    if (typeof data.workId === 'string') {
      const workId = resolveWork(data.workId);
      const edition = typeof data.editionId === 'string' ? resolveEdition(data.editionId) : null;
      const override = edition === null ? '' : text(edition.language, `${label} edition.language`);
      effective = effectiveLanguage(override, workId === null ? '' : languageOf.get(workId) ?? '');
    }
    if (current === undefined || effective !== '') plannedBooks.push({uid, bookId, language: effective});
  }
  return {works: plannedWorks, books: plannedBooks, review};
}
