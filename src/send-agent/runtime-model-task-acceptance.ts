import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_DATA_DIR } from "../agentdata/spawn-data-contracts.ts";
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

export type TellRegentAboutUnknownModel = (modelId: string) => Promise<void>;

const UNKNOWN_MODEL_NOTICES_FOLDER = "unknown-runtime-model-notices";

function isAlreadyRecorded(error: unknown): boolean {
  return (error as { code?: unknown }).code === "EEXIST";
}

export async function tellRegentOnceAboutUnknownModel(
  modelId: string,
  sendToRegent: (prompt: string) => Promise<void>,
  baseDir: string = DEFAULT_DATA_DIR,
): Promise<void> {
  const noticesFolder = path.join(baseDir, UNKNOWN_MODEL_NOTICES_FOLDER);
  const noticeFile = path.join(noticesFolder, encodeURIComponent(modelId));
  await mkdir(noticesFolder, { recursive: true });
  try {
    await writeFile(
      noticeFile,
      `${new Date().toISOString()}\n`,
      { flag: "wx" },
    );
  } catch (error) {
    if (isAlreadyRecorded(error)) return;
    throw error;
  }
  try {
    await sendToRegent(
      `send-agent: an agent transcript reports the model ${modelId}, which the model registry does not know. ` +
        "Messages to it are delivered anyway. Add it to src/harness-routing/model-registry.ts if it is a real model.",
    );
  } catch (error) {
    await rm(noticeFile, { force: true });
    throw error;
  }
}

function unknownModelWarning(
  recipientName: string,
  acceptance: Extract<RuntimeModelAcceptance, { outcome: "unknown-model" }>,
): string {
  return (
    `send-agent: warning: "${recipientName}" reports ${acceptance.unknownModels.join(", ")}, ` +
    `which the model registry does not know (requested ${acceptance.requestedModel}); ` +
    `delivering anyway; evidence at ${acceptance.evidencePath}\n`
  );
}

async function tellRegentAboutEach(
  modelIds: string[],
  tellRegent: TellRegentAboutUnknownModel,
): Promise<void> {
  for (const modelId of modelIds) {
    try {
      await tellRegent(modelId);
    } catch (error) {
      process.stderr.write(
        `send-agent: could not tell the Regent about unknown model ${modelId}, ignoring: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }
}

export async function refuseTaskOnRuntimeModelMismatch(
  recipientName: string,
  checkRuntimeModelAcceptance?: CheckTaskRuntimeModelAcceptance,
  tellRegentAboutUnknownModel?: TellRegentAboutUnknownModel,
): Promise<boolean> {
  const acceptance = await checkRuntimeModelAcceptance?.(recipientName, "task");
  if (acceptance === undefined) return false;
  if (acceptance.ok) {
    if (acceptance.outcome === "unknown-model") {
      process.stderr.write(unknownModelWarning(recipientName, acceptance));
      if (tellRegentAboutUnknownModel !== undefined) {
        await tellRegentAboutEach(acceptance.unknownModels, tellRegentAboutUnknownModel);
      }
    }
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
