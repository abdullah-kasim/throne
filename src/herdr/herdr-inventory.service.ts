import { Injectable } from '@nestjs/common';
import { HerdrClientService } from './herdr-client.ts';
import { AgentResolutionError, sameAgentName } from './herdr-identity-contracts.ts';
import type { HerdrAgent as IdentityHerdrAgent } from './herdr-identity-contracts.ts';

export const AGENT_STATUSES = [
  'idle',
  'working',
  'blocked',
  'done',
  'unknown',
] as const;

export type AgentStatus = (typeof AGENT_STATUSES)[number];
export type ReadSource = 'visible' | 'recent' | 'recent-unwrapped';

export interface ReadOptions {
  source?: ReadSource;
  lines?: number;
  format?: 'text' | 'ansi';
  timeoutMilliseconds?: number;
}

export function parseReadText(stdout: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return stdout;
  }
  const text = (
    parsed as { result?: { read?: { text?: unknown } } } | null
  )?.result?.read?.text;
  if (typeof text !== 'string') {
    throw new Error(
      'herdr agent read: JSON missing "result.read.text" string — unexpected shape',
    );
  }
  return text;
}

export type HerdrAgent = Omit<IdentityHerdrAgent, "agentStatus"> & { agentStatus: AgentStatus };

export interface HerdrNameOwner {
  name: string;
  agent?: string;
  paneId: string;
  tabId: string;
  terminalId: string;
}

export interface HerdrTab {
  tabId: string;
  label: string;
  paneCount: number;
  workspaceId: string;
}

export interface HerdrPane {
  paneId: string;
  tabId: string;
  terminalId: string;
  label?: string;
  cwd?: string;
}

export interface HerdrForegroundProcess {
  name: string;
  argv: string[];
  cwd?: string;
  pid?: number;
}

export interface HerdrPaneProcessInfo {
  paneId: string;
  foregroundProcesses: HerdrForegroundProcess[];
}

export function agentStatusAcceptsInput(status: AgentStatus): boolean {
  return status === 'idle' || status === 'done';
}

function toAgentStatus(value: unknown): AgentStatus {
  return (AGENT_STATUSES as readonly string[]).includes(value as string)
    ? (value as AgentStatus)
    : 'unknown';
}

function toHerdrAgent(raw: unknown): HerdrAgent | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  if (
    typeof row.agent !== 'string' ||
    typeof row.terminal_id !== 'string'
  ) {
    return null;
  }
  return {
    agent: row.agent,
    ...(typeof row.model === 'string' ? { model: row.model } : {}),
    name: typeof row.name === 'string' ? row.name : undefined,
    ...(typeof row.tab_label === 'string' ? { tabLabel: row.tab_label } : {}),
    agentStatus: toAgentStatus(row.agent_status),
    cwd: typeof row.cwd === 'string' ? row.cwd : '',
    focused: row.focused === true,
    paneId: typeof row.pane_id === 'string' ? row.pane_id : '',
    tabId: typeof row.tab_id === 'string' ? row.tab_id : '',
    terminalId: row.terminal_id,
  };
}

function parseJson(stdout: string, command: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (cause) {
    throw new Error(
      `${command}: output was not valid JSON: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

export function parseAgentList(stdout: string): HerdrAgent[] {
  const parsed = parseJson(stdout, 'herdr agent list');
  const agents = (parsed as { result?: { agents?: unknown } } | null)?.result
    ?.agents;
  if (!Array.isArray(agents)) {
    throw new Error(
      'herdr agent list: JSON missing "result.agents" array — unexpected shape',
    );
  }
  return agents
    .map(toHerdrAgent)
    .filter((agent): agent is HerdrAgent => agent !== null);
}

export function parseNameOwners(stdout: string): HerdrNameOwner[] {
  const parsed = parseJson(stdout, 'herdr agent list ownership');
  const rows = (parsed as { result?: { agents?: unknown } } | null)?.result
    ?.agents;
  if (!Array.isArray(rows)) {
    throw new Error(
      'herdr agent list ownership: JSON missing "result.agents" array — unexpected shape',
    );
  }

  const owners: HerdrNameOwner[] = [];
  for (const raw of rows) {
    if (typeof raw !== 'object' || raw === null) {
      continue;
    }
    const row = raw as Record<string, unknown>;
    if (typeof row.name !== 'string') {
      continue;
    }
    if (
      typeof row.pane_id !== 'string' ||
      typeof row.tab_id !== 'string' ||
      typeof row.terminal_id !== 'string'
    ) {
      throw new Error(
        `herdr agent list ownership: named row "${row.name}" is missing pane/tab/terminal identity`,
      );
    }
    owners.push({
      name: row.name,
      ...(typeof row.agent === 'string' ? { agent: row.agent } : {}),
      paneId: row.pane_id,
      tabId: row.tab_id,
      terminalId: row.terminal_id,
    });
  }
  return owners;
}

export function parseTabList(stdout: string): HerdrTab[] {
  const parsed = parseJson(stdout, 'herdr tab list');
  const rows = (parsed as { result?: { tabs?: unknown } } | null)?.result
    ?.tabs;
  if (!Array.isArray(rows)) {
    throw new Error(
      'herdr tab list: JSON missing "result.tabs" array — unexpected shape',
    );
  }
  return rows.map((raw, index) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`herdr tab list: tab row ${index} is not an object`);
    }
    const row = raw as Record<string, unknown>;
    if (
      typeof row.tab_id !== 'string' ||
      typeof row.label !== 'string'
    ) {
      throw new Error(
        `herdr tab list: tab row ${index} is missing "tab_id" / "label"`,
      );
    }
    return {
      tabId: row.tab_id,
      label: row.label,
      paneCount: typeof row.pane_count === 'number' ? row.pane_count : 0,
      workspaceId:
        typeof row.workspace_id === 'string' ? row.workspace_id : '',
    };
  });
}

export function parsePaneList(stdout: string): HerdrPane[] {
  const parsed = parseJson(stdout, 'herdr pane list');
  const rows = (parsed as { result?: { panes?: unknown } } | null)?.result
    ?.panes;
  if (!Array.isArray(rows)) {
    throw new Error(
      'herdr pane list: JSON missing "result.panes" array — unexpected shape',
    );
  }
  return rows.map((raw, index) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`herdr pane list: pane row ${index} is not an object`);
    }
    const row = raw as Record<string, unknown>;
    if (
      typeof row.pane_id !== 'string' ||
      typeof row.tab_id !== 'string' ||
      typeof row.terminal_id !== 'string'
    ) {
      throw new Error(
        `herdr pane list: pane row ${index} is missing pane/tab/terminal identity`,
      );
    }
    return {
      paneId: row.pane_id,
      tabId: row.tab_id,
      terminalId: row.terminal_id,
      label: typeof row.label === 'string' ? row.label : undefined,
      cwd: typeof row.cwd === 'string' ? row.cwd : undefined,
    };
  });
}

export class IncompleteHerdrPaneProcessInfoError extends Error {
  readonly name = 'IncompleteHerdrPaneProcessInfoError';

  constructor(detail: string, cause?: unknown) {
    super(
      `herdr pane process-info: ${detail}`,
      cause === undefined ? undefined : { cause },
    );
  }
}

export function parsePaneProcessInfo(
  stdout: string,
): HerdrPaneProcessInfo {
  const parsed = parseJson(stdout, 'herdr pane process-info');
  const info = (
    parsed as {
      result?: {
        process_info?: {
          pane_id?: unknown;
          foreground_processes?: unknown;
        };
      };
    } | null
  )?.result?.process_info;
  if (
    typeof info?.pane_id !== 'string' ||
    !Array.isArray(info.foreground_processes)
  ) {
    throw new Error(
      'herdr pane process-info: JSON missing pane id / foreground process array — unexpected shape',
    );
  }
  const foregroundProcesses = info.foreground_processes.map(
    (raw, index) => {
      if (typeof raw !== 'object' || raw === null) {
        throw new IncompleteHerdrPaneProcessInfoError(
          `process row ${index} is not an object`,
        );
      }
      const row = raw as Record<string, unknown>;
      const name =
        typeof row.name === 'string' && row.name.trim() !== '' ? row.name : undefined;
      const argv =
        Array.isArray(row.argv) &&
        row.argv.length > 0 &&
        row.argv.every((arg) => typeof arg === 'string')
          ? (row.argv as string[])
          : undefined;
      const argv0 =
        typeof row.argv0 === 'string' && row.argv0.trim() !== '' ? row.argv0 : undefined;
      // A row is usable when it names its executable SOMEHOW — full argv,
      // argv0, or the process name. macOS herdr (proven 2026-09-02) reports
      // a claude session's MCP child as `{name: "node", argv0:
      // "mcp-context-a8c"}` with no argv at all, permanently: the kernel
      // refuses the argument vector for that process. Treating that one
      // row as "incomplete, retry" made every composer probe on the mac
      // wait out its whole deadline and every delivery sit for the full
      // lane bound. The safety the strict check bought — never write into a
      // pane whose foreground we cannot classify — survives, because both
      // classifiers (`paneHasExternalInteractiveProcess`,
      // `isRegisteredHarnessProcess`) read the name and argv[0], and a row
      // with neither is still refused below.
      if (name === undefined && argv === undefined && argv0 === undefined) {
        throw new IncompleteHerdrPaneProcessInfoError(
          `process row ${index} is missing name / argv`,
        );
      }
      const resolvedArgv = argv ?? [(argv0 ?? name) as string];
      return {
        name: name ?? argv0 ?? resolvedArgv[0]!,
        argv: resolvedArgv,
        cwd: typeof row.cwd === 'string' ? row.cwd : undefined,
        pid: typeof row.pid === 'number' ? row.pid : undefined,
      } satisfies HerdrForegroundProcess;
    },
  );
  return { paneId: info.pane_id, foregroundProcesses };
}


@Injectable()
export class HerdrInventoryService {
  private readonly client: HerdrClientService;

  constructor(client: HerdrClientService) {
    this.client = client;
  }

  async listAgents(): Promise<HerdrAgent[]> {
    return parseAgentList((await this.client.execute(['agent', 'list'])).stdout);
  }

  async resolveAgent(name: string): Promise<HerdrAgent> {
    const matches = (await this.listAgents()).filter((agent) => sameAgentName(agent.name, name));
    if (matches.length !== 1) throw new AgentResolutionError(name, matches.length);
    return matches[0]!;
  }
}
