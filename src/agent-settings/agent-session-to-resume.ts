import os from "node:os";
import { claudeProjectsFolderOf } from "../account/agent-account.ts";
import type { SpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import {
  HARNESS_NAMES,
  runtimeHarness,
  type Harness,
} from "../harness-routing/harness.ts";
import type { RestoredAgentTabDeps } from "../herdr/restored-agent-tab.ts";
import { CodexSessionStoreService } from "../session/codex-session-store.service.ts";
import { claudeTranscriptPathFor } from "../session/runtime-model-acceptance.ts";
import { SessionService } from "../session/session.service.ts";

export interface SessionToResume {
  readonly sessionId: string;
  readonly recoveredFromHerdr: boolean;
}

export interface TranscriptFolders {
  readonly claudeProjects: string;
  readonly userHome: string;
}

export interface SessionToResumeDeps
  extends Pick<RestoredAgentTabDeps, "listPanes"> {
  readonly transcriptExists: (
    spawnSpec: SpawnSpec,
    sessionId: string,
  ) => Promise<boolean>;
}

export function transcriptFoldersOf(spawnSpec: SpawnSpec): TranscriptFolders {
  return {
    claudeProjects: claudeProjectsFolderOf(spawnSpec.account),
    userHome: os.homedir(),
  };
}

export async function transcriptExists(
  spawnSpec: SpawnSpec,
  sessionId: string,
  folders: TranscriptFolders = transcriptFoldersOf(spawnSpec),
): Promise<boolean> {
  const harness = spawnSpec.harness as Harness;
  if (runtimeHarness(harness) === HARNESS_NAMES.CODEX) {
    const sessions = await new CodexSessionStoreService().readNativeSessionCandidates(
      harness,
      () => folders.userHome,
    );
    return sessions.some((session) => session.id === sessionId.toLowerCase());
  }
  const transcriptPath = await claudeTranscriptPathFor(
    spawnSpec.cwd,
    sessionId,
    folders.claudeProjects,
  );
  return transcriptPath !== undefined;
}

async function sessionHerdrHoldsForPane(
  paneId: string,
  deps: SessionToResumeDeps,
): Promise<string | undefined> {
  return (await deps.listPanes()).find((pane) => pane.paneId === paneId)
    ?.sessionId;
}

export async function sessionToResume(
  spawnSpec: SpawnSpec,
  paneId: string,
  deps: SessionToResumeDeps,
): Promise<SessionToResume | null> {
  const sessions = new SessionService();
  if (sessions.isFullSessionId(spawnSpec.session_id)) {
    return { sessionId: spawnSpec.session_id, recoveredFromHerdr: false };
  }
  const herdrSessionId = await sessionHerdrHoldsForPane(paneId, deps);
  if (!sessions.isFullSessionId(herdrSessionId)) return null;
  return (await deps.transcriptExists(spawnSpec, herdrSessionId))
    ? { sessionId: herdrSessionId, recoveredFromHerdr: true }
    : null;
}
