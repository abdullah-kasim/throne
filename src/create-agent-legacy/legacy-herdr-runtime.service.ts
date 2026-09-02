import { realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { Injectable } from "@nestjs/common";
import { inspectSupportedAgentScreen } from "../codex-screen/composer/composer.service.ts";
import { LedgerDataService } from "./legacy-ledger-data.service.ts";
import {
  agentRegistrationExists,
  readSpawnSpec,
} from "./legacy-spawn-data-contracts.ts";
import {
  HARNESSES,
  runtimeHarness,
  type Harness,
} from "../harness-routing/harness.ts";
import {
  AgentResolutionError,
  sameAgentName,
} from "./legacy-herdr-identity-contracts.ts";

export { AgentResolutionError } from "./legacy-herdr-identity-contracts.ts";
import {
  parseAgentList,
  parseNameOwners,
  parsePaneList,
  parsePaneProcessInfo,
  parseReadText,
  parseTabList,
  type AgentStatus,
  type HerdrAgent,
  type HerdrForegroundProcess,
  type HerdrNameOwner,
  type HerdrPane,
  type HerdrPaneProcessInfo,
  type HerdrTab,
  type ReadOptions,
} from "../herdr/herdr-inventory.service.ts";
import { runHerdr } from "../herdr/herdr-client.ts";
import {
  resolveLowercaseTabIdentity,
  SharedIdentityResolutionError,
} from "../shared-identity/shared-identity.ts";
import { pathsResolveEqual } from "../shared-policy/path-equivalence.ts";
import { readSpawnedTabLabel } from "./legacy-identity-data.service.ts";
import {
  resolveCanonicalRoleWord,
  LIVE_ROLE_WORD_UNION,
  type RoleWordUnion,
} from "../shared-policy/role-word-union.ts";
import {
  isLiveHarnessProcess,
  isRegisteredHarnessProcess,
  paneHasRegisteredHarnessProcessChain,
  paneHasExternalInteractiveProcess,
} from "../herdr/herdr-process-detection.ts";
export interface RepairRecipientDeps {
  listAgents(): Promise<HerdrAgent[]>;
  listTabs(): Promise<HerdrTab[]>;
  listPanes(): Promise<HerdrPane[]>;
  getPaneProcessInfo(paneId: string): Promise<HerdrPaneProcessInfo>;
  listRegisteredAgents(): Promise<string[]>;
  readRegisteredSpawn(
    name: string,
  ): Promise<{ cwd: string; harness: string } | undefined>;
  readSpawnedTabLabel(name: string): Promise<string>;
  roleWordUnion: RoleWordUnion;
  resolvePath(value: string): string;
  readVisibleAnsi(paneId: string): Promise<string>;
  renameAgent(paneId: string, name: string): Promise<void>;
}

export async function listAgents(
  options: { timeoutMilliseconds?: number } = {},
): Promise<HerdrAgent[]> {
  const { stdout } = await runHerdr(
    ["agent", "list"],
    undefined,
    undefined,
    options.timeoutMilliseconds === undefined ? undefined : options,
  );
  return parseAgentList(stdout);
}

export async function readAgentStatus(target: string): Promise<AgentStatus> {
  const matches = (await listAgents()).filter(
    (agent) => agent.terminalId === target,
  );
  if (matches.length !== 1) {
    throw new Error(
      `cannot refresh herdr agent status for terminal "${target}": ` +
        `expected exactly one match, found ${matches.length}`,
    );
  }
  return matches[0]!.agentStatus;
}

export async function readAgent(
  name: string,
  opts?: ReadOptions,
): Promise<string> {
  const agent = await resolveAgent(
    name,
    opts?.timeoutMilliseconds === undefined
      ? undefined
      : {
          listAgents: () =>
            listAgents({ timeoutMilliseconds: opts.timeoutMilliseconds }),
        },
  );
  const args = ["agent", "read", agent.paneId];
  if (opts?.source) {
    args.push("--source", opts.source);
  }
  if (opts?.lines !== undefined) {
    args.push("--lines", String(opts.lines));
  }
  if (opts?.format) {
    args.push("--format", opts.format);
  }
  const { stdout } = await runHerdr(
    args,
    undefined,
    undefined,
    opts?.timeoutMilliseconds === undefined
      ? undefined
      : { timeoutMilliseconds: opts.timeoutMilliseconds },
  );
  return parseReadText(stdout);
}

export async function listNameOwners(): Promise<HerdrNameOwner[]> {
  const { stdout } = await runHerdr(["agent", "list"]);
  return parseNameOwners(stdout);
}

export async function listTabs(): Promise<HerdrTab[]> {
  const { stdout } = await runHerdr(["tab", "list"]);
  return parseTabList(stdout);
}

export async function listPanes(): Promise<HerdrPane[]> {
  const { stdout } = await runHerdr(["pane", "list"]);
  return parsePaneList(stdout);
}

export async function readVisibleAnsi(paneId: string): Promise<string> {
  const { stdout } = await runHerdr([
    "agent",
    "read",
    paneId,
    "--source",
    "visible",
    "--format",
    "ansi",
  ]);
  return parseReadText(stdout);
}

export async function getPaneProcessInfo(
  paneId: string,
): Promise<HerdrPaneProcessInfo> {
  const { stdout } = await runHerdr(["pane", "process-info", "--pane", paneId]);
  return parsePaneProcessInfo(stdout);
}

export async function renameAgent(
  target: string,
  name: string,
  deps: { runHerdr: typeof runHerdr } = { runHerdr },
): Promise<void> {
  await deps.runHerdr(["agent", "rename", target, name.toLowerCase()]);
}

export async function resolveAgent(
  name: string,
  deps: Pick<RepairRecipientDeps, "listAgents"> &
    Partial<RepairRecipientDeps> = DEFAULT_REPAIR_RECIPIENT_DEPS,
): Promise<HerdrAgent> {
  const agents = await deps.listAgents();
  const matches = agents.filter((agent) => sameAgentName(agent.name, name));
  if (matches.length > 1) {
    throw new AgentResolutionError(name, matches.length);
  }
  if (matches.length === 1) return matches[0]!;
  const repairDeps = { ...DEFAULT_REPAIR_RECIPIENT_DEPS, ...deps };
  const repaired = await repairRecipientByExactTabLabel(
    name,
    agents,
    repairDeps,
  );
  if (repaired !== undefined) return repaired;
  throw new AgentResolutionError(name, 0);
}

/** Injectable owner for the Herdr runtime inventory and identity effects. */
@Injectable()
export class HerdrRuntimeService {
  listAgents = listAgents;
  readAgentStatus = readAgentStatus;
  readAgent = readAgent;
  listNameOwners = listNameOwners;
  listTabs = listTabs;
  listPanes = listPanes;
  getPaneProcessInfo = getPaneProcessInfo;
  resolveAgent = resolveAgent;
}

function supportedHarness(value: string): Harness | undefined {
  return HARNESSES.find((harness) => harness === value);
}

function samePaneIdentity(left: HerdrAgent, right: HerdrAgent): boolean {
  return (
    left.paneId === right.paneId &&
    left.tabId === right.tabId &&
    left.terminalId === right.terminalId &&
    pathsResolveEqual(left.cwd, right.cwd) &&
    left.agent === right.agent
  );
}

function refuse(name: string, reason: string): never {
  throw new Error(`cannot self-repair herdr agent "${name}": ${reason}`);
}

/**
 * Reverses a persona-worded herdr tab label back to the canonical agent name
 * it was spawned under, without guessing which preset was active at any
 * point: it trusts only the agent's own persisted spawn-time tab label and
 * the preset-agnostic role-word union, never the currently-active preset
 * config. Returns the canonical name when the
 * observed label matches the persisted record exactly and the persisted
 * record itself parses as a registered role word; `undefined` otherwise
 * (label drifted, no persisted record, or the record predates persona
 * tab labels).
 */
export function resolvePersonaTabLabelToCanonical(
  observedTabLabel: string,
  persistedSpawnLabel: string,
  union: RoleWordUnion,
): string | undefined {
  if (persistedSpawnLabel === "" || observedTabLabel !== persistedSpawnLabel) {
    return undefined;
  }
  const parsed = resolveCanonicalRoleWord(persistedSpawnLabel, union);
  return parsed === null ? undefined : `${parsed.role}-${parsed.rest}`;
}

export async function repairRecipientByExactTabLabel(
  name: string,
  initialAgents: HerdrAgent[],
  deps: RepairRecipientDeps,
): Promise<HerdrAgent | undefined> {
  const registrations = (await deps.listRegisteredAgents()).filter(
    (registered) => sameAgentName(registered, name),
  );
  if (registrations.length === 0) return undefined;
  if (registrations.length > 1) {
    refuse(
      name,
      `expected one registered ledger owner, found ${registrations.length}`,
    );
  }
  const registeredName = registrations[0]!;
  const spawn = await deps.readRegisteredSpawn(registeredName);
  if (spawn === undefined)
    refuse(name, "registered spawn is absent or invalid");
  const registeredHarness = supportedHarness(spawn.harness);
  if (registeredHarness === undefined)
    refuse(name, `unsupported registered harness "${spawn.harness}"`);
  const expectedHarness = runtimeHarness(registeredHarness);

  const persistedSpawnLabel = await deps.readSpawnedTabLabel(registeredName);
  const tabs = (await deps.listTabs()).filter(
    (tab) =>
      tab.label === name ||
      resolvePersonaTabLabelToCanonical(
        tab.label,
        persistedSpawnLabel,
        deps.roleWordUnion,
      ) === name,
  );
  if (tabs.length === 0) return undefined;
  if (tabs.length > 1)
    refuse(name, `expected one exact-labelled tab, found ${tabs.length}`);
  const tab = tabs[0]!;
  if (tab.paneCount !== 1) refuse(name, `tab has ${tab.paneCount} panes`);

  const panes = (await deps.listPanes()).filter(
    (pane) => pane.tabId === tab.tabId,
  );
  if (panes.length !== 1)
    refuse(name, `exact-labelled tab owns ${panes.length} panes`);
  const pane = panes[0]!;
  if (
    initialAgents.some(
      (agent) =>
        agent.tabId === tab.tabId &&
        agent.paneId === pane.paneId &&
        agent.terminalId !== pane.terminalId,
    )
  ) {
    refuse(name, "pane terminal identity does not match the live agent");
  }
  const candidates = initialAgents.filter(
    (agent) =>
      agent.tabId === tab.tabId &&
      agent.paneId === pane.paneId &&
      agent.terminalId === pane.terminalId,
  );
  if (candidates.length > 1) {
    refuse(name, `pane identity maps to ${candidates.length} live agents`);
  }
  const candidate = candidates[0];
  if (candidate?.name !== undefined)
    refuse(name, `pane is owned by foreign name "${candidate.name}"`);
  if (candidate !== undefined && candidate.agent !== expectedHarness) {
    refuse(name, "live harness does not match the registered harness");
  }
  const resolvedExpectedCwd = deps.resolvePath(spawn.cwd);
  if (
    (candidate !== undefined &&
      deps.resolvePath(candidate.cwd) !== resolvedExpectedCwd) ||
    (pane.cwd !== undefined &&
      deps.resolvePath(pane.cwd) !== resolvedExpectedCwd)
  ) {
    refuse(name, "pane cwd does not match the registered cwd");
  }

  const processInfo = await deps.getPaneProcessInfo(pane.paneId);
  if (processInfo.paneId !== pane.paneId)
    refuse(name, "process inspection changed pane identity");
  const harnessProcesses = processInfo.foregroundProcesses.filter((process) =>
    isRegisteredHarnessProcess(registeredHarness, process),
  );
  if (harnessProcesses.length === 0) {
    refuse(name, "pane has no genuine live harness process");
  }
  if (
    candidate === undefined &&
    !paneHasRegisteredHarnessProcessChain(registeredHarness, processInfo)
  ) {
    refuse(
      name,
      "unmapped pane lacks the registered launcher/runtime process chain",
    );
  }
  if (
    processInfo.foregroundProcesses.some(
      (process) =>
        isLiveHarnessProcess(process) &&
        !isRegisteredHarnessProcess(registeredHarness, process),
    )
  ) {
    refuse(name, "pane has a foreign or ambiguous harness process chain");
  }
  if (
    harnessProcesses.some(
      (process) =>
        process.cwd === undefined ||
        deps.resolvePath(process.cwd) !== resolvedExpectedCwd,
    )
  ) {
    refuse(name, "harness cwd does not match the registered cwd");
  }
  if (paneHasExternalInteractiveProcess(processInfo)) {
    refuse(name, "pane is controlled by an external editor/modal");
  }
  try {
    resolveLowercaseTabIdentity(
      {
        name: tab.label,
        tabLabel: tab.label,
        paneId: pane.paneId,
        terminalId: pane.terminalId,
        harness: expectedHarness,
        cwd: resolvedExpectedCwd,
        ledgerPath: registeredName,
      },
      [tab],
      [pane],
      candidate === undefined ? [] : [candidate],
    );
  } catch (error) {
    if (error instanceof SharedIdentityResolutionError) {
      refuse(name, error.message);
    }
    throw error;
  }
  const screen = inspectSupportedAgentScreen(
    expectedHarness,
    await deps.readVisibleAnsi(pane.paneId),
  );
  if (screen.activeComposer.state !== "empty") {
    refuse(name, `composer is ${screen.activeComposer.state}`);
  }

  await deps.renameAgent(pane.paneId, registeredName);
  const repaired = (await deps.listAgents()).filter((agent) =>
    sameAgentName(agent.name, registeredName),
  );
  if (
    repaired.length !== 1 ||
    repaired[0]!.paneId !== pane.paneId ||
    repaired[0]!.tabId !== tab.tabId ||
    repaired[0]!.terminalId !== pane.terminalId ||
    repaired[0]!.agent !== expectedHarness ||
    deps.resolvePath(repaired[0]!.cwd) !== resolvedExpectedCwd ||
    (candidate !== undefined && !samePaneIdentity(candidate, repaired[0]!))
  ) {
    refuse(name, "post-rename ownership verification failed");
  }
  return repaired[0]!;
}

async function listFromHerdr<T>(
  args: string[],
  parse: (stdout: string) => T,
): Promise<T> {
  return parse((await runHerdr(args)).stdout);
}

export const DEFAULT_REPAIR_RECIPIENT_DEPS: RepairRecipientDeps = {
  listAgents: () => listFromHerdr(["agent", "list"], parseAgentList),
  listTabs: () => listFromHerdr(["tab", "list"], parseTabList),
  listPanes: () => listFromHerdr(["pane", "list"], parsePaneList),
  getPaneProcessInfo: (paneId) =>
    listFromHerdr(
      ["pane", "process-info", "--pane", paneId],
      parsePaneProcessInfo,
    ),
  listRegisteredAgents: () => new LedgerDataService().listRegisteredAgents(),
  readRegisteredSpawn: async (name) => {
    const spec = await readSpawnSpec(name);
    return spec === null ? undefined : spec;
  },
  readSpawnedTabLabel: (name) => readSpawnedTabLabel(name),
  roleWordUnion: LIVE_ROLE_WORD_UNION,
  resolvePath: realpathSync,
  readVisibleAnsi,
  renameAgent: async (paneId, name) => {
    await runHerdr(["agent", "rename", paneId, name.toLowerCase()]);
  },
};
