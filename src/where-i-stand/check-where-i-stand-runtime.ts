import { parseArgs } from "node:util";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";
import {
  judgeCampaignPageRecord,
  REAL_PAGE_RECORD_PLACES,
  type PageRecordPlaces,
} from "./campaign-page-record.ts";

export const CheckWhereIStandExitCode = {
  Recorded: 0,
  InvalidInvocation: 1,
  NotRecorded: 66,
} as const;

export const CHECK_WHERE_I_STAND_USAGE = "usage: throne check-where-i-stand --agent <alpha name>";

export interface CheckWhereIStandDependencies {
  readonly places: PageRecordPlaces;
  readonly out: (message: string) => void;
  readonly err: (message: string) => void;
}

export const REAL_CHECK_WHERE_I_STAND_DEPENDENCIES: CheckWhereIStandDependencies = {
  places: REAL_PAGE_RECORD_PLACES,
  out: (message) => void process.stdout.write(message),
  err: (message) => void process.stderr.write(message),
};

function agentNamedIn(commandArguments: readonly string[]): string {
  const { values } = parseArgs({
    args: [...commandArguments],
    options: { agent: { type: "string" } },
    strict: true,
    allowPositionals: false,
  });
  const agentName = (values.agent ?? "").trim();
  if (agentName === "") throw new Error("check-where-i-stand needs --agent <alpha name>");
  return agentName;
}

export async function runCheckWhereIStand(
  commandArguments: readonly string[],
  dependencies: CheckWhereIStandDependencies = REAL_CHECK_WHERE_I_STAND_DEPENDENCIES,
): Promise<number> {
  let agentName: string;
  try {
    agentName = agentNamedIn(commandArguments);
  } catch (error) {
    const complaint = error instanceof Error ? error.message : String(error);
    dependencies.err(
      `${complaint}\n${CHECK_WHERE_I_STAND_USAGE}\n${renderEntranceRefusal({
        reason: "check-where-i-stand entrance validation refused this invocation; nothing was checked.",
        bypass: undefined,
        supervisorRoute: "Ask your supervisor for an allowed alternative invocation.",
      })}\n`,
    );
    return CheckWhereIStandExitCode.InvalidInvocation;
  }
  const verdict = await judgeCampaignPageRecord(agentName, dependencies.places);
  if (verdict.recorded) {
    dependencies.out(`check-where-i-stand: recorded — ${verdict.summary}.\n`);
    return CheckWhereIStandExitCode.Recorded;
  }
  dependencies.err(`check-where-i-stand: ${verdict.reason}\n`);
  return CheckWhereIStandExitCode.NotRecorded;
}
