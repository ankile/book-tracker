// The reads are judged through this structural slice of a snapshot so the
// predicates take a transaction read, a plain read, or a test stub alike.
export interface ConsentSnapshot {
  readonly exists: boolean;
  get(_field: string): unknown;
}

// Sharing is on by default (owner decision 2026-09-01): every live
// account's linked books feed the reader list of a work unless the account
// opted out. Both readers of that consent — the projection triggers in
// catalogProjection.ts and the work-reader callable in catalog.ts — answer
// it from the same two documents, the account and its
// users/{uid}/settings/bookSharing setting, through this one predicate.
//
// The setting document records only the opt-out and the reader's time
// zone: absent means on, with day boundaries taken in UTC until the client
// stores one. A setting whose `enabled` is anything but `true` is an
// opt-out, so a malformed document can never share more than an absent
// one would. Who the reader is shown as is a separate question
// (readerIdentity below): a public profile names them, otherwise they are
// anonymous.

export const SHARING_USERNAME = /^[a-z0-9-]{3,30}$/;

export const DEFAULT_TIME_ZONE = "UTC";

// Constructing a formatter is the validator, not supportedValuesOf(): the
// list omits aliases browsers report verbatim (Asia/Kolkata), while the
// constructor accepts exactly what dayParts() can later format. The catch
// is the only way Intl reports an unknown zone.
export function validTimeZone(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", {timeZone: value}).format();
    return true;
  } catch {
    return false;
  }
}

export interface SharingConsent {
  timeZone: string;
}

export function sharingConsent(
  user: ConsentSnapshot,
  setting: ConsentSnapshot,
): SharingConsent | null {
  if (!user.exists || user.get("deletedAt") !== undefined) return null;
  if (!setting.exists) return {timeZone: DEFAULT_TIME_ZONE};
  if (setting.get("enabled") !== true) return null;
  const timeZone = setting.get("timeZone");
  return {timeZone: validTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE};
}

export interface ReaderIdentity {
  username: string;
  displayName: string;
}

// The profile profileOwners/{uid} names is the reader's public face only
// while it is still this account's, public, not tombstoned, and carries a
// name to show. Anything else is null: the reader is listed anonymously,
// never hidden — consent and identity are separate questions.
export function readerIdentity(
  profile: ConsentSnapshot,
  uid: string,
  username: unknown,
): ReaderIdentity | null {
  if (typeof username !== "string" || !SHARING_USERNAME.test(username)) return null;
  if (!profile.exists || profile.get("uid") !== uid || profile.get("public") !== true ||
      profile.get("deletedAt") !== undefined) return null;
  const givenName = profile.get("givenName");
  const familyName = profile.get("familyName");
  if (typeof givenName !== "string" || typeof familyName !== "string") return null;
  const displayName = `${givenName} ${familyName}`.trim();
  return displayName === "" ? null : {username, displayName};
}
