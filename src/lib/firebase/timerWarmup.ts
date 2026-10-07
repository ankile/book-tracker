import { timerAccept, timerContext } from './functions.ts';

// A cold timer callable adds about two seconds to a tap. Warming the
// callables while the reading list is visible moves that boot ahead of the
// reader's next action. An idle instance stays up for several minutes, so
// each callable is warmed at most once per five minutes. A failed warm-up
// only means the next tap pays the boot, so its error is dropped.
const MIN_INTERVAL_MS = 5 * 60 * 1000;
const warmedAt = { accept: 0, context: 0 };

export function warmTimerCallables(includeContext: boolean): void {
  if (!navigator.onLine) return;
  const now = Date.now();
  if (now - warmedAt.accept >= MIN_INTERVAL_MS) {
    warmedAt.accept = now;
    void timerAccept({ warmup: true }).catch(() => {});
  }
  if (includeContext && now - warmedAt.context >= MIN_INTERVAL_MS) {
    warmedAt.context = now;
    void timerContext({ warmup: true }).catch(() => {});
  }
}
