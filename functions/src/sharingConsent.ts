// The three reads are judged through this structural slice of a snapshot
// so the predicates take a transaction read, a plain read, or a test stub
// alike.
export interface ConsentSnapshot {
  readonly exists: boolean;
  get(_field: string): unknown;
}

// Every reader of a user's sharing consent — the projection triggers, the
// work-reader callable and the admin promotion check — answers the same
// question from the same three documents: a live account, a well-formed
// setting, and a public profile that still belongs to that account. One
// predicate keeps them from drifting (review: six hand-written copies, one
// of which validated the time zone with Intl.supportedValuesOf and so
// silently hid every reader in Asia/Kolkata, Europe/Kyiv or Etc/UTC).

const SHARING_USERNAME = /^[a-z0-9-]{3,30}$/;

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

export interface SharingSetting {
  username: string;
  timeZone: string;
}

// Phase one: the account and its setting. null on any disagreement. The
// profile named here is read by the caller (it may need a transaction) and
// judged by profileConsents.
export function sharingSetting(
  user: ConsentSnapshot,
  setting: ConsentSnapshot,
): SharingSetting | null {
  if (!user.exists || user.get("deletedAt") !== undefined || !setting.exists) return null;
  const username = setting.get("profileUsername");
  const timeZone = setting.get("timeZone");
  if (typeof username !== "string" || !SHARING_USERNAME.test(username) ||
      !validTimeZone(timeZone)) return null;
  return {username, timeZone};
}

// Phase two: the named profile is still this account's and public. A
// renamed, privatised or tombstoned profile withdraws consent even while
// the setting document lingers.
export function profileConsents(profile: ConsentSnapshot, uid: string): boolean {
  return profile.exists && profile.get("uid") === uid &&
    profile.get("public") === true && profile.get("deletedAt") === undefined;
}
