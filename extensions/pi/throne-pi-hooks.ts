import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { messageText } from "./throne-pi-state.ts";

export const HARNESS_VARIABLE = "THRONE_HOOK_HARNESS";
export const BRIDGE_LOG_NAME = "pi-hook-bridge.log";
const HOOK_TIMEOUT_MILLISECONDS = 30_000;
const BLOCKING_EXIT_CODE = 2;

export interface HookListEntry {
  script: string;
  event: string;
  matcher?: string;
  notOn?: string[];
  withGlobalMemoryDirectories?: boolean;
}

export interface HookRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  failure?: string;
}

export type PiAnswer = { block: true; reason: string } | { appendedText: string } | undefined;

export interface BridgeOptions {
  throneRoot: string;
  hookList: readonly HookListEntry[];
  scriptArguments: (entry: HookListEntry) => readonly string[];
  log: (line: string) => void;
  runScript?: (scriptPath: string, scriptArguments: readonly string[], input: string) => Promise<HookRun>;
}

const PI_EVENT_OF_CLAUDE_EVENT: Record<string, string> = {
  PreToolUse: "tool_call",
  PostToolUse: "tool_result",
  SessionStart: "session_start",
  SessionEnd: "session_shutdown",
  UserPromptSubmit: "before_agent_start",
};

const CLAUDE_TOOL_OF_PI_TOOL: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  grep: "Grep",
  find: "Glob",
};

function throneRootOfExtension(): string {
  const extensionFile = realpathSync(fileURLToPath(import.meta.url));
  return path.dirname(path.dirname(path.dirname(extensionFile)));
}

export function claudeToolName(piToolName: string): string {
  return CLAUDE_TOOL_OF_PI_TOOL[piToolName] ?? piToolName;
}

export function claudeToolInput(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null) return {};
  const copy: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  if (typeof copy.path === "string" && copy.file_path === undefined) copy.file_path = copy.path;
  return copy;
}

function claudeToolResponse(toolName: string, content: unknown): unknown {
  const text = messageText(content);
  if (toolName === "Bash") return { stdout: text, stderr: "" };
  if (toolName === "Read") return { file: { content: text } };
  return text;
}

export function matcherAccepts(matcher: string | undefined, toolName: string | undefined): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*" || toolName === undefined) return true;
  return new RegExp(`^(?:${matcher})$`).test(toolName);
}

export function piAnswerFromHook(run: HookRun): PiAnswer {
  let output: any;
  try {
    output = JSON.parse(run.stdout);
  } catch {
    output = undefined;
  }
  const specific = output?.hookSpecificOutput;
  if (run.exitCode === BLOCKING_EXIT_CODE) return { block: true, reason: run.stderr.trim() || "blocked by a throne hook" };
  if (specific?.permissionDecision === "deny") return { block: true, reason: String(specific.permissionDecisionReason ?? "") };
  if (output?.decision === "block") return { block: true, reason: String(output.reason ?? "") };
  if (typeof specific?.additionalContext === "string" && specific.additionalContext !== "") {
    return { appendedText: specific.additionalContext };
  }
  return undefined;
}

function runPythonScript(scriptPath: string, scriptArguments: readonly string[], input: string): Promise<HookRun> {
  return new Promise((resolve) => {
    const child = spawn("python3", [scriptPath, ...scriptArguments], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, [HARNESS_VARIABLE]: "pi" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), HOOK_TIMEOUT_MILLISECONDS);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr, failure: error.message });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

export function createHookBridge(options: BridgeOptions) {
  const runScript = options.runScript ?? runPythonScript;
  const piEntries = options.hookList.filter((entry) => !(entry.notOn ?? []).includes("pi"));
  for (const entry of piEntries) {
    if (PI_EVENT_OF_CLAUDE_EVENT[entry.event] === undefined) {
      options.log(`${entry.script}: ${entry.event} has no pi event, so it does not run on pi`);
    }
  }

  return async function runHooks(piEvent: string, payload: Record<string, unknown>): Promise<PiAnswer[]> {
    const answers: PiAnswer[] = [];
    for (const entry of piEntries) {
      if (PI_EVENT_OF_CLAUDE_EVENT[entry.event] !== piEvent) continue;
      if (!matcherAccepts(entry.matcher, payload.tool_name as string | undefined)) continue;
      const scriptPath = path.join(options.throneRoot, "claude-hooks", entry.script);
      if (!existsSync(scriptPath)) {
        options.log(`${entry.script}: script is missing, so the call went through`);
        continue;
      }
      const input = JSON.stringify({ ...payload, hook_event_name: entry.event });
      const run = await runScript(scriptPath, options.scriptArguments(entry), input);
      if (run.failure !== undefined || (run.exitCode !== 0 && run.exitCode !== BLOCKING_EXIT_CODE)) {
        options.log(`${entry.script}: crashed (${run.failure ?? `exit ${run.exitCode}`}), so the call went through`);
        continue;
      }
      const answer = piAnswerFromHook(run);
      answers.push(answer);
      if (answer !== undefined && "block" in answer) break;
    }
    return answers;
  };
}

function readHookList(throneRoot: string): HookListEntry[] {
  return JSON.parse(readFileSync(path.join(throneRoot, "claude-hooks", "hooks.json"), "utf8")) as HookListEntry[];
}

async function globalMemoryDirectories(throneRoot: string): Promise<readonly string[]> {
  try {
    const recall = await import(path.join(throneRoot, "src", "relevance-classifier", "recall-user-config.ts"));
    const loader = await import(path.join(throneRoot, "src", "user-config-loader.ts"));
    return (await recall.loadRecallConfig(loader.userConfigPath(throneRoot))).globalMemoryDirectories;
  } catch {
    return [];
  }
}

function bridgeLog(): (line: string) => void {
  const agentDirectory = process.env.PI_CODING_AGENT_DIR;
  if (!agentDirectory) return () => undefined;
  const logPath = path.join(path.dirname(agentDirectory), BRIDGE_LOG_NAME);
  return (line) => {
    try {
      appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
    } catch {}
  };
}

function sessionPayload(context: any): Record<string, unknown> {
  return { cwd: context?.cwd ?? process.cwd(), session_id: context?.sessionManager?.getSessionId?.() ?? "" };
}

export default async function throneHooksExtension(pi: any) {
  const log = bridgeLog();
  const throneRoot = throneRootOfExtension();
  let hookList: HookListEntry[];
  try {
    hookList = readHookList(throneRoot);
  } catch (error) {
    log(`hooks.json could not be read, so no throne hook runs: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const memoryDirectories = await globalMemoryDirectories(throneRoot);
  const runHooks = createHookBridge({
    throneRoot,
    hookList,
    log,
    scriptArguments: (entry) => (entry.withGlobalMemoryDirectories === true ? memoryDirectories : []),
  });

  pi.on("session_start", (_event: unknown, context: any) => runHooks("session_start", sessionPayload(context)).then(() => undefined));
  pi.on("session_shutdown", (_event: unknown, context: any) => runHooks("session_shutdown", sessionPayload(context)).then(() => undefined));
  pi.on("before_agent_start", async (event: any, context: any) => {
    if (event.messageType !== "user") return undefined;
    const answers = await runHooks("before_agent_start", { ...sessionPayload(context), prompt: event.prompt ?? "" });
    const notes = answers.flatMap((answer) => (answer !== undefined && "appendedText" in answer ? [answer.appendedText] : []));
    if (notes.length === 0) return undefined;
    return { message: { customType: "throne-hooks", content: notes.join("\n"), display: true } };
  });
  pi.on("tool_call", async (event: any, context: any) => {
    const answers = await runHooks("tool_call", {
      ...sessionPayload(context),
      tool_name: claudeToolName(event.toolName),
      tool_input: claudeToolInput(event.input),
    });
    return answers.find((answer) => answer !== undefined && "block" in answer);
  });
  pi.on("tool_result", async (event: any, context: any) => {
    const toolName = claudeToolName(event.toolName);
    const answers = await runHooks("tool_result", {
      ...sessionPayload(context),
      tool_name: toolName,
      tool_input: claudeToolInput(event.input),
      tool_response: claudeToolResponse(toolName, event.content),
    });
    const notes = answers.flatMap((answer) => {
      if (answer === undefined) return [];
      return ["block" in answer ? answer.reason : answer.appendedText];
    });
    if (notes.length === 0) return undefined;
    return { content: [...(Array.isArray(event.content) ? event.content : []), { type: "text", text: notes.join("\n") }] };
  });
}
