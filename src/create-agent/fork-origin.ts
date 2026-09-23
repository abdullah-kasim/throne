import { readFile } from "node:fs/promises";
import path from "node:path";
import { readAgentStatusRole } from "../agent-statuses/agent-statuses-registry.ts";
import { DEFAULT_DATA_DIR } from "../agentdata/spawn-data-contracts.ts";
import { readSpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import { resolveAgent } from "../herdr/herdr-runtime.service.ts";
import { readLiveClaudeModel } from "../session/live-claude-model.ts";

export const FORK_PARENT_ROLE = "Stager";
export const FORK_BRIEF_BASENAME = "brief.md";

export interface ForkParentEvidence {
  readonly live: boolean;
  readonly ledgerRole: string;
  readonly ledgerModel?: string;
  readonly liveModel?: string;
}

export type ReadForkParentEvidence = (
  parentName: string,
) => Promise<ForkParentEvidence>;

export type ReadForkBrief = (forkName: string) => Promise<string | undefined>;

export type ForkModelSource =
  | "the --model flag"
  | "the parent's live observed model"
  | "the parent's ledger model";

export interface ForkOrigin {
  readonly parent: string;
  readonly model: string;
  readonly modelSource: ForkModelSource;
}

export function forkBriefPath(
  forkName: string,
  baseDir: string = DEFAULT_DATA_DIR,
): string {
  return path.join(baseDir, forkName, FORK_BRIEF_BASENAME);
}

export async function readForkBriefFile(
  forkName: string,
  baseDir: string = DEFAULT_DATA_DIR,
): Promise<string | undefined> {
  try {
    const text = await readFile(forkBriefPath(forkName, baseDir), "utf8");
    return text.trim() === "" ? undefined : text;
  } catch {
    return undefined;
  }
}

export async function readForkParentEvidenceFromLedger(
  parentName: string,
  baseDir: string = DEFAULT_DATA_DIR,
): Promise<ForkParentEvidence> {
  const liveAgent = await resolveAgent(parentName).catch(() => undefined);
  const ledgerRole = await readAgentStatusRole(parentName, baseDir);
  const spawnSpec = await readSpawnSpec(parentName, baseDir);
  const liveModel =
    liveAgent === undefined ? undefined : await readLiveClaudeModel(liveAgent);
  return {
    live: liveAgent !== undefined,
    ledgerRole,
    ...(spawnSpec?.model === undefined ? {} : { ledgerModel: spawnSpec.model }),
    ...(liveModel === undefined ? {} : { liveModel }),
  };
}

export interface ForkRequest {
  readonly parent: string;
  readonly role: string;
  readonly supervisor: string | undefined;
  readonly composedName: string;
  readonly requestedModel: string | undefined;
}

export type ForkOriginResolution =
  | { readonly ok: true; readonly value: ForkOrigin }
  | { readonly ok: false; readonly reason: string };

function forkNameGuidance(parent: string): string {
  return (
    `pass the fork's full name, which is the parent's name plus a task slug ` +
    `(for example --name ${parent}-prmedia)`
  );
}

export function resolveForkOrigin(
  request: ForkRequest,
  evidence: ForkParentEvidence,
  brief: string | undefined,
  briefPath: string,
): ForkOriginResolution {
  const { parent } = request;
  if (request.role !== FORK_PARENT_ROLE) {
    return {
      ok: false,
      reason:
        `--fork-of is refused for role "${request.role}" — a fork is an ordinary ` +
        `${FORK_PARENT_ROLE} of its parent, so pass --role ${FORK_PARENT_ROLE}`,
    };
  }
  if (request.supervisor !== parent) {
    return {
      ok: false,
      reason:
        `--fork-of ${parent} needs --supervisor ${parent} — a fork answers to the ` +
        `parent it was forked from, and this spawn named ` +
        `"${request.supervisor ?? "(none)"}" instead`,
    };
  }
  if (!evidence.live) {
    return {
      ok: false,
      reason:
        `--fork-of ${parent} is refused — "${parent}" is not live in the roster, ` +
        `and a fork inherits its model and its supervision from a live parent`,
    };
  }
  if (evidence.ledgerRole !== FORK_PARENT_ROLE) {
    return {
      ok: false,
      reason:
        `--fork-of ${parent} is refused — the ledger role of "${parent}" is ` +
        `"${evidence.ledgerRole === "" ? "(unrecorded)" : evidence.ledgerRole}", ` +
        `and only a ${FORK_PARENT_ROLE} may be forked`,
    };
  }
  const name = request.composedName;
  if (!name.startsWith(`${parent}-`)) {
    return {
      ok: false,
      reason:
        `--fork-of ${parent} is refused — the composed name "${name}" does not ` +
        `begin "${parent}-", so the roster would not show whose fork it is; ` +
        `${forkNameGuidance(parent)}`,
    };
  }
  if (brief === undefined) {
    return {
      ok: false,
      reason:
        `--fork-of ${parent} is refused — a forked pane inherits no ` +
        `conversation, so "${name}" needs its brief at ${briefPath}. Write the ` +
        `brief in the four-marker shape (INTENT, SCOPE, RULINGS, ` +
        `VERIFIED-NOUNS), check it with \`throne lint-queue-plan --body-file ` +
        `${briefPath}\`, then re-run`,
    };
  }
  const model =
    request.requestedModel ?? evidence.liveModel ?? evidence.ledgerModel;
  if (model === undefined) {
    return {
      ok: false,
      reason:
        `--fork-of ${parent} is refused — no model could be resolved: no ` +
        `--model was given, "${parent}" has no live observed model, and its ` +
        `ledger records none`,
    };
  }
  const modelSource: ForkModelSource =
    request.requestedModel !== undefined
      ? "the --model flag"
      : evidence.liveModel !== undefined
        ? "the parent's live observed model"
        : "the parent's ledger model";
  return { ok: true, value: { parent, model, modelSource } };
}
