// The client projection of a shared catalogAuthors/{authorId} document.
export type AuthorKind = 'person' | 'entity' | 'placeholder';

export type AuthorRetirement =
  | { reason: 'deleted' }
  | { reason: 'merged'; targetId: string };

interface AuthorBase {
  id: string;
  name: string;
  nameLower: string;
  alternateNames: string[];
  sortName: string;
  retirement?: AuthorRetirement;
}

// A person's sortName is the family name; other kinds sort by their full name.
export interface Author extends AuthorBase {
  kind: AuthorKind;
}

export interface AuthorSummary {
  id: string;
  name: string;
}

export type LegacyEmbeddedAuthor = AuthorSummary;

export type ExistingAuthorChip = AuthorSummary;

export interface UnresolvedAuthorChip extends AuthorSummary {
  unresolved: true;
}

export interface NewPersonAuthorChip {
  id: null;
  name: string;
  kind: 'person';
  givenName: string;
  familyName: string;
}

export interface NewNonPersonAuthorChip {
  id: null;
  name: string;
  kind: 'entity' | 'placeholder';
  givenName?: never;
  familyName?: never;
}

export type AuthorChip = ExistingAuthorChip | UnresolvedAuthorChip | NewPersonAuthorChip | NewNonPersonAuthorChip;
