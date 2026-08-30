// The client projection of a shared catalogAuthors/{authorId} document.
export type AuthorKind = 'person' | 'entity' | 'placeholder';

export type AuthorRetirement =
  | { reason: 'deleted' }
  | { reason: 'merged'; targetId: string };

interface AuthorBase {
  id: string;
  name: string;
  nameLower: string;
  alternateNames?: string[];
  sortName?: string;
  retirement?: AuthorRetirement;
}

export interface PersonAuthor extends AuthorBase {
  kind: 'person';
  givenName?: string;
  familyName: string;
}

export interface NonPersonAuthor extends AuthorBase {
  kind: 'entity' | 'placeholder';
  givenName?: never;
  familyName?: never;
}

export type Author = PersonAuthor | NonPersonAuthor;

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
