// A users/{uid}/authors doc. The id is deterministic (authorIdFor) at
// creation only and opaque afterward — rename edits the name fields in
// place, so id need not match the current name.
export type AuthorKind = 'person' | 'entity' | 'placeholder';

export interface Author {
  id: string;
  // For persons, always the stored join of the parts (audited):
  // `${givenName} ${familyName}` or just familyName for mononyms.
  name: string;
  nameLower: string;
  kind: AuthorKind;
  // Person-only explicit name parts; abbreviation and sorting read
  // familyName directly (no splitting heuristic at render time).
  // givenName is absent for mononyms; both absent on non-person kinds.
  givenName?: string;
  familyName?: string;
}
