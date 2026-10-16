import { REAP_REASON } from "../agent-timings/reap-reason.ts";
import type { ReapRequest } from "./reap-agent.types.ts";

export function writeSuccessfulOutcome(
  request: ReapRequest,
  actions: string[],
  rosterKnown: boolean,
  abandonedDisposition:
    | {
        ref: string;
        tip: string;
      }
    | undefined,
): number {
  if (actions.length === 0) {
    const note = rosterKnown ? "" : " (roster unreachable)";
    process.stdout.write(
      `reap-agent: "${request.name}" is already gone — nothing to reap${note}.\n`,
    );
    return 0;
  }
  if (abandonedDisposition !== undefined) {
    const label =
      request.reason === REAP_REASON.ABANDONED
        ? "ABANDONED-UNMERGED"
        : "UNMERGED-RETAINED";
    const explanation =
      request.reason === REAP_REASON.ABANDONED
        ? "The branch was not merged or deleted, and its retained ref blocks exact-name reuse.\n"
        : "The branch's commits are not reachable from the target (commonly a " +
          "history-rewrite transplant whose content already landed) so it was " +
          "retained rather than merged or deleted; its retained ref blocks " +
          "exact-name reuse.\n";
    process.stdout.write(
      `${label} "${request.name}": retained ${abandonedDisposition.ref} at ` +
        `${abandonedDisposition.tip}; ${actions.join("; ")}. ${explanation}`,
    );
    return 0;
  }
  process.stdout.write(`Reaped "${request.name}": ${actions.join("; ")}.\n`);
  return 0;
}

export function writeUnreleasedRowOutcome(
  request: ReapRequest,
  actions: string[],
  reason: string,
): number {
  const teardown =
    actions.length === 0
      ? "was already gone"
      : `was torn down (${actions.join("; ")})`;
  process.stderr.write(
    `reap-agent: "${request.name}" ${teardown}, but ` +
      `its queue row was NOT released — ${reason}. Read the row with ` +
      `\`throne render-queue\` and report its real status; do not report it ` +
      `released.\n`,
  );
  return 1;
}
