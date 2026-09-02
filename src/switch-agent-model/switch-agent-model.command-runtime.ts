import { createReadStream, realpathSync } from "node:fs";
import { readFile, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RUNTIME_THRONE_ROOT } from "../shared-policy/runtime-throne-root.ts";
import { RUNTIME_DATA_DIR } from "../shared-policy/runtime-data-home.ts";
import { renderFrameworkEntranceRefusal } from "../shared-policy/entrance-refusal.ts";

import {
  readSpawnSpec,
  writeSpawnSpec,
  type SpawnSpec,
} from "../agentdata/spawn-data-contracts.ts";
import { LedgerDataService } from "../agentdata/ledger-data.service.ts";
import { switchAgentModel } from "./switch-agent-model.ts";
import type {
  PreservedBytes,
  SwitchTransactionDeps,
  SwitchTransactionResult,
} from "./transaction/transaction.types.ts";
import type { SwitchRequest } from "../session/session.contracts.ts";
import { SessionService } from "../session/session.service.ts";
import { CodexSessionStoreService } from "../session/codex-session-store.service.ts";
import { closeAgentTab } from "../herdr/herdr-tab.service.ts";
import { startAgent } from "../herdr/herdr-creation-orchestration.ts";
import {
  getPaneProcessInfo,
  resolveAgent,
} from "../herdr/herdr-runtime.service.ts";
import type { HerdrAgent } from "../herdr/herdr-inventory.service.ts";
import { readVisibleAgentAnsi } from "../herdr/herdr-screen.service.ts";

const ledgerData = new LedgerDataService();
import {
  REAL_CAPTURE_AGENT_STATUS_DEPS,
  captureAgentStatus,
} from "./status-capture.ts";
import {
  inspectSwitchRecipient,
  type InspectSwitchRecipientDeps,
} from "./recipient-inspection.ts";
import type { SwitchRecipientInspection } from "./transaction/transaction-contracts.ts";
import {
  HARNESSES,
  HARNESS_NAMES,
  runtimeHarness,
  type Harness,
} from "../harness-routing/harness.ts";
import type { PlanPresetName } from "../config.ts";
import { readUsageLogRaw } from "../plan-usage-remaining/telemetry-core/log.ts";
import { usageReaders } from "../create-agent/policy-usage.ts";
import { RecipientPaneLockService } from "../shared-policy/recipient-pane-lock.service.ts";
import {
  type CodexUsageReader,
  type OpenCodeGoUsageReader,
  type UsageReader,
} from "../shared-policy/usage-readers.ts";
import { UsageReadersService } from "../shared-policy/usage-readers.service.ts";
import { realPlanUsageRemainingService } from "../plan-usage-remaining/plan-usage-remaining.service.ts";
import { resolveRegisteredSwitchPolicy } from "./registered-switch-policy.ts";
import { readModelBypassAuthorizationRegistry } from "../create-agent/model-bypass-authorization.ts";
import { writeCommandOutcome, writeResult } from "./switch-command-output.ts";

const REPO_ROOT = RUNTIME_THRONE_ROOT;
const REAL_USAGE_READERS = new UsageReadersService(
  undefined,
  undefined,
  realPlanUsageRemainingService(),
);
const REAL_SESSION = new SessionService();
const REAL_CODEX_STORE = new CodexSessionStoreService();
const parseClaudeStatusSession =
  REAL_SESSION.parseClaudeStatusSession.bind(REAL_SESSION);
const parseCodexStatusSession =
  REAL_SESSION.parseCodexStatusSession.bind(REAL_SESSION);
const parseStatusFields = REAL_SESSION.parseStatusFields.bind(REAL_SESSION);
const validateSwitchTarget =
  REAL_SESSION.validateSwitchTarget.bind(REAL_SESSION);
export const readNativeSessionCandidates = (
  ...args: Parameters<CodexSessionStoreService["readNativeSessionCandidates"]>
) => REAL_CODEX_STORE.readNativeSessionCandidates(...args);
const RECIPIENT_PANE_LOCK = new RecipientPaneLockService();
export interface SwitchAgentModelCommandDeps {
  dataDir: string;
  homedir: () => string;
  readFile: typeof readFile;
  readdir: typeof readdir;
  createReadStream: typeof createReadStream;
  readSpawnSpec: typeof readSpawnSpec;
  writeSpawnSpec: typeof writeSpawnSpec;
  resolveAgent: typeof resolveAgent;
  withRecipientPaneLock: RecipientPaneLockService["withRecipientPaneLock"];
  inspectRecipient: (
    name: string,
    expectedCwd: string,
    heldPaneIds: ReadonlySet<string>,
  ) => ReturnType<SwitchTransactionDeps["inspectRecipient"]>;
  captureStatus: (
    recipient: HerdrAgent,
    harness: Harness,
    heldPaneIds: ReadonlySet<string>,
  ) => ReturnType<SwitchTransactionDeps["captureStatus"]>;
  listSessionCandidates: NonNullable<
    SwitchTransactionDeps["listSessionCandidates"]
  >;
  closeAgent: SwitchTransactionDeps["closeAgent"];
  startAgent: SwitchTransactionDeps["startAgent"];
  resolvePath: SwitchTransactionDeps["resolvePath"];
  wait: SwitchTransactionDeps["wait"];
  now: () => Date;
  getClaudeUsage?: UsageReader;
  getCodexUsage?: CodexUsageReader;
  getOpenCodeGoUsage?: OpenCodeGoUsageReader;
  readUsageLogRaw?: typeof readUsageLogRaw;
  planPresetName?: PlanPresetName;
  targetEffort?: number;
  executeTransaction: typeof switchAgentModel;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

import {
  ABSENT_FILE,
  parseSwitchAgentModelArgs,
  type ParsedSwitchAgentModelArgs,
  SWITCH_AGENT_MODEL_HELP,
  SWITCH_AGENT_MODEL_USAGE,
} from "./command-arguments.ts";

function isHarness(value: string): value is Harness {
  return (HARNESSES as readonly string[]).includes(value);
}

function exactRecipe(spawn: SpawnSpec, model: string, effort: number): string {
  return JSON.stringify({
    harness: spawn.harness,
    model,
    effort,
    cwd: spawn.cwd,
  });
}

function preview(
  spawn: SpawnSpec,
  request: SwitchRequest,
): { current: string; proposed: string } {
  if (
    spawn.harness_executable !== undefined ||
    spawn.passthrough_argv !== undefined
  ) {
    throw new Error(
      "the registered agent uses a custom harness recipe with no exact-resume form",
    );
  }
  if (!isHarness(spawn.harness)) {
    throw new Error(`stored harness "${spawn.harness}" is not supported`);
  }
  const validated = REAL_SESSION.validateSwitchTarget(
    { harness: spawn.harness, model: spawn.model, effort: spawn.effort },
    request,
  );
  if (!validated.ok) throw new Error(validated.message);
  return {
    current: exactRecipe(spawn, spawn.model, spawn.effort),
    proposed: exactRecipe(
      spawn,
      validated.target.model,
      validated.target.effort,
    ),
  };
}

async function preservedFile(
  filePath: string,
  required: boolean,
  deps: Pick<SwitchAgentModelCommandDeps, "readFile">,
): Promise<string> {
  try {
    return `present:${(await deps.readFile(filePath)).toString("base64")}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !required)
      return ABSENT_FILE;
    throw error;
  }
}

async function readPreservedBytes(
  name: string,
  deps: Pick<SwitchAgentModelCommandDeps, "dataDir" | "readFile">,
): Promise<PreservedBytes> {
  const directory = path.join(deps.dataDir, name);
  const [identity, tree] = await Promise.all([
    preservedFile(path.join(directory, "identity.md"), true, deps),
    preservedFile(path.join(directory, "tree-base.json"), false, deps),
  ]);
  return { identity, tree };
}

function statusCaptured(harness: Harness, text: string): boolean {
  if (REAL_SESSION.parseStatusFields(text).model === undefined) return false;
  return runtimeHarness(harness) === HARNESS_NAMES.CODEX
    ? REAL_SESSION.parseCodexStatusSession(text) !== null
    : REAL_SESSION.parseClaudeStatusSession(text) !== null;
}

export function lockUnheldPane(
  heldPaneIds: ReadonlySet<string>,
  lock: RecipientPaneLockService["withRecipientPaneLock"] = RECIPIENT_PANE_LOCK.withRecipientPaneLock.bind(
    RECIPIENT_PANE_LOCK,
  ),
): RecipientPaneLockService["withRecipientPaneLock"] {
  return (paneId, action, options) =>
    heldPaneIds.has(paneId) ? action() : lock(paneId, action, options);
}

async function inspectContinuouslyHeldRecipient(
  name: string,
  expectedCwd: string,
  heldPaneIds: ReadonlySet<string>,
  inspect: SwitchAgentModelCommandDeps["inspectRecipient"],
): Promise<SwitchRecipientInspection> {
  const inspection = await inspect(name, expectedCwd, heldPaneIds);
  if (
    inspection.outcome !== "ready" ||
    heldPaneIds.has(inspection.agent.paneId)
  ) {
    return inspection;
  }
  // The recipient resolved to a pane other than the one the continuous lock
  // was acquired for — an unresolved observation, not a fact that the
  // recipient is ready. Refuse rather than proceed with a mismatched pane.
  return {
    outcome: "refused",
    code: "unresolved",
    reason:
      `recipient resolved to pane "${inspection.agent.paneId}" after the continuous ` +
      `lock was acquired for a different pane`,
  };
}

function inspectionDeps(
  heldPaneIds: ReadonlySet<string>,
): InspectSwitchRecipientDeps {
  return {
    resolveAgent,
    withRecipientPaneLock: lockUnheldPane(heldPaneIds),
    resolvePath: realpathSync,
    getPaneProcessInfo,
    readVisibleAgentAnsi,
  };
}

export function realSwitchAgentModelCommandDeps(
  dataDir: string = RUNTIME_DATA_DIR,
): SwitchAgentModelCommandDeps {
  const nativeSessionDeps = {
    homedir: os.homedir,
    readdir,
    createReadStream,
  };
  return {
    dataDir,
    ...nativeSessionDeps,
    readFile,
    readSpawnSpec,
    writeSpawnSpec,
    resolveAgent,
    withRecipientPaneLock:
      RECIPIENT_PANE_LOCK.withRecipientPaneLock.bind(RECIPIENT_PANE_LOCK),
    inspectRecipient: (name, cwd, heldPaneIds) =>
      inspectSwitchRecipient(name, cwd, inspectionDeps(heldPaneIds)),
    captureStatus: (recipient, harness, heldPaneIds) =>
      captureAgentStatus(
        recipient,
        harness,
        (text) => statusCaptured(harness, text),
        {
          ...REAL_CAPTURE_AGENT_STATUS_DEPS,
          withRecipientPaneLock: lockUnheldPane(heldPaneIds),
        },
      ),
    listSessionCandidates: (harness) =>
      REAL_CODEX_STORE.readNativeSessionCandidates(
        harness,
        os.homedir,
        readdir,
        createReadStream,
      ),
    closeAgent: closeAgentTab,
    startAgent,
    resolvePath: realpath,
    wait: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now: () => new Date(),
    executeTransaction: switchAgentModel,
    getClaudeUsage: REAL_USAGE_READERS.claude,
    getCodexUsage: REAL_USAGE_READERS.codex,
    getOpenCodeGoUsage: REAL_USAGE_READERS.opencodeGo,
    readUsageLogRaw,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

const REAL_DEPS = realSwitchAgentModelCommandDeps();

export async function run(
  args: string[],
  deps: SwitchAgentModelCommandDeps = REAL_DEPS,
): Promise<number> {
  if (args.includes("--help")) {
    deps.stdout(SWITCH_AGENT_MODEL_HELP);
    return 0;
  }

  let parsed: ParsedSwitchAgentModelArgs;
  try {
    parsed = parseSwitchAgentModelArgs(args);
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    deps.stderr(
      `switch-agent-model: ${diagnostic}\n${SWITCH_AGENT_MODEL_USAGE}${renderFrameworkEntranceRefusal("switch-agent-model", diagnostic, { available: false })}\n`,
    );
    writeCommandOutcome("refused-before-close", "no", deps);
    return 1;
  }

  let spawn: SpawnSpec | null;
  try {
    spawn = await deps.readSpawnSpec(parsed.agentName, deps.dataDir);
  } catch (error) {
    deps.stderr(
      `switch-agent-model: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    writeCommandOutcome("refused-before-close", "no", deps);
    return 1;
  }
  if (spawn === null) {
    deps.stderr(
      `switch-agent-model: ${parsed.agentName} has no readable registered spawn.json\n`,
    );
    writeCommandOutcome("refused-before-close", "no", deps);
    return 1;
  }

  const usageDeps = {
    getClaudeUsage: deps.getClaudeUsage ?? REAL_USAGE_READERS.claude,
    getCodexUsage: deps.getCodexUsage ?? REAL_USAGE_READERS.codex,
    getOpenCodeGoUsage:
      deps.getOpenCodeGoUsage ?? REAL_USAGE_READERS.opencodeGo,
    readUsageLogRaw: deps.readUsageLogRaw ?? readUsageLogRaw,
    now: () => deps.now().toISOString(),
  };
  const readers = usageReaders(usageDeps);
  let admittedRequest: SwitchRequest;
  try {
    const admission = await resolveRegisteredSwitchPolicy({
      agentName: parsed.agentName,
      spawn,
      requested: parsed.request,
      bypass: parsed.bypass,
      deps: {
        readClaudeUsage: readers.claude,
        readCodexUsage: readers.codex,
        readModelBypassAuthorizations: () =>
          readModelBypassAuthorizationRegistry(deps.dataDir),
        now: () => deps.now().toISOString(),
        planPresetName: deps.planPresetName,
        targetEffort: deps.targetEffort,
      },
    });
    if (!admission.ok) throw new Error(admission.reason);
    admittedRequest = admission.request;
    for (const note of admission.notes)
      deps.stderr(`switch-agent-model: ${note}\n`);
  } catch (error) {
    deps.stderr(
      `switch-agent-model: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    writeCommandOutcome("refused-before-close", "no", deps);
    return 1;
  }

  let recipes: { current: string; proposed: string };
  let preserved: PreservedBytes;
  try {
    recipes = preview(spawn, admittedRequest);
    preserved = await readPreservedBytes(parsed.agentName, deps);
  } catch (error) {
    deps.stderr(
      `switch-agent-model: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    writeCommandOutcome("refused-before-close", "no", deps);
    return 1;
  }

  if (!parsed.confirm) {
    deps.stdout(`current recipe: ${recipes.current}\n`);
    deps.stdout(`proposed recipe: ${recipes.proposed}\n`);
    deps.stderr(
      "switch-agent-model: no changes made; rerun with --confirm to execute this exact switch\n",
    );
    writeCommandOutcome("refused-before-close", "no", deps);
    return 1;
  }

  let initial: HerdrAgent;
  try {
    initial = await deps.resolveAgent(parsed.agentName);
  } catch (error) {
    deps.stderr(
      `switch-agent-model: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    writeCommandOutcome("refused-before-close", "no", deps);
    return 1;
  }

  let result: SwitchTransactionResult;
  try {
    result = await deps.withRecipientPaneLock(initial.paneId, async () => {
      const heldPaneIds = new Set([initial.paneId]);
      const holdPaneContinuously = async <T>(
        paneId: string,
        action: () => Promise<T>,
      ): Promise<T> => {
        if (heldPaneIds.has(paneId)) return action();
        return deps.withRecipientPaneLock(paneId, async () => {
          heldPaneIds.add(paneId);
          try {
            return await action();
          } finally {
            heldPaneIds.delete(paneId);
          }
        });
      };
      return deps.executeTransaction(
        {
          agentName: parsed.agentName,
          spawn,
          request: admittedRequest,
          preserved,
        },
        {
          inspectRecipient: (name, cwd) =>
            inspectContinuouslyHeldRecipient(
              name,
              cwd,
              heldPaneIds,
              deps.inspectRecipient,
            ),
          captureStatus: (recipient, harness) =>
            deps.captureStatus(recipient, harness, heldPaneIds),
          listSessionCandidates: deps.listSessionCandidates,
          closeAgent: (agent) =>
            lockUnheldPane(heldPaneIds, deps.withRecipientPaneLock)(
              agent.paneId,
              () => deps.closeAgent(agent),
            ),
          withRecipientPaneLock: holdPaneContinuously,
          startAgent: deps.startAgent,
          persistSpawnSpec: (updated) =>
            deps.writeSpawnSpec(parsed.agentName, updated, deps.dataDir),
          readSpawnSpec: async () => {
            const stored = await deps.readSpawnSpec(
              parsed.agentName,
              deps.dataDir,
            );
            if (stored === null)
              throw new Error("spawn.json is absent, unreadable, or invalid");
            return stored;
          },
          resolvePath: deps.resolvePath,
          readPreservedBytes: () => readPreservedBytes(parsed.agentName, deps),
          wait: deps.wait,
          now: deps.now,
        },
      );
    });
  } catch (error) {
    deps.stderr(
      `switch-agent-model: transaction failed before a deterministic outcome: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    writeCommandOutcome("target-failed/rollback-failed", "unknown", deps);
    return 1;
  }

  writeResult(result, deps);
  return result.outcome === "switched" ? 0 : 1;
}
