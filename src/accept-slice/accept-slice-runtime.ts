import { resolveCurrentAgentName } from "../herdr/herdr-session.service.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";
import {
  acceptSliceAndSendGoAhead,
  REAL_GO_AHEAD_DEPENDENCIES,
  shadowSupervisor,
  type GoAheadDependencies,
} from "../supervisor-wait/send-go-ahead.ts";

const BYPASS_FLAG = "--bypass-supervisor-check";
const USAGE = `Usage: throne accept-slice [--data-dir <path>] [${BYPASS_FLAG}] <shadow>\n`;

export interface AcceptSliceDependencies {
  readonly currentAgentName: () => Promise<string>;
  readonly goAhead: GoAheadDependencies;
  readonly out: (message: string) => void;
  readonly err: (message: string) => void;
}

export const REAL_ACCEPT_SLICE_DEPENDENCIES: AcceptSliceDependencies = {
  currentAgentName: resolveCurrentAgentName,
  goAhead: REAL_GO_AHEAD_DEPENDENCIES,
  out: (message) => void process.stdout.write(message),
  err: (message) => void process.stderr.write(message),
};

interface AcceptSliceArguments {
  readonly shadowName: string;
  readonly dataDir?: string;
  readonly bypassSupervisorCheck: boolean;
}

function parseArguments(args: readonly string[]): AcceptSliceArguments | undefined {
  let shadowName: string | undefined;
  let dataDir: string | undefined;
  let bypassSupervisorCheck = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--data-dir") {
      dataDir = args[++index];
      if (dataDir === undefined) return undefined;
    } else if (argument === BYPASS_FLAG) {
      bypassSupervisorCheck = true;
    } else if (argument.startsWith("--") || shadowName !== undefined) {
      return undefined;
    } else {
      shadowName = argument;
    }
  }
  if (shadowName === undefined) return undefined;
  return { shadowName, bypassSupervisorCheck, ...(dataDir === undefined ? {} : { dataDir }) };
}

export async function run(
  args: readonly string[],
  dependencies: AcceptSliceDependencies = REAL_ACCEPT_SLICE_DEPENDENCIES,
): Promise<number> {
  const parsed = parseArguments(args);
  if (parsed === undefined) {
    dependencies.err(USAGE);
    return 1;
  }
  const supervisor = await shadowSupervisor(parsed.shadowName, parsed.dataDir);
  if (supervisor === undefined) {
    dependencies.err(
      `accept-slice: "${parsed.shadowName}" is not a Shadow with a recorded supervisor. ` +
        renderEntranceRefusal({
          reason: "Only a Shadow's slice can be accepted.",
          bypass: undefined,
          supervisorRoute: "Ask your supervisor how to close this agent.",
        }) +
        "\n",
    );
    return 1;
  }
  const caller = await dependencies.currentAgentName();
  if (caller !== supervisor && !parsed.bypassSupervisorCheck) {
    dependencies.err(
      `accept-slice: ${renderEntranceRefusal({
        reason: `"${caller}" is not the supervisor of "${parsed.shadowName}"; its supervisor is "${supervisor}".`,
        bypass: `Re-run with ${BYPASS_FLAG} if you must accept it on ${supervisor}'s behalf.`,
        supervisorRoute: `Ask ${supervisor} to accept the slice.`,
      })}\n`,
    );
    return 1;
  }
  const record = await acceptSliceAndSendGoAhead(
    {
      shadowName: parsed.shadowName,
      supervisor,
      how: "verdict",
      ...(parsed.dataDir === undefined ? {} : { dataDir: parsed.dataDir }),
    },
    dependencies.goAhead,
  );
  if (record.goAhead?.sendOutcome !== "enqueued") {
    dependencies.err(
      `accept-slice: accepted "${parsed.shadowName}" but the go-ahead FAILED (${record.goAhead?.error ?? "unknown"}); ` +
        `tell it by send-agent that it may publish its reapability claim\n`,
    );
    return 1;
  }
  dependencies.out(
    `accept-slice: accepted "${parsed.shadowName}" and sent it the go-ahead to publish its reapability claim\n`,
  );
  return 0;
}
