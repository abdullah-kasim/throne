import type { RuntimeModelAcceptance } from "../session/runtime-model-acceptance.ts";
export { checkAgentRuntimeModelAcceptance } from "../session/runtime-model-acceptance.ts";

export type CheckTaskRuntimeModelAcceptance = (
  name: string,
  phase: "task",
) => Promise<RuntimeModelAcceptance>;

function humanSteeredNotice(
  recipientName: string,
  acceptance: Extract<RuntimeModelAcceptance, { outcome: "exempt-human-steered-role" }>,
): string | undefined {
  const steeredElsewhere = acceptance.observedModels.some(
    (model) => model !== acceptance.recordedModel,
  );
  if (!steeredElsewhere) return undefined;
  return (
    `send-agent: "${recipientName}" is a ${acceptance.role} observed on ` +
    `${acceptance.observedModels.join(", ")} (recorded ${acceptance.recordedModel}) — ` +
    `human-steered role, delivering anyway; evidence at ${acceptance.evidencePath}\n`
  );
}

export async function refuseTaskOnRuntimeModelMismatch(
  recipientName: string,
  checkRuntimeModelAcceptance?: CheckTaskRuntimeModelAcceptance,
): Promise<boolean> {
  const acceptance = await checkRuntimeModelAcceptance?.(recipientName, "task");
  if (acceptance === undefined) return false;
  if (acceptance.ok) {
    if (acceptance.outcome === "exempt-human-steered-role") {
      const notice = humanSteeredNotice(recipientName, acceptance);
      if (notice !== undefined) process.stderr.write(notice);
    }
    return false;
  }
  process.stderr.write(
    `send-agent: refusing task acceptance for "${recipientName}": ${acceptance.detail}. Nothing was queued or delivered.\n`,
  );
  process.exitCode = 1;
  return true;
}
