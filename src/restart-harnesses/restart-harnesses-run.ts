import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { errorText } from "../shared-policy/error-text.ts";
import {
  REAL_DEPS,
  parseRestartHarnessesArguments,
  planRestarts,
  restartHarnesses,
  type RestartHarnessesDeps,
  type RestartHarnessesOptions,
  type RestartOutcome,
  type RestartVerdict,
} from "./restart-harnesses-runtime.ts";

const DETACHED_RUN_MARKER = "THRONE_RESTART_HARNESSES_DETACHED";

export interface DetachedRunDeps {
  isDetachedRun: () => boolean;
  handOverToDetachedRun: (args: readonly string[]) => Promise<string>;
}

export async function handOverToDetachedRun(args: readonly string[]): Promise<string> {
  const logPath = path.join(homedir(), "tmp", "restart-harnesses.log");
  await mkdir(path.dirname(logPath), { recursive: true });
  const log = await open(logPath, "a");
  await log.write(`=== restart-harnesses run ${new Date().toISOString()} ${args.join(" ")} ===\n`);
  spawn(process.execPath, [...process.execArgv, process.argv[1]!, "restart-harnesses", ...args], {
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
    env: { ...process.env, [DETACHED_RUN_MARKER]: "1" },
  }).unref();
  await log.close();
  return logPath;
}

const REAL_DETACHED_RUN_DEPS: DetachedRunDeps = {
  isDetachedRun: () => process.env[DETACHED_RUN_MARKER] !== undefined,
  handOverToDetachedRun,
};

async function targetsIncludeInvokingPane(
  options: RestartHarnessesOptions,
  deps: RestartHarnessesDeps,
): Promise<boolean> {
  const invokingPaneId = await deps.currentPaneId();
  const { targets } = planRestarts(await deps.listAgents(), invokingPaneId, options);
  return targets.some((agent) => agent.paneId === invokingPaneId);
}

function closingLine(outcomes: readonly RestartOutcome[]): string {
  const count = (verdict: RestartVerdict) =>
    outcomes.filter((outcome) => outcome.verdict === verdict).length;
  return `restart-harnesses: finished — ${count("restarted")} restarted, ${count("skipped")} skipped, ${count("failed")} failed\n`;
}

export async function run(
  args: readonly string[],
  deps: RestartHarnessesDeps = REAL_DEPS,
  detachedRunDeps: DetachedRunDeps = REAL_DETACHED_RUN_DEPS,
): Promise<number> {
  let options: RestartHarnessesOptions;
  try {
    options = parseRestartHarnessesArguments(args);
  } catch (error) {
    deps.warn(`restart-harnesses: ${errorText(error)}\n`);
    return 2;
  }
  const isDetachedRun = detachedRunDeps.isDetachedRun();
  if (!isDetachedRun && !options.dryRun && await targetsIncludeInvokingPane(options, deps)) {
    const logPath = await detachedRunDeps.handOverToDetachedRun(args);
    deps.log(`restart-harnesses: continuing in a detached run; read ${logPath}\n`);
    return 0;
  }
  const outcomes = await restartHarnesses(options, deps);
  if (isDetachedRun) deps.log(closingLine(outcomes));
  return outcomes.some((outcome) => outcome.verdict === "failed") ? 1 : 0;
}
