import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  IdentityLineReadStatus,
  readAgentRole,
} from "../agentdata/identity-data.service.ts";
import { hasCompletionReportForAgent } from "../agentdata/ledger-data.service.ts";
import { resolveCurrentAgentName } from "../herdr/herdr-session.service.ts";
import {
  openRegentQueueAmendments,
  type QueueAmendment,
  type RegentQueueAmendments,
} from "../regent-queue/regent-queue-amendments.ts";
import { findQueueItemByObjectiveCode } from "../regent-queue/regent-queue-lifecycle.ts";
import {
  openRegentQueueStore,
  type RegentQueueItemRow,
  type RegentQueueStore,
} from "../regent-queue/regent-queue.store.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";
import { isQueueFilerRoleName } from "../shared-policy/objective-contract.ts";
import {
  CANONICAL_REGENT_AUTHORITY,
  canonicalRegentAuthority,
} from "../shared-policy/regent-authority.ts";
import {
  AMENDMENT_USAGE,
  parseAmendmentArguments,
  type AmendmentArguments,
} from "./amendment-arguments.ts";
import { composeNoticeForAlpha, composeNoticeForRegent } from "./amendment-notices.ts";
import {
  AmendmentRoute,
  decideAmendmentRoute,
  type AmendmentRowFacts,
} from "./amendment-routing.ts";

export const AmendmentExitCode = {
  Recorded: 0,
  Refused: 1,
  RecordedButNotEveryoneWasTold: 2,
} as const;

export interface AmendmentDependencies {
  readonly openStore: () => RegentQueueStore;
  readonly openAmendments: () => RegentQueueAmendments;
  readonly currentAgentName: () => Promise<string>;
  readonly readRole: (name: string) => Promise<{ status: IdentityLineReadStatus; value?: string }>;
  readonly hasWrittenItsReport: (agentName: string) => Promise<boolean>;
  readonly sendMessage: (recipient: string, message: string) => Promise<void>;
  readonly readTextFile: (filePath: string) => Promise<string>;
  readonly out: (message: string) => void;
  readonly err: (message: string) => void;
}

const execFileAsync = promisify(execFile);

export const REAL_AMENDMENT_DEPENDENCIES: AmendmentDependencies = {
  openStore: openRegentQueueStore,
  openAmendments: openRegentQueueAmendments,
  currentAgentName: resolveCurrentAgentName,
  readRole: (name) => readAgentRole(name),
  hasWrittenItsReport: (agentName) => hasCompletionReportForAgent(agentName),
  sendMessage: async (recipient, message) => {
    await execFileAsync("throne", ["send-agent", recipient, message]);
  },
  readTextFile: (filePath) => readFile(filePath, "utf8"),
  out: (message) => void process.stdout.write(message),
  err: (message) => void process.stderr.write(message),
};

function callerIsRegent(callerName: string): boolean {
  return canonicalRegentAuthority(callerName) !== undefined;
}

async function refusalForCaller(
  callerName: string,
  dependencies: AmendmentDependencies,
): Promise<string | undefined> {
  if (callerIsRegent(callerName)) return undefined;
  const role = await dependencies.readRole(callerName);
  if (role.status === IdentityLineReadStatus.Found && isQueueFilerRoleName(role.value ?? "")) {
    return undefined;
  }
  return (
    `amendment: only a Stager or the Regent may record an amendment; "${callerName}" is ` +
    `${role.status === IdentityLineReadStatus.Found ? `a ${role.value}` : "not identifiable"}. ` +
    `Report the Lord's words to your supervisor instead.`
  );
}

async function readAmendmentText(
  parsed: AmendmentArguments,
  dependencies: AmendmentDependencies,
): Promise<string> {
  const text = parsed.text ?? (await dependencies.readTextFile(parsed.textFile!));
  if (text.trim() === "") throw new Error("amendment: the amendment text is empty");
  return text.trim();
}

async function readRowFacts(
  row: RegentQueueItemRow | undefined,
  dependencies: AmendmentDependencies,
): Promise<AmendmentRowFacts | undefined> {
  if (row === undefined || row.objectiveCode === null) return undefined;
  return {
    objectiveCode: row.objectiveCode,
    status: row.status,
    alphaName: row.agentName,
    deliveredCommit: row.deliveryCommit,
    deliveryBranch: row.prBranch ?? row.launchEligibility?.targetBranch ?? null,
    alphaHasWrittenItsReport:
      row.agentName !== null && (await dependencies.hasWrittenItsReport(row.agentName)),
  };
}

async function tellCampaign(
  amendment: QueueAmendment,
  alphaName: string | null,
  callerName: string,
  dependencies: AmendmentDependencies,
): Promise<string[]> {
  const deliveries: Array<[string, string]> = [];
  if (alphaName !== null) deliveries.push([alphaName, composeNoticeForAlpha(amendment)]);
  if (!callerIsRegent(callerName)) {
    deliveries.push([CANONICAL_REGENT_AUTHORITY, composeNoticeForRegent(amendment, alphaName)]);
  }
  const failures: string[] = [];
  for (const [recipient, notice] of deliveries) {
    try {
      await dependencies.sendMessage(recipient, notice);
    } catch (error) {
      failures.push(`${recipient} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return failures;
}

function refuse(message: string, dependencies: AmendmentDependencies): number {
  dependencies.err(
    `${message}\n${renderEntranceRefusal({
      reason: "amendment entrance validation refused this invocation; nothing was recorded.",
      bypass: undefined,
      supervisorRoute: "Ask your supervisor for an allowed alternative invocation.",
    })}\n`,
  );
  return AmendmentExitCode.Refused;
}

export async function run(
  args: string[],
  dependencies: AmendmentDependencies = REAL_AMENDMENT_DEPENDENCIES,
): Promise<number> {
  let parsed: AmendmentArguments;
  let text: string;
  let callerName: string;
  try {
    parsed = parseAmendmentArguments(args);
    text = await readAmendmentText(parsed, dependencies);
    callerName = await dependencies.currentAgentName();
  } catch (error) {
    return refuse(`${error instanceof Error ? error.message : String(error)}\n${AMENDMENT_USAGE}`, dependencies);
  }
  const callerRefusal = await refusalForCaller(callerName, dependencies);
  if (callerRefusal !== undefined) return refuse(callerRefusal, dependencies);

  const store = dependencies.openStore();
  let facts: AmendmentRowFacts | undefined;
  try {
    facts = await readRowFacts(findQueueItemByObjectiveCode(store, parsed.objectiveCode), dependencies);
  } finally {
    store.close();
  }
  const decision = decideAmendmentRoute(parsed.objectiveCode, facts);
  if (
    decision.route === AmendmentRoute.RefuseAlreadyDelivered ||
    decision.route === AmendmentRoute.RefuseNoSuchRow
  ) {
    return refuse(`amendment: ${decision.reason}`, dependencies);
  }

  const amendments = dependencies.openAmendments();
  let amendment: QueueAmendment;
  try {
    amendment = amendments.record({
      objectiveCode: parsed.objectiveCode,
      text,
      wordsOf: parsed.wordsOf,
      relayedBy: parsed.relayedBy ?? callerName,
    });
  } finally {
    amendments.close();
  }
  const recorded = `amendment: recorded AMENDMENT ${amendment.number} on "${amendment.objectiveCode}"`;

  if (decision.route === AmendmentRoute.RecordBeforeLaunch) {
    dependencies.out(
      `${recorded}. The row has not launched yet; its Alpha receives every recorded amendment in its launch situation brief.\n`,
    );
    return AmendmentExitCode.Recorded;
  }

  const failures = await tellCampaign(amendment, decision.alphaName, callerName, dependencies);
  const everyoneWasTold = decision.alphaName !== null && failures.length === 0;
  if (decision.alphaName === null) {
    dependencies.err(
      `${recorded}, but the row is in flight with NO Alpha recorded, so no campaign was told. Tell the Regent what is flying it.\n`,
    );
  }
  if (failures.length > 0) {
    dependencies.err(
      `${recorded}, but these recipients were NOT told: ${failures.join("; ")}. ` +
        `Tell them by hand with a short \`throne send-agent\` pointing at AMENDMENT ${amendment.number}.\n`,
    );
  }
  if (!everyoneWasTold) return AmendmentExitCode.RecordedButNotEveryoneWasTold;
  const regentSuffix = callerIsRegent(callerName) ? "" : " and the Regent";
  dependencies.out(`${recorded}; told ${decision.alphaName}${regentSuffix}.\n`);
  return AmendmentExitCode.Recorded;
}
