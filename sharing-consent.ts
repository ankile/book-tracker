// Sharing consent, as the deployed backend judges it. The migration
// (migrate-cross-user-works.ts) and the audit (db-audit.ts) must agree with
// functions/src/sharingConsent.ts to the letter: a projection row this file
// admits and the backend's triggers refuse is a reader list that never
// converges, and one the backend writes and the audit refuses is a false
// drift report on every run.
//
// Sharing is on by default (owner decision 2026-09-01): every live
// account's linked books feed the reader list unless the account opted
// out. The users/{uid}/settings/bookSharing document records only that
// opt-out and the reader's time zone; absent means on, in UTC. A setting
// whose `enabled` is anything but `true` is an opt-out, so a malformed
// document never shares more than an absent one. Who the reader is shown
// as (a public profile, or anonymous) is not consent and is not judged
// here.
//
// Consent governs only the reader projections (sharedWorkOwners). Catalog
// documents — authors, works, editions and their indexes — are public
// bibliographic data whoever contributed them, so nothing here gates their
// creation.
//
// This is the Admin-SDK side of the same predicate, so it reads plain
// document data rather than snapshots: an absent document is `undefined`,
// which is what `!snapshot.exists` means there.

export type ConsentDoc = Record<string, unknown>;

export const DEFAULT_TIME_ZONE = 'UTC';

// The keys a bookSharing setting document may carry. The backend does not
// check them (an extra key cannot forge consent), so this is an audit-only
// shape assertion, not part of the predicate below.
export const SHARING_SETTING_KEYS = ['createdAt', 'enabled', 'timeZone', 'updatedAt'] as const;

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

export interface SharingConsent {
  timeZone: string;
}

export function sharingConsent(
  user: ConsentDoc | undefined,
  setting: ConsentDoc | undefined,
): SharingConsent | null {
  if (user === undefined || user.deletedAt !== undefined) return null;
  if (setting === undefined) return {timeZone: DEFAULT_TIME_ZONE};
  if (setting.enabled !== true) return null;
  return {timeZone: validTimeZone(setting.timeZone) ? setting.timeZone : DEFAULT_TIME_ZONE};
}

export function sharingConsentIsValid(
  user: ConsentDoc | undefined,
  setting: ConsentDoc | undefined,
): boolean {
  return sharingConsent(user, setting) !== null;
}
