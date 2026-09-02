import type { RuntimeModelAcceptance } from "../session/runtime-model-acceptance.ts";
export { checkAgentRuntimeModelAcceptance } from "../session/runtime-model-acceptance.ts";

export type CheckTaskRuntimeModelAcceptance = (
  name: string,
  phase: "task",
) => Promise<RuntimeModelAcceptance>;

export async function refuseTaskOnRuntimeModelMismatch(
  recipientName: string,
  checkRuntimeModelAcceptance?: CheckTaskRuntimeModelAcceptance,
): Promise<boolean> {
  const acceptance = await checkRuntimeModelAcceptance?.(recipientName, "task");
  if (acceptance === undefined || acceptance.ok) return false;
  process.stderr.write(
    `send-agent: refusing task acceptance for "${recipientName}": ${acceptance.detail}. Nothing was queued or delivered.\n`,
  );
  process.exitCode = 1;
  return true;
}
