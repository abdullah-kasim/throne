import path from "node:path";
import { resolveRegentQueueDatabasePath } from "../regent-queue/regent-queue-database.ts";
import { openRegentQueueStore, type RegentQueueReadResult } from "../regent-queue/regent-queue.store.ts";
import type { RegentQueueItemRow } from "../regent-queue/regent-queue-row.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";
import { RUNTIME_DATA_DIR } from "../shared-policy/runtime-data-home.ts";
import { parseWorkLogArguments, WORK_LOG_USAGE, type WorkLogArguments } from "./work-log-arguments.ts";
import { GITHUB_ACTION_LOG_FILE_NAME, readGithubActionsInWindow } from "./work-log-github-actions.ts";
import { queueRowsInWindow } from "./work-log-queue-rows.ts";
import { renderWorkLogJson, renderWorkLogText, type WorkLog } from "./work-log-render.ts";
import type { WorkLogWindow } from "./work-log-window.ts";

export const WorkLogExitCode = {
  Listed: 0,
  ReadFailed: 1,
  InvalidInvocation: 2,
} as const;

export interface WorkLogDependencies {
  readonly queueDatabasePath: string;
  readonly githubActionLogPath: string;
  readonly now: () => Date;
  readonly out: (message: string) => void;
  readonly err: (message: string) => void;
}

export const REAL_WORK_LOG_DEPENDENCIES: WorkLogDependencies = {
  queueDatabasePath: resolveRegentQueueDatabasePath(),
  githubActionLogPath: path.join(RUNTIME_DATA_DIR, GITHUB_ACTION_LOG_FILE_NAME),
  now: () => new Date(),
  out: (message) => void process.stdout.write(message),
  err: (message) => void process.stderr.write(message),
};

function queueRowsOf(result: RegentQueueReadResult): RegentQueueItemRow[] {
  if (result.state === "unknown") throw new Error(`the queue store could not be read: ${result.reason}`);
  return result.state === "items" ? result.items : [];
}

function readAllQueueRows(databasePath: string): RegentQueueItemRow[] {
  const store = openRegentQueueStore(databasePath);
  try {
    return queueRowsOf(store.readAll());
  } finally {
    store.close();
  }
}

export async function listWorkLog(
  queueDatabasePath: string,
  githubActionLogPath: string,
  window: WorkLogWindow,
): Promise<WorkLog> {
  return {
    since: new Date(window.since),
    rows: queueRowsInWindow(readAllQueueRows(queueDatabasePath), window),
    githubActions: await readGithubActionsInWindow(githubActionLogPath, window),
  };
}

function renderInvalidInvocation(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `${reason}\n${WORK_LOG_USAGE}\n${renderEntranceRefusal({
    reason: "work-log entrance validation refused this invocation.",
    bypass: undefined,
    supervisorRoute: "Ask your supervisor for an allowed alternative invocation.",
  })}\n`;
}

export async function runWorkLog(
  commandArguments: readonly string[],
  dependencies: WorkLogDependencies = REAL_WORK_LOG_DEPENDENCIES,
): Promise<number> {
  let parsed: WorkLogArguments;
  try {
    parsed = parseWorkLogArguments(commandArguments);
  } catch (error) {
    dependencies.err(renderInvalidInvocation(error));
    return WorkLogExitCode.InvalidInvocation;
  }
  const window = { since: parsed.since.getTime(), until: dependencies.now().getTime() };
  let log: WorkLog;
  try {
    log = await listWorkLog(dependencies.queueDatabasePath, dependencies.githubActionLogPath, window);
  } catch (error) {
    dependencies.err(`work-log: ${error instanceof Error ? error.message : String(error)}\n`);
    return WorkLogExitCode.ReadFailed;
  }
  dependencies.out(`${parsed.json ? renderWorkLogJson(log) : renderWorkLogText(log)}\n`);
  return WorkLogExitCode.Listed;
}
