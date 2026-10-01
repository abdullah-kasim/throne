import {
  HerdrClientService,
  DEFAULT_HERDR_READ_ONLY_CLIENT_DEPENDENCIES,
  resolveHerdrReadOnlyInvocation,
  resolveHerdrReadOnlyInvocationForSession,
  DuplicateAgentNameAcrossSessionsError,
  THRONE_HERDR_SESSION_NAMES,
  type HerdrReadOnlyClientDependencies,
} from '../herdr/herdr-client.ts';

export const AGENT_STATUSES = [
  'idle',
  'working',
  'blocked',
  'done',
  'unknown',
] as const;

export type AgentStatus = (typeof AGENT_STATUSES)[number];

export interface LiveAgentStatus {
  readonly agent: string;
  readonly name?: string;
  readonly agentStatus: AgentStatus;
  readonly cwd: string;
  readonly focused: boolean;
  readonly paneId: string;
  readonly tabId: string;
  readonly tabLabel?: string;
  readonly terminalId: string;
}

function toAgentStatus(value: unknown): AgentStatus {
  return (AGENT_STATUSES as readonly unknown[]).includes(value)
    ? (value as AgentStatus)
    : 'unknown';
}

function toLiveAgentStatus(raw: unknown): LiveAgentStatus | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  if (typeof row.agent !== 'string' || typeof row.terminal_id !== 'string') {
    return null;
  }
  return {
    agent: row.agent,
    name: typeof row.name === 'string' ? row.name : undefined,
    agentStatus: toAgentStatus(row.agent_status),
    cwd: typeof row.cwd === 'string' ? row.cwd : '',
    focused: row.focused === true,
    paneId: typeof row.pane_id === 'string' ? row.pane_id : '',
    tabId: typeof row.tab_id === 'string' ? row.tab_id : '',
    ...(typeof row.tab_label === 'string' ? { tabLabel: row.tab_label } : {}),
    terminalId: row.terminal_id,
  };
}

export function parseHerdrAgentList(stdout: string): LiveAgentStatus[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (cause) {
    throw new Error(
      `herdr agent list: output was not valid JSON: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  const agents = (parsed as { result?: { agents?: unknown } } | null)?.result
    ?.agents;
  if (!Array.isArray(agents)) {
    throw new Error(
      'herdr agent list: JSON missing "result.agents" array — unexpected shape',
    );
  }
  return agents
    .map(toLiveAgentStatus)
    .filter((agent): agent is LiveAgentStatus => agent !== null);
}

export async function listLiveAgentStatuses(
  dependencies: HerdrReadOnlyClientDependencies =
    DEFAULT_HERDR_READ_ONLY_CLIENT_DEPENDENCIES,
): Promise<LiveAgentStatus[]> {
  const invocation = resolveHerdrReadOnlyInvocation(
    ['agent', 'list'],
    dependencies.ownedHerdrClientPath,
  );
  const result = await dependencies.executeHerdrReadOnly(
    invocation.executablePath,
    invocation.args,
  );
  const agents = parseHerdrAgentList(result.stdout);
  return agents;
}

export async function listLiveAgentStatusesInSession(
  sessionName: string,
  dependencies: HerdrReadOnlyClientDependencies =
    DEFAULT_HERDR_READ_ONLY_CLIENT_DEPENDENCIES,
): Promise<LiveAgentStatus[]> {
  const invocation = resolveHerdrReadOnlyInvocationForSession(
    sessionName,
    ['agent', 'list'],
    dependencies.ownedHerdrClientPath,
  );
  const result = await dependencies.executeHerdrReadOnly(
    invocation.executablePath,
    invocation.args,
  );
  return parseHerdrAgentList(result.stdout);
}

export async function listLiveAgentStatusesAcrossSessions(
  sessionNames: readonly string[] = THRONE_HERDR_SESSION_NAMES,
  listAgentsInSession: (
    sessionName: string,
  ) => Promise<LiveAgentStatus[]> = listLiveAgentStatusesInSession,
): Promise<LiveAgentStatus[]> {
  const bySession = await Promise.all(
    sessionNames.map(async (sessionName) => ({
      sessionName,
      agents: await listAgentsInSession(sessionName),
    })),
  );
  const sessionOwningName = new Map<string, string>();
  for (const { sessionName, agents } of bySession) {
    for (const agent of agents) {
      const name = agent.tabLabel ?? agent.name;
      if (name === undefined) continue;
      const owningSession = sessionOwningName.get(name);
      if (owningSession !== undefined && owningSession !== sessionName) {
        throw new DuplicateAgentNameAcrossSessionsError(name, [owningSession, sessionName]);
      }
      sessionOwningName.set(name, sessionName);
    }
  }
  return bySession.flatMap((entry) => entry.agents);
}

export async function listLiveAgentStatusesWithClient(
  client: HerdrClientService = new HerdrClientService(),
): Promise<LiveAgentStatus[]> {
  const result = await client.execute(['agent', 'list']);
  return parseHerdrAgentList(result.stdout);
}
