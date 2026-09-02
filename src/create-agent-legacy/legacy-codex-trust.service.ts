import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readVisibleAgentText } from "../herdr/herdr-screen.service.ts";

export const TRUST_PROMPT_MARKER =
  "Do you trust the contents of this directory?";
export const TRUST_PROBE_TIMEOUT_MS = 1_000;
export const TRUST_PROBE_POLL_MS = 100;

export function codexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME;
  return path.join(
    home !== undefined && home !== ""
      ? home
      : path.join(os.homedir(), ".codex"),
    "config.toml",
  );
}

export function resolveTrustKey(cwd: string): string {
  return fs.realpathSync(cwd);
}

function quote(value: string): string {
  return `"${[...value]
    .map((ch) => {
      if (ch === "\\") return "\\\\";
      if (ch === '"') return '\\"';
      if (ch === "\n") return "\\n";
      if (ch === "\r") return "\\r";
      if (ch === "\t") return "\\t";
      const code = ch.codePointAt(0)!;
      return code < 0x20 || code === 0x7f
        ? `\\u${code.toString(16).padStart(4, "0")}`
        : ch;
    })
    .join("")}"`;
}

function unquote(value: string): string {
  return value.replace(
    /\\(u[0-9a-f]{4}|U[0-9a-f]{8}|.)/gi,
    (_match, escape: string) => {
      const codes: Record<string, string> = {
        b: "\b",
        t: "\t",
        n: "\n",
        f: "\f",
        r: "\r",
        '"': '"',
        "\\": "\\",
      };
      return escape[0] === "u" || escape[0] === "U"
        ? String.fromCodePoint(Number.parseInt(escape.slice(1), 16))
        : (codes[escape] ?? escape);
    },
  );
}

const HEADER =
  /^\s*\[\s*projects\s*\.\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*\]\s*(?:#.*)?$/;
function headerKey(line: string): string | null {
  const match = HEADER.exec(line);
  return match === null
    ? null
    : match[1] !== undefined
      ? unquote(match[1])
      : (match[2] ?? "");
}

export function isPathTrusted(
  configText: string,
  resolvedPath: string,
): boolean {
  let matching = false;
  for (const line of configText.split(/\r?\n/)) {
    const key = headerKey(line);
    if (key !== null) {
      matching = key === resolvedPath;
      continue;
    }
    if (/^\s*\[/.test(line)) {
      matching = false;
      continue;
    }
    if (
      matching &&
      /^\s*trust_level\s*=\s*(?:"trusted"|'trusted')\s*(?:#.*)?$/.test(line)
    )
      return true;
  }
  return false;
}

function hasProjectBlock(configText: string, resolvedPath: string): boolean {
  return configText
    .split(/\r?\n/)
    .some((line) => headerKey(line) === resolvedPath);
}

export function appendTrustEntry(
  configText: string,
  resolvedPath: string,
): string {
  const block = `[projects.${quote(resolvedPath)}]\ntrust_level = "trusted"\n`;
  if (configText === "") return block;
  return (
    configText +
    (configText.endsWith("\n\n")
      ? ""
      : configText.endsWith("\n")
        ? "\n"
        : "\n\n") +
    block
  );
}

export interface EnsureCodexTrustDeps {
  readConfig: (configPath: string) => string | Promise<string>;
  writeConfig: (configPath: string, text: string) => void | Promise<void>;
  realpath: (cwd: string) => string;
  configPath: string;
}

function readConfig(configPath: string): string {
  try {
    return fs.readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function writeConfig(configPath: string, text: string): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, text, "utf8");
}

export async function ensureCodexTrust(
  cwd: string,
  deps: Partial<EnsureCodexTrustDeps> = {},
): Promise<void> {
  const realpath = deps.realpath ?? resolveTrustKey;
  const configPath = deps.configPath ?? codexConfigPath();
  const text = await (deps.readConfig ?? readConfig)(configPath);
  const key = realpath(cwd);
  if (isPathTrusted(text, key)) return;
  if (hasProjectBlock(text, key))
    throw new Error(
      `codex config ${configPath} already has a [projects.${quote(key)}] entry whose trust_level is not "trusted". Refusing to append a duplicate table (duplicate tables are invalid TOML and would break codex entirely). Edit that entry to trust_level = "trusted" (or remove it) and retry.`,
    );
  await (deps.writeConfig ?? writeConfig)(
    configPath,
    appendTrustEntry(text, key),
  );
}

export function isTrustPromptText(text: string): boolean {
  return text.replace(/\s+/g, " ").includes(TRUST_PROMPT_MARKER);
}

export interface ProbeCodexTrustPromptDeps {
  readVisibleAgentText: (target: string) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export async function probeCodexTrustPrompt(
  target: string,
  deps: Partial<ProbeCodexTrustPromptDeps> = {},
): Promise<boolean> {
  const read = deps.readVisibleAgentText ?? readVisibleAgentText;
  const sleep = deps.sleep ?? ((ms: number) => delay(ms));
  const now = deps.now ?? Date.now;
  const deadline = now() + TRUST_PROBE_TIMEOUT_MS;
  for (;;) {
    try {
      if (isTrustPromptText(await read(target))) return true;
    } catch {
      /* keep polling through transient pane failures */
    }
    if (now() >= deadline) return false;
    await sleep(TRUST_PROBE_POLL_MS);
  }
}

export class CodexTrustService {
  readonly codexConfigPath = codexConfigPath;
  readonly resolveTrustKey = resolveTrustKey;
  readonly isPathTrusted = isPathTrusted;
  readonly appendTrustEntry = appendTrustEntry;
  readonly ensureCodexTrust = ensureCodexTrust;
  readonly isTrustPromptText = isTrustPromptText;
  readonly probeCodexTrustPrompt = probeCodexTrustPrompt;
}
