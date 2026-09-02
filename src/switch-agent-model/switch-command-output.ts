import type { SwitchTransactionResult } from "./transaction/transaction.types.ts";

export interface SwitchCommandOutputDeps {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export function writeCommandOutcome(
  outcome: "refused-before-close" | "target-failed/rollback-failed",
  changed: "no" | "unknown",
  deps: SwitchCommandOutputDeps,
): void {
  deps.stdout(`outcome: ${outcome}; spawn.json changed: ${changed}\n`);
}

export function writeResult(
  result: SwitchTransactionResult,
  deps: SwitchCommandOutputDeps,
): void {
  for (const event of result.phases) {
    deps.stdout(
      `phase ${event.phase}: ${event.status}${event.detail === undefined ? "" : ` — ${event.detail}`}\n`,
    );
  }
  if (result.reason !== undefined)
    deps.stderr(`switch-agent-model: ${result.reason}\n`);
  const changed =
    result.spawnEvidenceChanged === true
      ? "yes"
      : result.spawnEvidenceChanged === false
        ? "no"
        : "unknown";
  deps.stdout(`outcome: ${result.outcome}; spawn.json changed: ${changed}\n`);
}
