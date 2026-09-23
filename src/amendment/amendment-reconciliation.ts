import { RECONCILED_THROUGH_LABEL } from "./amendment-notices.ts";

export type ReconciliationVerdict =
  | { readonly reconciled: true }
  | { readonly reconciled: false; readonly reason: string };

const RECONCILED_THROUGH_LINE = new RegExp(
  `^${RECONCILED_THROUGH_LABEL.replace(/[*]/g, "\\*")}\\s*(\\d+)\\s*$`,
  "gm",
);

export function readReconciledThrough(evidenceText: string): number | undefined {
  const matches = [...evidenceText.matchAll(RECONCILED_THROUGH_LINE)];
  const last = matches.at(-1);
  return last === undefined ? undefined : Number(last[1]);
}

export function decideReconciliation(input: {
  readonly objectiveCode: string;
  readonly highestAmendment: number;
  readonly reconciledThrough: number | undefined;
  readonly evidenceFile: string;
}): ReconciliationVerdict {
  if (input.highestAmendment === 0) return { reconciled: true };
  const readCommand = `throne render-queue --status in-flight`;
  if (input.reconciledThrough === undefined) {
    return {
      reconciled: false,
      reason:
        `queue row "${input.objectiveCode}" carries AMENDMENT ${input.highestAmendment}, but ` +
        `${input.evidenceFile} has no "${RECONCILED_THROUGH_LABEL} <n>" line. Read the amendments with ` +
        `\`${readCommand}\`, reconcile them into the plan, then record ` +
        `"${RECONCILED_THROUGH_LABEL} ${input.highestAmendment}" there.`,
    };
  }
  if (input.reconciledThrough < input.highestAmendment) {
    return {
      reconciled: false,
      reason:
        `queue row "${input.objectiveCode}" carries AMENDMENT ${input.highestAmendment}, but ` +
        `${input.evidenceFile} records "${RECONCILED_THROUGH_LABEL} ${input.reconciledThrough}". ` +
        `AMENDMENTS ${input.reconciledThrough + 1}-${input.highestAmendment} are unreconciled; read them with ` +
        `\`${readCommand}\`, reconcile them, re-run whichever checks they invalidate, then update the line.`,
    };
  }
  return { reconciled: true };
}
