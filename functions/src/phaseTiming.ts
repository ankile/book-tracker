import { logger } from "firebase-functions";

// Wall-clock phases of one timer request, logged as a single line so the
// start/stop critical path can be read from production logs. Durations and
// bounded labels only: never descriptions, tokens or remote titles.
export function phaseTimer(event: string) {
  const started = Date.now();
  let last = started;
  const phases: Record<string, number> = {};
  return {
    mark(name: string): void {
      const now = Date.now();
      phases[name] = (phases[name] ?? 0) + now - last;
      last = now;
    },
    log(fields: Record<string, string | number | null>): void {
      logger.info(event, { ...fields, phases, totalMs: Date.now() - started });
    },
  };
}
