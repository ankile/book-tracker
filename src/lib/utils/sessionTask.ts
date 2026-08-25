export async function runRetryableSessionTask<Key>(
  completed: Set<Key>,
  key: Key,
  task: () => Promise<boolean>,
): Promise<void> {
  if (completed.has(key)) return;
  completed.add(key);
  const complete = await Promise.resolve().then(task).catch((error: unknown) => {
    completed.delete(key);
    throw error;
  });
  if (!complete) completed.delete(key);
}
