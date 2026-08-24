// A users/{uid}/authors doc. The id is deterministic (authorIdFor) at
// creation only and opaque afterward — rename edits the name fields in
// place, so id need not match the current name.
export type AuthorKind = 'person' | 'entity' | 'placeholder';

export type AuthorRetirement =
  | { reason: 'deleted' }
  | { reason: 'merged'; targetId: string };

interface AuthorBase {
  id: string;
  name: string;
  nameLower: string;
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

export type AuthorChip = ExistingAuthorChip | NewPersonAuthorChip | NewNonPersonAuthorChip;
