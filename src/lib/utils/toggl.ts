export function togglQueueId(bookId: string, start: string): string {
  return `${bookId}_${start}`;
}

export function parseTogglReportedIds(value: string | null): string[] {
  if (value === null) return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    // localStorage is cosmetic dedup state. Invalid JSON must not stop the
    // durable Firestore recovery sweep, and the next write repairs it.
    return [];
  }
  if (!Array.isArray(decoded) || !decoded.every((id) => typeof id === 'string')) {
    return [];
  }
  return decoded;
}

interface TogglReportStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readTogglReportedIds(storage: TogglReportStorage, key: string): string[] {
  try {
    return parseTogglReportedIds(storage.getItem(key));
  } catch {
    // Private-mode/quota storage failures are cosmetic and must not block
    // the Firestore recovery path.
    return [];
  }
}

export function writeTogglReportedIds(
  storage: TogglReportStorage,
  key: string,
  ids: readonly string[],
): void {
  try {
    storage.setItem(key, JSON.stringify(ids));
  } catch {
    // The next session may repeat a warning, but recovery still proceeds.
  }
}

export function isTogglSweepTransactionCandidate(item: {
  status: string;
  attempts: number;
}): boolean {
  return item.status !== 'outcome-unknown' && item.attempts < 5;
}
