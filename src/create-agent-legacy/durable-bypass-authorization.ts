import { readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_DATA_DIR } from "./legacy-spawn-data-contracts.ts";

const AUTHORIZATION_VERSION = 1;
const KNOWN_AUTHORIZERS = new Set(["Lord", "Regent"]);

export interface DurableBypassAuthorizationEvidence {
  authorizer: "Lord" | "Regent";
  objective_code: string;
  recipient: string;
  evidence_locator: string;
}

interface DurableBypassAuthorizationEntry extends DurableBypassAuthorizationEvidence {
  expires_at: string;
}

export interface DurableBypassAuthorizationRegistry {
  version: 1;
  authorizations: DurableBypassAuthorizationEntry[];
}

export type DurableBypassAuthorizationResolution =
  | { kind: "authorized"; evidence: DurableBypassAuthorizationEvidence }
  | { kind: "refuse"; reason: string };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isAuthorizationEntry(
  value: unknown,
): value is DurableBypassAuthorizationEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    KNOWN_AUTHORIZERS.has(entry.authorizer as string) &&
    isNonEmptyString(entry.objective_code) &&
    isNonEmptyString(entry.recipient) &&
    isNonEmptyString(entry.evidence_locator) &&
    isNonEmptyString(entry.expires_at) &&
    Number.isFinite(Date.parse(entry.expires_at)) &&
    Object.keys(entry).every((key) =>
      [
        "authorizer",
        "objective_code",
        "recipient",
        "evidence_locator",
        "expires_at",
      ].includes(key),
    )
  );
}

function isAuthorizationRegistry(
  value: unknown,
): value is DurableBypassAuthorizationRegistry {
  if (typeof value !== "object" || value === null) return false;
  const registry = value as Record<string, unknown>;
  return (
    registry.version === AUTHORIZATION_VERSION &&
    Array.isArray(registry.authorizations) &&
    registry.authorizations.every(isAuthorizationEntry) &&
    Object.keys(registry).every((key) =>
      ["version", "authorizations"].includes(key),
    )
  );
}

export async function readDurableBypassAuthorizationRegistry(
  registryFileName: string,
  dataDir: string = DEFAULT_DATA_DIR,
): Promise<DurableBypassAuthorizationRegistry> {
  const raw = await readFile(
    path.join(dataDir, "regent", registryFileName),
    "utf8",
  );
  return JSON.parse(raw) as DurableBypassAuthorizationRegistry;
}

export function resolveDurableBypassAuthorization(opts: {
  registry: unknown;
  registryLabel: string;
  flagLabel: string;
  allowedAuthorizers: ReadonlySet<string>;
  objectiveCode: string | undefined;
  recipient: string;
  now: string;
}): DurableBypassAuthorizationResolution {
  if (!isAuthorizationRegistry(opts.registry)) {
    return {
      kind: "refuse",
      reason: `the ${opts.registryLabel} record is missing or malformed`,
    };
  }
  if (opts.objectiveCode === undefined) {
    return {
      kind: "refuse",
      reason: `${opts.flagLabel} requires an exact campaign objective and recipient authorization`,
    };
  }
  const matches = opts.registry.authorizations.filter(
    (entry) =>
      entry.objective_code === opts.objectiveCode &&
      entry.recipient === opts.recipient &&
      opts.allowedAuthorizers.has(entry.authorizer),
  );
  const authorizerNames = [...opts.allowedAuthorizers].sort().join(" or ");
  if (matches.length !== 1) {
    return {
      kind: "refuse",
      reason:
        matches.length === 0
          ? `no durable ${authorizerNames} authorization covers objective "${opts.objectiveCode}" recipient "${opts.recipient}" ` +
            `in the ${opts.registryLabel} record under <throne data home>/regent/. ` +
            `Authorization originates with the Lord and is relayed by the Regent; no agent may self-authorize. ` +
            `A Lord instruction scoping a route to a campaign is itself that authorization for its whole scope — ` +
            `record it as the evidence_locator rather than seeking per-spawn approval`
          : `multiple durable authorizations ambiguously cover objective "${opts.objectiveCode}" recipient "${opts.recipient}" ` +
            `in the ${opts.registryLabel} record; exactly one entry must match`,
    };
  }
  const match = matches[0]!;
  if (Date.parse(match.expires_at) <= Date.parse(opts.now)) {
    return {
      kind: "refuse",
      reason: `the durable ${opts.flagLabel} authorization for "${opts.recipient}" expired at ${match.expires_at}`,
    };
  }
  return {
    kind: "authorized",
    evidence: {
      authorizer: match.authorizer,
      objective_code: match.objective_code,
      recipient: match.recipient,
      evidence_locator: match.evidence_locator,
    },
  };
}
