import {
  ACCEPTANCE_DATA,
  type AcceptanceMethod,
  type AcceptanceRecord,
} from "../agentdata/acceptance-data.service.ts";
import {
  IdentityLineReadStatus,
  readAgentRole,
  readAgentSupervisor,
} from "../agentdata/identity-data.service.ts";
import { DEFAULT_DATA_DIR } from "../agentdata/spawn-data-contracts.ts";
import type { HerdrAgent } from "../herdr/herdr-identity-contracts.ts";
import { resolveAgent } from "../herdr/herdr-runtime.service.ts";
import { submitToAgentViaQueue } from "../throne-work/enqueue-heartbeat-message.ts";

export interface GoAheadDependencies {
  readonly resolveAgent: (name: string) => Promise<HerdrAgent>;
  readonly submitToAgent: (
    target: HerdrAgent,
    senderName: string,
    prompt: string,
    options: { key: string },
  ) => Promise<void>;
  readonly now: () => Date;
}

export const REAL_GO_AHEAD_DEPENDENCIES: GoAheadDependencies = {
  resolveAgent: (name) => resolveAgent(name),
  submitToAgent: (target, senderName, prompt, options) =>
    submitToAgentViaQueue(target, senderName, prompt, options),
  now: () => new Date(),
};

export interface AcceptSliceInputs {
  readonly shadowName: string;
  readonly supervisor: string;
  readonly how: AcceptanceMethod;
  readonly dataDir?: string;
}

export function goAheadText(shadowName: string, supervisor: string, how: AcceptanceMethod, acceptedAt: string): string {
  const accepted = how === "merge" ? "merged" : "accepted as a verdict";
  return (
    `${shadowName}: your slice was ${accepted} by ${supervisor} at ${acceptedAt}. ` +
    'You may now run `throne my-state reapable completed` and publish your reapability claim: {"reapable":"completed"}.'
  );
}

export async function acceptSliceAndSendGoAhead(
  inputs: AcceptSliceInputs,
  dependencies: GoAheadDependencies = REAL_GO_AHEAD_DEPENDENCIES,
): Promise<AcceptanceRecord> {
  const dataDir = inputs.dataDir ?? DEFAULT_DATA_DIR;
  const acceptedAt = dependencies.now().toISOString();
  const accepted = { acceptedAt, by: inputs.supervisor, how: inputs.how };
  await ACCEPTANCE_DATA.write(inputs.shadowName, accepted, dataDir);
  const prompt = goAheadText(inputs.shadowName, inputs.supervisor, inputs.how, acceptedAt);
  let record: AcceptanceRecord;
  try {
    const target = await dependencies.resolveAgent(inputs.shadowName);
    await dependencies.submitToAgent(target, inputs.supervisor, prompt, {
      key: `go-ahead:${inputs.shadowName}:${acceptedAt}`,
    });
    record = { ...accepted, goAhead: { sentAt: dependencies.now().toISOString(), sendOutcome: "enqueued" } };
  } catch (error) {
    record = {
      ...accepted,
      goAhead: {
        sentAt: dependencies.now().toISOString(),
        sendOutcome: "failed",
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
  await ACCEPTANCE_DATA.write(inputs.shadowName, record, dataDir);
  return record;
}

export async function shadowSupervisor(name: string, dataDir: string = DEFAULT_DATA_DIR): Promise<string | undefined> {
  const role = await readAgentRole(name, dataDir);
  if (role.status !== IdentityLineReadStatus.Found || role.value !== "Shadow") return undefined;
  const supervisor = await readAgentSupervisor(name, dataDir);
  if (supervisor.status !== IdentityLineReadStatus.Found || supervisor.value === "") return undefined;
  return supervisor.value;
}

export async function sendGoAheadAfterMerge(
  name: string,
  dataDir: string | undefined,
  dependencies: GoAheadDependencies = REAL_GO_AHEAD_DEPENDENCIES,
): Promise<string | undefined> {
  const supervisor = await shadowSupervisor(name, dataDir);
  if (supervisor === undefined) return undefined;
  const record = await acceptSliceAndSendGoAhead(
    { shadowName: name, supervisor, how: "merge", ...(dataDir === undefined ? {} : { dataDir }) },
    dependencies,
  );
  return record.goAhead?.sendOutcome === "enqueued"
    ? `merge-git-tree: sent "${name}" its go-ahead to publish its reapability claim and recorded the acceptance\n`
    : `merge-git-tree: the go-ahead to "${name}" FAILED (${record.goAhead?.error ?? "unknown"}); the acceptance is recorded and the merge stands — tell ${name} by send-agent that it may publish its reapability claim\n`;
}
