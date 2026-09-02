import { pathToFileURL } from 'node:url';
import { Module, type INestApplicationContext } from '@nestjs/common';
import { CommandFactory, CommandRunnerService } from 'nest-commander';
import {
  AgentStatusesCommand,
  type AgentStatusesCommandDependencies,
} from '../../src/agent-statuses/agent-statuses.command.ts';
import { nestCommanderApplicationOptions } from '../../src/application.ts';
import type { LiveAgentStatus } from '../../src/agent-statuses/agent-statuses-herdr.ts';
import { getAgentStatusesRoster } from '../../src/agent-statuses/agent-statuses-roster.ts';
import type { AgentStatusesDesiredState } from '../../src/agent-statuses/agent-statuses.types.ts';
import { AgentStatusesObservableMutant } from './agent-statuses-observable-mutant.ts';

export interface AgentStatusesParityScenario {
  readonly desiredState: AgentStatusesDesiredState;
  readonly live: readonly LiveAgentStatus[];
  readonly registered: readonly string[];
  readonly completed: readonly string[];
  readonly roles: Readonly<Record<string, string>>;
  readonly rosterFailure?: string;
}

const liveAgent = (
  name: string | undefined,
  agentStatus: LiveAgentStatus['agentStatus'],
  overrides: Partial<LiveAgentStatus> = {},
): LiveAgentStatus => ({
  agent: name === undefined ? 'shell' : 'claude',
  name,
  agentStatus,
  cwd: '/throne',
  focused: false,
  paneId: `pane-${agentStatus}`,
  tabId: `tab-${agentStatus}`,
  terminalId: `terminal-${agentStatus}`,
  ...overrides,
});

export const AGENT_STATUSES_PARITY_SCENARIOS = {
  runningEmpty: {
    desiredState: 'running',
    live: [],
    registered: [],
    completed: [],
    roles: {},
  },
  dismissedMixed: {
    desiredState: 'dismissed',
    live: [
      liveAgent('Regent', 'working', {
        cwd: '/court/very-long-working-directory',
        focused: true,
      }),
      liveAgent('alpha', 'idle'),
      liveAgent('Alpha', 'blocked'),
      liveAgent('done-agent', 'done'),
      liveAgent('unknown-agent', 'unknown'),
      liveAgent(undefined, 'working', { cwd: '', paneId: '' }),
      liveAgent('report-live', 'idle'),
    ],
    registered: ['Regent', 'dead-agent', 'complete-agent', 'report-live'],
    completed: ['complete-agent', 'report-live'],
    roles: {
      Regent: '',
      alpha: '',
      Alpha: 'Alpha',
      'done-agent': 'Shadow',
      'unknown-agent': 'Shadow',
      'report-live': 'Shadow',
      'dead-agent': '',
      'complete-agent': 'Alpha',
    },
  },
  runningWidths: {
    desiredState: 'running',
    live: [
      liveAgent('x', 'idle', { cwd: '/x', paneId: 'p' }),
      liveAgent('a-very-long-agent-name', 'working', {
        cwd: '/short',
        paneId: 'pane-with-width',
      }),
    ],
    registered: ['dead-with-a-long-role'],
    completed: [],
    roles: {
      x: 'S',
      'a-very-long-agent-name': '',
      'dead-with-a-long-role': 'Shadow Garden Operative',
    },
  },
  dismissedFailure: {
    desiredState: 'dismissed',
    live: [],
    registered: [],
    completed: [],
    roles: {},
    rosterFailure: 'deterministic roster failure',
  },
} as const satisfies Readonly<Record<string, AgentStatusesParityScenario>>;

export type AgentStatusesParityScenarioName =
  keyof typeof AGENT_STATUSES_PARITY_SCENARIOS;

export type AgentStatusesParityRoute =
  | 'nest'
  | 'nest-programmatic'
  | 'mutant-programmatic';

export function nestAgentStatusesParityRoster(
  scenario: AgentStatusesParityScenario,
) {
  return getAgentStatusesRoster({
    listLiveAgentStatuses: async () => {
      if (scenario.rosterFailure) throw new Error(scenario.rosterFailure);
      return [...scenario.live];
    },
    listRegisteredAgentNames: async () => [...scenario.registered],
    listCompletedAgentNames: async () => [...scenario.completed],
    readAgentStatusRole: async (name) => scenario.roles[name] ?? '',
    loadAgentStatusesRegentTitle: async () => 'Regent',
    readAgentPaneTail: async () => '',
  });
}

async function runNestCommandStack(
  argv: readonly string[],
  scenario: AgentStatusesParityScenario,
): Promise<number> {
  const dependencies: AgentStatusesCommandDependencies = {
    readAgentStatusesDesiredState: async () => scenario.desiredState,
    getAgentStatusesRoster: async () =>
      nestAgentStatusesParityRoster(scenario),
  };
  class AgentStatusesParityModule {}
  Module({
    providers: [
      {
        provide: AgentStatusesCommand,
        useFactory: () => new AgentStatusesCommand(dependencies),
      },
    ],
  })(AgentStatusesParityModule);

  let application: INestApplicationContext | undefined;
  try {
    application = await CommandFactory.createWithoutRunning(
      AgentStatusesParityModule,
      nestCommanderApplicationOptions(argv),
    );
    await application.get(CommandRunnerService).run([...argv]);
    return Number(process.exitCode ?? 0);
  } finally {
    await application?.close();
  }
}

export async function runAgentStatusesParityDriver(
  route: 'nest',
  scenario: AgentStatusesParityScenario,
  commandArgs: readonly string[],
): Promise<number> {
  return runNestCommandStack(
    [process.execPath, 'src/tools.ts', 'agent-statuses', ...commandArgs],
    scenario,
  );
}

async function runAgentStatusesProgrammatically(
  route: Exclude<AgentStatusesParityRoute, 'nest'>,
  scenario: AgentStatusesParityScenario,
  commandArgs: readonly string[],
): Promise<number> {
  const dependencies: AgentStatusesCommandDependencies = {
    readAgentStatusesDesiredState: async () => scenario.desiredState,
    getAgentStatusesRoster: async () =>
      nestAgentStatusesParityRoster(scenario),
  };
  const command = route === 'nest-programmatic'
    ? new AgentStatusesCommand(dependencies)
    : new AgentStatusesObservableMutant(dependencies);
  await command.run([...commandArgs]);
  return Number(process.exitCode ?? 0);
}

function isParityDriverMain(): boolean {
  return process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isParityDriverMain()) {
  const route = process.argv[2] as AgentStatusesParityRoute | undefined;
  const scenarioName = process.argv[3] as
    | AgentStatusesParityScenarioName
    | undefined;
  if (!route || ![
    'nest',
    'nest-programmatic',
    'mutant-programmatic',
  ].includes(route)) {
    throw new Error(`Unknown agent-statuses parity route: ${String(route)}`);
  }
  const scenario = scenarioName
    ? AGENT_STATUSES_PARITY_SCENARIOS[scenarioName]
    : undefined;
  if (!scenario) {
    throw new Error(`Unknown agent-statuses parity scenario: ${String(scenarioName)}`);
  }
  const execution = route === 'nest'
    ? runAgentStatusesParityDriver(route, scenario, process.argv.slice(4))
    : runAgentStatusesProgrammatically(
        route,
        scenario,
        process.argv.slice(4),
      );
  execution.then(
    (status) => {
      process.exitCode = status;
    },
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
