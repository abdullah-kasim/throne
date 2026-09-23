import {
  openRegentQueueAmendments,
  type RegentQueueAmendments,
} from "../regent-queue/regent-queue-amendments.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";
import { DEFAULT_DATA_DIR } from "../agentdata/spawn-data-contracts.ts";
import {
  decideReconciliation,
  readReconciledThrough,
  type ReconciliationVerdict,
} from "./amendment-reconciliation.ts";
import {
  locateReconciliationEvidence,
  readEvidenceText,
} from "./reconciliation-evidence.ts";

export const CheckReconciledExitCode = {
  Reconciled: 0,
  InvalidInvocation: 1,
  NotReconciled: 66,
} as const;

export const CHECK_RECONCILED_USAGE =
  "usage: throne check-queue-amendments-reconciled --agent <alpha name>";

export interface CheckReconciledDependencies {
  readonly dataDir: string;
  readonly openAmendments: () => RegentQueueAmendments;
  readonly out: (message: string) => void;
  readonly err: (message: string) => void;
}

export const REAL_CHECK_RECONCILED_DEPENDENCIES: CheckReconciledDependencies = {
  dataDir: DEFAULT_DATA_DIR,
  openAmendments: openRegentQueueAmendments,
  out: (message) => void process.stdout.write(message),
  err: (message) => void process.stderr.write(message),
};

export function parseCheckReconciledArguments(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== "--agent" || (args[1] ?? "").trim() === "") {
    throw new Error(`check-queue-amendments-reconciled: expected exactly --agent <name>\n${CHECK_RECONCILED_USAGE}`);
  }
  return args[1]!;
}

function highestAmendmentFor(
  objectiveCode: string,
  dependencies: CheckReconciledDependencies,
): number {
  const amendments = dependencies.openAmendments();
  try {
    return amendments.highestNumberFor(objectiveCode);
  } finally {
    amendments.close();
  }
}

export async function judgeAgentReconciliation(
  agentName: string,
  dependencies: CheckReconciledDependencies,
): Promise<ReconciliationVerdict & { readonly summary: string }> {
  const evidence = await locateReconciliationEvidence(agentName, dependencies.dataDir);
  if (evidence.kind === "not-a-queued-campaign") {
    return { reconciled: true, summary: `${agentName} carries no queue objective code; nothing to reconcile` };
  }
  const highestAmendment = highestAmendmentFor(evidence.objectiveCode, dependencies);
  if (evidence.kind === "no-plan-yet") {
    const verdict =
      highestAmendment === 0
        ? ({ reconciled: true } as const)
        : ({
            reconciled: false,
            reason:
              `queue row "${evidence.objectiveCode}" carries AMENDMENT ${highestAmendment}, ` +
              `and ${evidence.ledger} has no plan bundle recording that it was reconciled.`,
          } as const);
    return { ...verdict, summary: `"${evidence.objectiveCode}" has ${highestAmendment} amendment(s)` };
  }
  const verdict = decideReconciliation({
    objectiveCode: evidence.objectiveCode,
    highestAmendment,
    reconciledThrough: readReconciledThrough(await readEvidenceText(evidence.filePath)),
    evidenceFile: evidence.filePath,
  });
  return {
    ...verdict,
    summary: `"${evidence.objectiveCode}" has ${highestAmendment} amendment(s), checked against ${evidence.filePath}`,
  };
}

export async function run(
  args: string[],
  dependencies: CheckReconciledDependencies = REAL_CHECK_RECONCILED_DEPENDENCIES,
): Promise<number> {
  let agentName: string;
  try {
    agentName = parseCheckReconciledArguments(args);
  } catch (error) {
    dependencies.err(
      `${error instanceof Error ? error.message : String(error)}\n${renderEntranceRefusal({
        reason: "check-queue-amendments-reconciled entrance validation refused this invocation.",
        bypass: undefined,
        supervisorRoute: "Ask your supervisor for an allowed alternative invocation.",
      })}\n`,
    );
    return CheckReconciledExitCode.InvalidInvocation;
  }
  const verdict = await judgeAgentReconciliation(agentName, dependencies);
  if (verdict.reconciled) {
    dependencies.out(`check-queue-amendments-reconciled: reconciled — ${verdict.summary}.\n`);
    return CheckReconciledExitCode.Reconciled;
  }
  dependencies.err(`check-queue-amendments-reconciled: NOT reconciled — ${verdict.reason}\n`);
  return CheckReconciledExitCode.NotReconciled;
}
