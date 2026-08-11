// A users/{uid}/authors doc. The id is deterministic (authorIdFor) at
// creation only and opaque afterward — rename edits name/nameLower in
// place, so id need not match the current name.
export type AuthorKind = 'person' | 'entity' | 'placeholder';

export interface Author {
  id: string;
  name: string;
  nameLower: string;
  kind: AuthorKind;
  // Abbreviation/sort override for names the last-token rule mangles
  // ("Ursula K. Le Guin" → "Le Guin"). Absent means derive from kind.
  sortName?: string;
}
