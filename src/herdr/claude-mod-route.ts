import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readSpawnSpec, writeSpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import { agentAlive } from "./delivery-request-client.ts";
import type { AliveAnswer } from "../../extensions/shared/agent-delivery-contract.ts";
import { RUNTIME_THRONE_ROOT } from "../shared-policy/runtime-throne-root.ts";
import { throneCacheDirectory } from "../shared-policy/throne-home.ts";

export const CLAUDE_MOD_FOLDER = path.join(RUNTIME_THRONE_ROOT, "extensions", "claude");
const VALIDATE_TIMEOUT_MS = 30_000;

export type ClaudeModLaunchDecision =
  | { readonly load: true }
  | { readonly load: false; readonly misfit: string };

export interface ClaudeModLaunchDeps {
  decide: () => ClaudeModLaunchDecision;
  record: (agentName: string, launchedWithMod: boolean) => Promise<void>;
  warn: (line: string) => void;
}

export interface ClaudeModDeliveryDeps {
  usesMod: (recipientName: string) => Promise<boolean>;
  socketOf: (recipientName: string) => Promise<string | undefined>;
  alive: (socketPath: string | undefined, recipientPaneId: string) => Promise<AliveAnswer | undefined>;
  log: (line: string) => void;
}

export function claudeModMisfit(
  claudeBinary: string,
  folder: string = CLAUDE_MOD_FOLDER,
): string | undefined {
  if (!existsSync(folder)) return `the mod folder ${folder} is missing`;
  const result = spawnSync(claudeBinary, ["plugin", "validate", folder], {
    encoding: "utf8",
    timeout: VALIDATE_TIMEOUT_MS,
  });
  if (result.status === 0) return undefined;
  const lines = `${result.stdout ?? ""}${result.stderr ?? ""}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const errorHeading = lines.findIndex((line) => /^✘ Found \d+ errors?:$/u.test(line));
  const firstError = errorHeading === -1 ? lines.at(-1) : lines[errorHeading + 1];
  return `claude plugin validate failed: ${firstError ?? result.error?.message ?? `exit ${String(result.status)}`}`;
}

function claudeCodeVersion(claudeBinary: string): string | undefined {
  try {
    const packageFile = path.join(path.dirname(path.dirname(realpathSync(claudeBinary))), "package.json");
    const manifest = JSON.parse(readFileSync(packageFile, "utf8")) as { name?: string; version?: string };
    return manifest.name === "@anthropic-ai/claude-code" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

function modFingerprint(folder: string): string {
  const hash = createHash("sha256");
  const files = readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(folder, path.join(entry.parentPath, entry.name)))
    .sort();
  for (const file of files) hash.update(file).update("\0").update(readFileSync(path.join(folder, file))).update("\0");
  return hash.digest("hex");
}

export function claudeModMisfitRemembered(
  claudeBinary: string,
  folder: string = CLAUDE_MOD_FOLDER,
  fitFile: string = path.join(throneCacheDirectory(), "claude-mod-fit.txt"),
): string | undefined {
  const version = existsSync(folder) ? claudeCodeVersion(claudeBinary) : undefined;
  if (version === undefined) return claudeModMisfit(claudeBinary, folder);
  const fitKey = `${version} ${modFingerprint(folder)}`;
  if (existsSync(fitFile) && readFileSync(fitFile, "utf8") === fitKey) return undefined;
  const misfit = claudeModMisfit(claudeBinary, folder);
  if (misfit === undefined) {
    mkdirSync(path.dirname(fitFile), { recursive: true });
    writeFileSync(fitFile, fitKey);
  }
  return misfit;
}

export function decideClaudeModLaunch(misfit: () => string | undefined): ClaudeModLaunchDecision {
  const reason = misfit();
  return reason === undefined ? { load: true } : { load: false, misfit: reason };
}

export function claudeModMisfitLine(agentName: string, reason: string): string {
  return `throne: the Claude mod does not fit this Claude Code version, so "${agentName}" launches without it and takes typed keys (${reason})\n`;
}

export function claudeModFallbackLine(agentName: string, reason: string): string {
  return `throne: the Claude mod of "${agentName}" is not answering (${reason}), so the message goes by typed keys\n`;
}

export async function recordClaudeModInSpawn(
  agentName: string,
  launchedWithMod: boolean,
): Promise<void> {
  const spec = await readSpawnSpec(agentName);
  if (spec === null) return;
  await writeSpawnSpec(agentName, { ...spec, claude_mod: launchedWithMod });
}

export function realClaudeModLaunchDeps(vendoredBinaryDirectory: string): ClaudeModLaunchDeps {
  return {
    decide: () =>
      decideClaudeModLaunch(() => claudeModMisfitRemembered(path.join(vendoredBinaryDirectory, "claude"))),
    record: recordClaudeModInSpawn,
    warn: (line) => process.stderr.write(line),
  };
}

export const REAL_CLAUDE_MOD_DELIVERY_DEPS: ClaudeModDeliveryDeps = {
  usesMod: async (recipientName) => (await readSpawnSpec(recipientName))?.claude_mod === true,
  socketOf: async (recipientName) => (await readSpawnSpec(recipientName))?.delivery_socket,
  alive: agentAlive,
  log: (line) => process.stderr.write(line),
};
