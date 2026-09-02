import { homedir } from "node:os";
import path from "node:path";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import {
  DEFAULT_DATA_DIR,
  readSpawnSpec,
} from "../agentdata/spawn-data-contracts.ts";
import {
  HARNESS_NAMES,
  runtimeHarness,
  type Harness,
} from "../harness-routing/harness.ts";
import {
  attestClaudeRuntimeModel,
  readClaudeRuntimeModelAttestation,
  type ClaudeRuntimeModelAttestation,
} from "./claude-runtime-model-attestation.ts";
import { resolvedOrRawPath } from "../shared-policy/path-equivalence.ts";

export type RuntimeModelAcceptancePhase = "task" | "verdict" | "spawn";

export type RuntimeModelAcceptance =
  | { ok: true; outcome: "matching" | "not-applicable"; evidencePath?: string }
  | {
      ok: false;
      outcome: "missing" | "mismatch";
      detail: string;
      evidencePath: string;
    };

interface RuntimeModelEvidence {
  agent: string;
  phase: RuntimeModelAcceptancePhase;
  checkedAt: string;
  attestation: ClaudeRuntimeModelAttestation;
}

function claudeProjectDirectory(cwd: string, projectsDir: string): string {
  return path.join(
    projectsDir,
    resolvedOrRawPath(cwd).replace(/[^a-zA-Z0-9-]/g, "-"),
  );
}

async function newestTranscriptPath(
  projectDirectory: string,
  sessionId?: string,
): Promise<string | undefined> {
  if (sessionId !== undefined) {
    const transcriptPath = path.join(projectDirectory, `${sessionId}.jsonl`);
    try {
      await stat(transcriptPath);
      return transcriptPath;
    } catch {
      return undefined;
    }
  }
  let entries: string[];
  try {
    entries = (await readdir(projectDirectory)).filter((entry) =>
      entry.endsWith(".jsonl"),
    );
  } catch {
    return undefined;
  }
  const candidates = await Promise.all(
    entries.map(async (entry) => {
      const transcriptPath = path.join(projectDirectory, entry);
      return {
        transcriptPath,
        modifiedAt: (await stat(transcriptPath)).mtimeMs,
      };
    }),
  );
  return candidates.sort((left, right) => right.modifiedAt - left.modifiedAt)[0]
    ?.transcriptPath;
}

async function preserveRuntimeModelEvidence(
  name: string,
  phase: RuntimeModelAcceptancePhase,
  attestation: ClaudeRuntimeModelAttestation,
  baseDir: string,
): Promise<string> {
  const evidenceDirectory = path.join(baseDir, name, "runtime-model-evidence");
  await mkdir(evidenceDirectory, { recursive: true });
  const outcome =
    attestation.status === "matching" ? "attestation" : "quarantine";
  const evidencePath = path.join(evidenceDirectory, `${phase}-${outcome}.json`);
  const evidence: RuntimeModelEvidence = {
    agent: name,
    phase,
    checkedAt: new Date().toISOString(),
    attestation,
  };
  await writeFile(
    evidencePath,
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
  );
  return evidencePath;
}

export async function checkAgentRuntimeModelAcceptance(
  name: string,
  phase: RuntimeModelAcceptancePhase,
  baseDir: string = DEFAULT_DATA_DIR,
  projectsDir: string = path.join(homedir(), ".claude", "projects"),
): Promise<RuntimeModelAcceptance> {
  const spawn = await readSpawnSpec(name, baseDir);
  if (spawn === null) {
    return { ok: true, outcome: "not-applicable" };
  }
  if (runtimeHarness(spawn.harness as Harness) !== HARNESS_NAMES.CLAUDE) {
    return { ok: true, outcome: "not-applicable" };
  }

  const transcriptPath = await newestTranscriptPath(
    claudeProjectDirectory(spawn.cwd, projectsDir),
    spawn.session_id,
  );
  const attestation =
    transcriptPath === undefined
      ? attestClaudeRuntimeModel(
          spawn.model,
          "",
          claudeProjectDirectory(spawn.cwd, projectsDir),
        )
      : await readClaudeRuntimeModelAttestation(spawn.model, transcriptPath);
  const evidencePath = await preserveRuntimeModelEvidence(
    name,
    phase,
    attestation,
    baseDir,
  );
  if (attestation.status === "matching") {
    return { ok: true, outcome: "matching", evidencePath };
  }
  const observed =
    attestation.status === "missing"
      ? attestation.reason
      : `observed ${attestation.observedModels.join(", ")} instead of requested ${attestation.requestedModel}`;
  return {
    ok: false,
    outcome: attestation.status,
    detail: `${observed}; evidence preserved at ${evidencePath}`,
    evidencePath,
  };
}

export interface SpawnTaskingConfirmationDeps {
  pollIntervalMs?: number;
  deadlineMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

const SPAWN_TASKING_POLL_INTERVAL_MS = 3_000;
const SPAWN_TASKING_BOOT_GRACE_DEADLINE_MS = 90_000;

function sleepRealTime(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isStillBootingOutcome(result: RuntimeModelAcceptance): boolean {
  return !result.ok && result.outcome === "missing";
}

export async function awaitSpawnTaskingConfirmation(
  name: string,
  phase: RuntimeModelAcceptancePhase,
  baseDir: string = DEFAULT_DATA_DIR,
  projectsDir: string = path.join(homedir(), ".claude", "projects"),
  deps: SpawnTaskingConfirmationDeps = {},
): Promise<RuntimeModelAcceptance> {
  const pollIntervalMs = deps.pollIntervalMs ?? SPAWN_TASKING_POLL_INTERVAL_MS;
  const deadlineMs = deps.deadlineMs ?? SPAWN_TASKING_BOOT_GRACE_DEADLINE_MS;
  const sleep = deps.sleep ?? sleepRealTime;
  const now = deps.now ?? Date.now;
  const deadlineAt = now() + deadlineMs;

  let lastResult: RuntimeModelAcceptance = {
    ok: false,
    outcome: "missing",
    detail: "no assistant runtime-model record observed yet",
    evidencePath: "",
  };
  while (true) {
    try {
      lastResult = await checkAgentRuntimeModelAcceptance(
        name,
        phase,
        baseDir,
        projectsDir,
      );
    } catch {
      // A transient read failure mid-poll (e.g. the transcript directory not
      // written yet) is simply another not-yet-confirmed iteration.
    }
    if (!isStillBootingOutcome(lastResult) || now() >= deadlineAt) {
      return lastResult;
    }
    await sleep(pollIntervalMs);
  }
}
