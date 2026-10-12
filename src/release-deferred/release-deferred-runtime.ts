import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  IdentityLineReadStatus,
  readAgentRole,
} from "../agentdata/identity-data.service.ts";
import { resolveCurrentAgentName } from "../herdr/herdr-session.service.ts";
import { RegentQueueItemStatus } from "../regent-queue/regent-queue-item-state.ts";
import { findQueueItemByObjectiveCode } from "../regent-queue/regent-queue-lifecycle.ts";
import type { QueueReleaseRequest } from "../regent-queue/regent-queue-row.ts";
import {
  openRegentQueueStore,
  type RegentQueueItemRow,
  type RegentQueueMutationStore,
} from "../regent-queue/regent-queue.store.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";
import { isQueueFilerRoleName } from "../shared-policy/objective-contract.ts";
import { canonicalRegentAuthority } from "../shared-policy/regent-authority.ts";
import {
  RELEASE_DEFERRED_COMMAND,
  RELEASE_DEFERRED_USAGE,
  parseReleaseDeferredArguments,
  type ReleaseDeferredArguments,
} from "./release-deferred-arguments.ts";

export const ReleaseDeferredExitCode = {
  Released: 0,
  Refused: 1,
  ReleasedButRequesterNotTold: 2,
} as const;

export interface ReleaseDeferredDependencies {
  readonly openStore: () => RegentQueueMutationStore;
  readonly currentAgentName: () => Promise<string>;
  readonly readRole: (name: string) => Promise<{ status: IdentityLineReadStatus; value?: string }>;
  readonly sendMessage: (recipient: string, message: string) => Promise<void>;
  readonly out: (message: string) => void;
  readonly err: (message: string) => void;
}

const execFileAsync = promisify(execFile);

export const REAL_RELEASE_DEFERRED_DEPENDENCIES: ReleaseDeferredDependencies = {
  openStore: openRegentQueueStore,
  currentAgentName: resolveCurrentAgentName,
  readRole: (name) => readAgentRole(name),
  sendMessage: async (recipient, message) => {
    await execFileAsync("throne", ["send-agent", recipient, message]);
  },
  out: (message) => void process.stdout.write(message),
  err: (message) => void process.stderr.write(message),
};

export function composeReleaseReply(objectiveCode: string, reason: string): string {
  return `Released ${objectiveCode}: ${reason}`;
}

function describeReleaseForAudit(objectiveCode: string, release: QueueReleaseRequest): string {
  return (
    `${RELEASE_DEFERRED_COMMAND} ${objectiveCode}: requested by ${release.requestedBy ?? "nobody"}; ` +
    `reason: ${release.reason}`
  );
}

export function releaseDeferredRow(
  store: RegentQueueMutationStore,
  row: RegentQueueItemRow,
  release: QueueReleaseRequest,
): RegentQueueItemRow {
  return store.mutateItem(
    row.id,
    { status: RegentQueueItemStatus.Open, release },
    { actor: release.releasedBy, predicate: describeReleaseForAudit(row.objectiveCode ?? row.id, release) },
  );
}

async function isFilingStager(
  callerName: string,
  row: RegentQueueItemRow,
  dependencies: ReleaseDeferredDependencies,
): Promise<boolean> {
  if (row.filedBy !== callerName) return false;
  const role = await dependencies.readRole(callerName);
  return role.status === IdentityLineReadStatus.Found && isQueueFilerRoleName(role.value ?? "");
}

async function refuseUnadmittedReleaser(
  callerName: string,
  row: RegentQueueItemRow,
  dependencies: ReleaseDeferredDependencies,
): Promise<string | undefined> {
  if (canonicalRegentAuthority(callerName) !== undefined) return undefined;
  if (await isFilingStager(callerName, row, dependencies)) return undefined;
  return (
    `${RELEASE_DEFERRED_COMMAND}: only the Regent or the Stager that filed "${row.objectiveCode}" ` +
    `(${row.filedBy ?? "no filer recorded"}) may release it; "${callerName}" may not. ` +
    `Ask the Regent to release it instead.`
  );
}

function describeRowThatIsNotDeferred(row: RegentQueueItemRow, objectiveCode: string): string {
  return (
    `${RELEASE_DEFERRED_COMMAND}: queue objective "${objectiveCode}" is "${row.status}", not ` +
    `"${RegentQueueItemStatus.Deferred}"; only a deferred row can be released`
  );
}

function describeLaunchEligibility(row: RegentQueueItemRow): string {
  const eligibility = row.launchEligibility;
  if (eligibility?.eligible === true) return "launch-eligible";
  return `not launch-eligible: ${eligibility?.reason ?? "launch eligibility unknown"}`;
}

function refuse(message: string, dependencies: ReleaseDeferredDependencies): number {
  dependencies.err(
    `${message}\n${renderEntranceRefusal({
      reason: `${RELEASE_DEFERRED_COMMAND} entrance validation refused this invocation; nothing was changed.`,
      bypass: undefined,
      supervisorRoute: "Ask your supervisor for an allowed alternative invocation.",
    })}\n`,
  );
  return ReleaseDeferredExitCode.Refused;
}

async function replyToRequester(
  parsed: ReleaseDeferredArguments,
  requestedBy: string,
  dependencies: ReleaseDeferredDependencies,
): Promise<number> {
  const reply = composeReleaseReply(parsed.objectiveCode, parsed.reason);
  try {
    await dependencies.sendMessage(requestedBy, reply);
  } catch (error) {
    dependencies.err(
      `${RELEASE_DEFERRED_COMMAND}: "${parsed.objectiveCode}" was released, but ${requestedBy} was NOT told ` +
        `(${error instanceof Error ? error.message : String(error)}). Send it by hand: "${reply}"\n`,
    );
    return ReleaseDeferredExitCode.ReleasedButRequesterNotTold;
  }
  dependencies.out(`${RELEASE_DEFERRED_COMMAND}: told ${requestedBy}.\n`);
  return ReleaseDeferredExitCode.Released;
}

export async function run(
  args: string[],
  dependencies: ReleaseDeferredDependencies = REAL_RELEASE_DEFERRED_DEPENDENCIES,
): Promise<number> {
  let parsed: ReleaseDeferredArguments;
  let callerName: string;
  try {
    parsed = parseReleaseDeferredArguments(args);
    callerName = await dependencies.currentAgentName();
  } catch (error) {
    return refuse(`${error instanceof Error ? error.message : String(error)}\n${RELEASE_DEFERRED_USAGE}`, dependencies);
  }
  const store = dependencies.openStore();
  let released: RegentQueueItemRow;
  try {
    const row = findQueueItemByObjectiveCode(store, parsed.objectiveCode);
    if (row === undefined)
      return refuse(`${RELEASE_DEFERRED_COMMAND}: queue objective "${parsed.objectiveCode}" does not exist`, dependencies);
    if (row.status !== RegentQueueItemStatus.Deferred)
      return refuse(describeRowThatIsNotDeferred(row, parsed.objectiveCode), dependencies);
    const callerRefusal = await refuseUnadmittedReleaser(callerName, row, dependencies);
    if (callerRefusal !== undefined) return refuse(callerRefusal, dependencies);
    released = releaseDeferredRow(store, row, {
      requestedBy: parsed.requestedBy,
      releasedBy: canonicalRegentAuthority(callerName) ?? callerName,
      reason: parsed.reason,
    });
  } finally {
    store.close();
  }
  dependencies.out(
    `${RELEASE_DEFERRED_COMMAND}: released "${parsed.objectiveCode}" to open (${describeLaunchEligibility(released)}).\n`,
  );
  if (parsed.requestedBy === null) return ReleaseDeferredExitCode.Released;
  return replyToRequester(parsed, parsed.requestedBy, dependencies);
}
