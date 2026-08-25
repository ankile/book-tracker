export interface ReportedWriteLatch {
  accepted: boolean;
}

// Preserve the distinction between failing to construct/enqueue a write and
// a returned write promise rejecting later. An async wrapper would collapse
// both into promise rejections, causing the UI to close a draft that never
// reached Firestore's local queue.
export function invokeReportedWrite(
  write: () => Promise<void>,
  onFailure: (error: unknown) => void,
): Promise<void> {
  let completion: Promise<void>;
  try {
    completion = write();
  } catch (error) {
    onFailure(error);
    throw error;
  }
  return completion.catch((error: unknown) => {
    onFailure(error);
    throw error;
  });
}

// Firestore applies writes to its persistent local queue before the returned
// promise settles. That promise may wait for a server acknowledgement until
// the device reconnects. Database's reportWriteFailures wrapper owns error
// reporting; this helper advances the UI after local acceptance, observes the
// eventual rejection, and prevents a second click from issuing another write.
// A synchronous setup failure means nothing entered the queue, so the latch
// remains open and the caller keeps the draft visible with inline feedback.
export function acceptReportedWrite(
  latch: ReportedWriteLatch,
  write: () => Promise<void>,
  onAccepted: () => void,
  onSynchronousError: (error: unknown) => void,
): Promise<void> | null {
  if (latch.accepted) return null;
  let completion: Promise<void>;
  try {
    completion = write();
  } catch (error) {
    onSynchronousError(error);
    return null;
  }
  latch.accepted = true;
  const handled = completion.catch(() => {});
  onAccepted();
  return handled;
}
