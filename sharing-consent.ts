// Sharing consent, as the deployed backend judges it. The migration
// (migrate-cross-user-works.ts) and the audit (db-audit.ts) must agree with
// functions/src/sharingConsent.ts to the letter: a projection row this file
// admits and the backend's triggers refuse is a reader list that never
// converges, and one the backend writes and the audit refuses is a false
// drift report on every run.
//
// Consent governs only the reader projections (sharedWorkOwners) and the
// public profile. Catalog documents — authors, works, editions and their
// indexes — are public bibliographic data whoever contributed them, so
// nothing here gates their creation.
//
// This is the Admin-SDK side of the same predicate, so it reads plain
// document data rather than snapshots: an absent document is `undefined`,
// which is what `!snapshot.exists` means there.

export type ConsentDoc = Record<string, unknown>;

export const SHARING_USERNAME = /^[a-z0-9-]{3,30}$/;

// The keys a bookSharing setting document may carry. The backend does not
// check them (an extra key cannot forge consent), so this is an audit-only
// shape assertion, not part of the predicate below.
export const SHARING_SETTING_KEYS = [
  'createdAt', 'profileUsername', 'timeZone', 'updatedAt',
] as const;

// Constructing a formatter is the validator, not Intl.supportedValuesOf():
// the list omits aliases browsers report verbatim (Asia/Kolkata), while the
// constructor accepts exactly what the day-bucketing code can later format.
export function validTimeZone(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', {timeZone: value}).format();
    return true;
  } catch {
    return false;
  }
}

export interface SharingSetting {
  username: string;
  timeZone: string;
}

// Phase one: a live account and a well-formed setting. null on any
// disagreement; the profile it names is read by the caller (the migration
// needs it inside a transaction) and judged by profileConsents.
export function sharingSetting(
  user: ConsentDoc | undefined,
  setting: ConsentDoc | undefined,
): SharingSetting | null {
  if (user === undefined || user.deletedAt !== undefined || setting === undefined) return null;
  const username = setting.profileUsername;
  const timeZone = setting.timeZone;
  if (typeof username !== 'string' || !SHARING_USERNAME.test(username) ||
      !validTimeZone(timeZone)) return null;
  return {username, timeZone};
}

// Phase two: the named profile is still this account's and public. A
// renamed, privatised or tombstoned profile withdraws consent even while
// the setting document lingers.
export function profileConsents(profile: ConsentDoc | undefined, uid: string): boolean {
  return profile !== undefined && profile.uid === uid &&
    profile.public === true && profile.deletedAt === undefined;
}

export function sharingConsentIsValid(
  uid: string,
  user: ConsentDoc | undefined,
  setting: ConsentDoc | undefined,
  profile: ConsentDoc | undefined,
): boolean {
  return sharingSetting(user, setting) !== null && profileConsents(profile, uid);
}
