import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { VENDORED_HARNESS_BINARY_DIRECTORY } from "../herdr/herdr-launch-command.ts";

const execFileAsync = promisify(execFile);

export interface ClaudeSessionEntry {
  pid: number;
  sessionId: string;
  kind: string;
  hostPid?: number;
}

async function parentProcessId(pid: number): Promise<number | undefined> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const parent = /^PPid:\s+(\d+)$/m.exec(status)?.[1];
    return parent === undefined ? undefined : Number(parent);
  } catch {
    return undefined;
  }
}

async function commandLine(pid: number): Promise<string[]> {
  try {
    return (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter((part) => part !== "");
  } catch {
    return [];
  }
}

async function processExists(pid: number): Promise<boolean> {
  return (await commandLine(pid)).length > 0;
}

export function isSessionHostArgv(argv: string[]): boolean {
  return argv.includes("bg-pty-host");
}

async function sessionHostOf(pid: number): Promise<number | undefined> {
  const parent = await parentProcessId(pid);
  if (parent === undefined) return undefined;
  return isSessionHostArgv(await commandLine(parent)) ? parent : undefined;
}

export async function listClaudeSessions(): Promise<ClaudeSessionEntry[]> {
  const { stdout } = await execFileAsync(path.join(VENDORED_HARNESS_BINARY_DIRECTORY, "claude"), ["agents", "--json"]);
  const listed = JSON.parse(stdout) as { pid?: unknown; sessionId?: unknown; kind?: unknown }[];
  const sessions: ClaudeSessionEntry[] = [];
  for (const entry of listed) {
    if (typeof entry.pid !== "number" || typeof entry.sessionId !== "string") continue;
    if (!(await processExists(entry.pid))) continue;
    const hostPid = await sessionHostOf(entry.pid);
    sessions.push({
      pid: entry.pid,
      sessionId: entry.sessionId,
      kind: typeof entry.kind === "string" ? entry.kind : "unknown",
      ...(hostPid === undefined ? {} : { hostPid }),
    });
  }
  return sessions;
}
