import type { HerdrAgent, HerdrPane, HerdrTab } from "../herdr/herdr-inventory.service.ts";
import { pathsResolveEqual } from "../shared-policy/path-equivalence.ts";

export interface DurableIdentityRegistration {
  name: string;
  tabLabel: string;
  paneId: string;
  terminalId: string;
  harness: string;
  cwd: string;
  ledgerPath: string;
  treePath?: string;
  sessionId?: string;
}

export interface ResolvedIdentity {
  registration: DurableIdentityRegistration;
  tab: HerdrTab;
  pane: HerdrPane;
  agent?: HerdrAgent;
}

export class SharedIdentityResolutionError extends Error {
  readonly code = "identity-resolution-refused";
  constructor(message: string) {
    super(message);
    this.name = "SharedIdentityResolutionError";
  }
}

export function normalizeTabLabel(label: string): string {
  const normalized = label.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
    throw new SharedIdentityResolutionError(`invalid tab label ${JSON.stringify(label)}`);
  }
  return normalized;
}

/** Canonical address used by every lifecycle consumer before resolution. */
export function canonicalIdentityName(name: string): string {
  return normalizeTabLabel(name);
}

export function resolveLowercaseTabIdentity(
  registration: DurableIdentityRegistration,
  tabs: readonly HerdrTab[],
  panes: readonly HerdrPane[],
  agents: readonly HerdrAgent[] = [],
): ResolvedIdentity {
  const label = normalizeTabLabel(registration.tabLabel);
  if (registration.tabLabel !== label) {
    throw new SharedIdentityResolutionError(`tab label case drift for ${registration.name}`);
  }
  const tabMatches = tabs.filter((tab) => tab.label === label);
  if (tabMatches.length !== 1) {
    throw new SharedIdentityResolutionError(`expected one exact tab ${JSON.stringify(label)}, found ${tabMatches.length}`);
  }
  const tab = tabMatches[0]!;
  if (tab.tabId !== registration.paneId && !panes.some((pane) => pane.tabId === tab.tabId && pane.paneId === registration.paneId)) {
    throw new SharedIdentityResolutionError(`pane ${registration.paneId} is foreign to tab ${tab.tabId}`);
  }
  const paneMatches = panes.filter((pane) => pane.paneId === registration.paneId && pane.tabId === tab.tabId);
  if (paneMatches.length !== 1) {
    throw new SharedIdentityResolutionError(`expected one pane ${registration.paneId}, found ${paneMatches.length}`);
  }
  const pane = paneMatches[0]!;
  if (pane.terminalId !== registration.terminalId) throw new SharedIdentityResolutionError("terminal ownership mismatch");
  if (pane.cwd !== undefined && !pathsResolveEqual(pane.cwd, registration.cwd)) throw new SharedIdentityResolutionError("cwd ownership mismatch");
  const agentMatches = agents.filter((agent) => agent.paneId === pane.paneId && agent.tabId === tab.tabId && agent.terminalId === pane.terminalId);
  if (agentMatches.length > 1) throw new SharedIdentityResolutionError("ambiguous optional Herdr agent metadata");
  const agent = agentMatches[0];
  if (agent !== undefined && agent.agent !== registration.harness) {
    throw new SharedIdentityResolutionError("harness ownership mismatch");
  }
  return { registration, tab, pane, agent };
}
