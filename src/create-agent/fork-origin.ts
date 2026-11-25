import { readFile } from "node:fs/promises";
import path from "node:path";
import { readAgentStatusRole } from "../agent-statuses/agent-statuses-registry.ts";
import { DEFAULT_DATA_DIR } from "../agentdata/spawn-data-contracts.ts";
import { readSpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import { resolveAgent } from "../herdr/herdr-runtime.service.ts";
import { readLiveClaudeModel } from "../session/live-claude-model.ts";
import { claudeProjectsFolderOf } from "../account/agent-account.ts";
import { readLatestTopicVerdict, topicChanged } from "./drift-prompt.ts";
import { REGENT_NAME } from "../regent-state/regent-liveness.ts";

export const FORK_ORIGIN_ROLE = "Stager";
export const FORK_BRIEF_BASENAME = "brief.md";

export interface ForkOriginEvidence {
  readonly live: boolean;
  readonly ledgerRole: string;
  readonly ledgerModel?: string;
  readonly liveModel?: string;
  readonly topicChanged: boolean;
}

export type ReadForkOriginEvidence = (
  originName: string,
) => Promise<ForkOriginEvidence>;

export type ReadForkBrief = (forkName: string) => Promise<string | undefined>;

export type ForkModelSource =
  | "the --model flag"
  | "the origin's live observed model"
  | "the origin's ledger model";

export interface ForkOrigin {
  readonly origin: string;
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

export async function readForkOriginEvidenceFromLedger(
  originName: string,
  baseDir: string = DEFAULT_DATA_DIR,
): Promise<ForkOriginEvidence> {
  const liveAgent = await resolveAgent(originName).catch(() => undefined);
  const ledgerRole = await readAgentStatusRole(originName, baseDir);
  const spawnSpec = await readSpawnSpec(originName, baseDir);
  const liveModel =
    liveAgent === undefined
      ? undefined
      : await readLiveClaudeModel(liveAgent, claudeProjectsFolderOf(spawnSpec?.account));
  return {
    live: liveAgent !== undefined,
    topicChanged: topicChanged(await readLatestTopicVerdict(originName, baseDir)),
    ledgerRole,
    ...(spawnSpec?.model === undefined ? {} : { ledgerModel: spawnSpec.model }),
    ...(liveModel === undefined ? {} : { liveModel }),
  };
}

export interface ForkRequest {
  readonly origin: string;
  readonly role: string;
  readonly supervisor: string | undefined;
  readonly composedName: string;
  readonly requestedModel: string | undefined;
}

export type ForkOriginResolution =
  | { readonly ok: true; readonly value: ForkOrigin }
  | { readonly ok: false; readonly reason: string };

export function resolveForkOrigin(
  request: ForkRequest,
  evidence: ForkOriginEvidence,
  brief: string | undefined,
  briefPath: string,
): ForkOriginResolution {
  const { origin } = request;
  if (request.role !== FORK_ORIGIN_ROLE) {
    return {
      ok: false,
      reason:
        `--topic-from is refused for role "${request.role}" — a fork is an ordinary ` +
        `${FORK_ORIGIN_ROLE}, so pass --role ${FORK_ORIGIN_ROLE}`,
    };
  }
  if (request.supervisor !== REGENT_NAME) {
    return {
      ok: false,
      reason:
        `--topic-from ${origin} needs --supervisor ${REGENT_NAME} — a fork is an ordinary ` +
        `Stager supervised by the Regent, and this spawn named ` +
        `"${request.supervisor ?? "(none)"}" instead`,
    };
  }
  if (!evidence.live) {
    return {
      ok: false,
      reason:
        `--topic-from ${origin} is refused — "${origin}" is not live in the roster, ` +
        `and a fork inherits its model from a live origin`,
    };
  }
  if (evidence.ledgerRole !== FORK_ORIGIN_ROLE) {
    return {
      ok: false,
      reason:
        `--topic-from ${origin} is refused — the ledger role of "${origin}" is ` +
        `"${evidence.ledgerRole === "" ? "(unrecorded)" : evidence.ledgerRole}", ` +
        `and only a ${FORK_ORIGIN_ROLE} may be forked`,
    };
  }
  if (!evidence.topicChanged) {
    return {
      ok: false,
      reason:
        `--topic-from ${origin} is refused — the latest topic record of the origin ` +
        `"${origin}" is not a change, and a fork is made only when the origin's topic changed`,
    };
  }
  const name = request.composedName;
  if (brief === undefined) {
    return {
      ok: false,
      reason:
        `--topic-from ${origin} is refused — a forked pane inherits no ` +
        `conversation, so "${name}" needs its brief at ${briefPath}. Write the ` +
        `brief in the five-marker shape (INTENT, SCOPE, RULINGS, ` +
        `VERIFIED-NOUNS, REUSE), check it with \`throne lint-queue-plan --body-file ` +
        `${briefPath}\`, then re-run`,
    };
  }
  const model =
    request.requestedModel ?? evidence.liveModel ?? evidence.ledgerModel;
  if (model === undefined) {
    return {
      ok: false,
      reason:
        `--topic-from ${origin} is refused — no model could be resolved: no ` +
        `--model was given, "${origin}" has no live observed model, and its ` +
        `ledger records none`,
    };
  }
  const modelSource: ForkModelSource =
    request.requestedModel !== undefined
      ? "the --model flag"
      : evidence.liveModel !== undefined
        ? "the origin's live observed model"
        : "the origin's ledger model";
  return { ok: true, value: { origin, model, modelSource } };
}
