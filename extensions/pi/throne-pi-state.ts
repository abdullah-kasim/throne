import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installAgentLook } from "./throne-pi-agent-look.ts";

export const THRONE_CLI_VARIABLE = "THRONE_AGENT_STATE_CLI";
const MY_STATE_TIMEOUT_MILLISECONDS = 30_000;

type SessionEntry = { type?: string; message?: { role?: string; content?: unknown } };

function throneCliPath(): string {
  const configured = process.env[THRONE_CLI_VARIABLE]?.trim();
  if (configured) return configured;
  const extensionFile = realpathSync(fileURLToPath(import.meta.url));
  return path.join(path.dirname(path.dirname(path.dirname(extensionFile))), "bin", "throne-cli");
}

function runMyState(option: string, input: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(throneCliPath(), ["my-state", option], { stdio: ["pipe", "ignore", "ignore"], env: process.env });
    const timer = setTimeout(() => child.kill(), MY_STATE_TIMEOUT_MILLISECONDS);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    child.on("error", finish);
    child.on("close", finish);
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => typeof part === "object" && part !== null && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

export function lastAssistantText(entries: readonly SessionEntry[]): string {
  let last = "";
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (entry.message?.role === "user") last = "";
    if (entry.message?.role !== "assistant") continue;
    const text = messageText(entry.message?.content);
    if (text.trim() !== "") last = text;
  }
  return last;
}

export default function throneStateExtension(pi: any) {
  let pending: Promise<void> = Promise.resolve();
  const inOrder = (work: () => Promise<void>) => {
    pending = pending.then(work, work);
    return pending;
  };
  installAgentLook(pi, async () => (await import("@earendil-works/pi-coding-agent")).CustomEditor);
  pi.on("agent_start", () => inOrder(() => runMyState("--turn-start", "")));
  pi.on("agent_settled", (_event: unknown, context: any) => {
    const message = lastAssistantText(context.sessionManager.getBranch());
    if (message.trim() === "") return;
    inOrder(() => runMyState("--turn-end", message));
  });
}
