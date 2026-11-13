import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { LedgerDataService } from "./ledger-data.service.ts";

const ledgerData = new LedgerDataService();

export const AGENT_STATES = [
  "working",
  "blocked",
  "waiting-on-own-run",
  "waiting-on-supervisor",
  "reapable",
] as const;

export type AgentStateName = (typeof AGENT_STATES)[number];

export type AgentStateWriter = "agent" | "regent" | "turn-start";

export interface AgentState {
  state: AgentStateName;
  blockedBy: readonly string[];
  waitingOn: string | null;
  reapableReason: string | null;
  declaredAt: string;
  declaredBy: AgentStateWriter;
}

export interface AgentStateDeclaration {
  state: AgentStateName;
  blockedBy?: readonly string[];
  waitingOn?: string | null;
  reapableReason?: string | null;
  declaredBy: AgentStateWriter;
}

interface OldBlockedFile {
  blockedAt: string;
  reason?: string;
  origin?: "agent" | "regent";
  blockedBy?: readonly string[];
}

const STATE_FILE_NAME = "state.json";
const OLD_BLOCKED_FILE_NAME = "blocked.json";

function agentFolder(name: string, baseDir?: string): string {
  return baseDir === undefined ? ledgerData.agentDir(name) : path.join(baseDir, name);
}

export function isAgentStateName(value: unknown): value is AgentStateName {
  return typeof value === "string" && (AGENT_STATES as readonly string[]).includes(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isTextOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isAgentState(value: unknown): value is AgentState {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    isAgentStateName(record.state) &&
    isStringList(record.blockedBy) &&
    isTextOrNull(record.waitingOn) &&
    isTextOrNull(record.reapableReason) &&
    typeof record.declaredAt === "string" &&
    (record.declaredBy === "agent" || record.declaredBy === "regent" || record.declaredBy === "turn-start")
  );
}

function isOldBlockedMarker(value: unknown): value is OldBlockedFile {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.blockedAt !== "string") return false;
  if (record.reason !== undefined && typeof record.reason !== "string") return false;
  if (record.origin !== undefined && record.origin !== "agent" && record.origin !== "regent") return false;
  return record.blockedBy === undefined || isStringList(record.blockedBy);
}

function workingSince(declaredAt: string): AgentState {
  return {
    state: "working",
    blockedBy: [],
    waitingOn: null,
    reapableReason: null,
    declaredAt,
    declaredBy: "turn-start",
  };
}

async function readJson(filePath: string): Promise<{ found: false } | { found: true; value: unknown }> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch {
    return { found: false };
  }
  try {
    return { found: true, value: JSON.parse(contents) };
  } catch {
    return { found: true, value: undefined };
  }
}

async function writeStateFile(folder: string, state: AgentState): Promise<void> {
  const finalPath = path.join(folder, STATE_FILE_NAME);
  const temporaryPath = `${finalPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, "utf8");
  await rename(temporaryPath, finalPath);
}

async function convertOldBlockedFile(folder: string): Promise<AgentState | null> {
  const oldPath = path.join(folder, OLD_BLOCKED_FILE_NAME);
  const old = await readJson(oldPath);
  if (!old.found) return null;
  if (!isOldBlockedMarker(old.value)) {
    await rm(oldPath, { force: true });
    return null;
  }
  const converted: AgentState = {
    state: "blocked",
    blockedBy: old.value.blockedBy ?? [],
    waitingOn: old.value.reason ?? null,
    reapableReason: null,
    declaredAt: old.value.blockedAt,
    declaredBy: old.value.origin ?? "agent",
  };
  await writeStateFile(folder, converted);
  await rm(oldPath, { force: true });
  return converted;
}

export async function readAgentState(name: string, baseDir?: string): Promise<AgentState> {
  const folder = agentFolder(name, baseDir);
  const stored = await readJson(path.join(folder, STATE_FILE_NAME));
  if (stored.found) {
    if (isAgentState(stored.value)) return stored.value;
    process.stderr.write(`agent state: ${name}'s ${STATE_FILE_NAME} is unreadable; treating it as working\n`);
    return workingSince(new Date(0).toISOString());
  }
  return (await convertOldBlockedFile(folder)) ?? workingSince(new Date(0).toISOString());
}

export async function declareAgentState(
  name: string,
  declaration: AgentStateDeclaration,
  baseDir?: string,
): Promise<AgentState> {
  if (!isAgentStateName(declaration.state)) {
    throw new Error(`unknown agent state "${String(declaration.state)}"; expected one of ${AGENT_STATES.join(", ")}`);
  }
  const state: AgentState = {
    state: declaration.state,
    blockedBy: declaration.state === "blocked" ? [...(declaration.blockedBy ?? [])] : [],
    waitingOn: declaration.waitingOn ?? null,
    reapableReason: declaration.state === "reapable" ? declaration.reapableReason ?? null : null,
    declaredAt: new Date().toISOString(),
    declaredBy: declaration.declaredBy,
  };
  await writeStateFile(agentFolder(name, baseDir), state);
  return state;
}

export async function clearBlockedState(name: string, baseDir?: string): Promise<void> {
  const current = await readAgentState(name, baseDir);
  if (current.state !== "blocked") return;
  await declareAgentState(name, { state: "working", declaredBy: "agent" }, baseDir);
}
