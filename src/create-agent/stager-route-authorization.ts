import { readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_DATA_DIR } from "../agentdata/spawn-data-contracts.ts";
import { HARNESS_NAMES, type Harness } from "../harness-routing/harness.ts";

const AUTHORIZATION_FILE = "stager-route-authorizations.json";
const AUTHORIZED_HARNESS = HARNESS_NAMES.CODEX;
const AUTHORIZED_MODEL = "gpt-5.6-sol";

export interface StagerRouteAuthorizationEvidence {
  authorizer: "Lord";
  recipient: string;
  harness: Harness;
  model: string;
  evidence_locator: string;
}

interface StagerRouteAuthorizationEntry extends StagerRouteAuthorizationEvidence {
  expires_at: string;
}

export interface StagerRouteAuthorizationRegistry {
  version: 1;
  authorizations: StagerRouteAuthorizationEntry[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isAuthorizationEntry(value: unknown): value is StagerRouteAuthorizationEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    entry.authorizer === "Lord" &&
    isNonEmptyString(entry.recipient) &&
    isNonEmptyString(entry.harness) &&
    isNonEmptyString(entry.model) &&
    isNonEmptyString(entry.evidence_locator) &&
    isNonEmptyString(entry.expires_at) &&
    Number.isFinite(Date.parse(entry.expires_at)) &&
    Object.keys(entry).every((key) =>
      ["authorizer", "recipient", "harness", "model", "evidence_locator", "expires_at"].includes(key),
    )
  );
}

function isAuthorizationRegistry(value: unknown): value is StagerRouteAuthorizationRegistry {
  if (typeof value !== "object" || value === null) return false;
  const registry = value as Record<string, unknown>;
  return (
    registry.version === 1 &&
    Array.isArray(registry.authorizations) &&
    registry.authorizations.every(isAuthorizationEntry) &&
    Object.keys(registry).every((key) => ["version", "authorizations"].includes(key))
  );
}

export async function readStagerRouteAuthorizationRegistry(
  dataDir: string = DEFAULT_DATA_DIR,
): Promise<StagerRouteAuthorizationRegistry> {
  const raw = await readFile(path.join(dataDir, "regent", AUTHORIZATION_FILE), "utf8");
  return JSON.parse(raw) as StagerRouteAuthorizationRegistry;
}

export function resolveStagerRouteAuthorization(opts: {
  registry: unknown;
  recipient: string;
  harness: Harness;
  model: string;
  now: string;
}): StagerRouteAuthorizationEvidence | undefined {
  if (!isAuthorizationRegistry(opts.registry)) return undefined;
  if (
    opts.harness !== AUTHORIZED_HARNESS ||
    opts.model !== AUTHORIZED_MODEL
  ) return undefined;
  const matches = opts.registry.authorizations.filter(
    (entry) =>
      entry.recipient === opts.recipient &&
      entry.harness === AUTHORIZED_HARNESS &&
      entry.model === AUTHORIZED_MODEL,
  );
  if (matches.length !== 1) return undefined;
  const match = matches[0]!;
  if (Date.parse(match.expires_at) <= Date.parse(opts.now)) return undefined;
  const { expires_at: _expiresAt, ...evidence } = match;
  return evidence;
}
