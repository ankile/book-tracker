import { auth } from "./firebase/auth.ts";
import { timerSweep } from "./firebase/functions.ts";
import { reconcileTimerOutbox } from "./firebase/timeTracking.ts";
import { addError } from "./stores/errors.ts";

export function startTimerRecovery(uid: string): () => void {
  let stopped = false;
  let running = false;
  const recover = async () => {
    if (
      stopped ||
      running ||
      !navigator.onLine ||
      auth.currentUser?.uid !== uid
    )
      return;
    running = true;
    try {
      await reconcileTimerOutbox(uid);
      if (!stopped && navigator.onLine && auth.currentUser?.uid === uid)
        await timerSweep({});
    } catch {
      if (!stopped && auth.currentUser?.uid === uid) {
        addError(
          "Timer recovery could not finish. It will retry when connected; saved operations remain in Time tracking settings.",
        );
      }
    } finally {
      running = false;
    }
  };
  void recover();
  window.addEventListener("online", recover);
  const interval = window.setInterval(recover, 300_000);
  return () => {
    stopped = true;
    window.removeEventListener("online", recover);
    window.clearInterval(interval);
  };
}
