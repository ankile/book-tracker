export function togglQueueId(bookId: string, start: string): string {
  return `${bookId}_${start}`;
}
