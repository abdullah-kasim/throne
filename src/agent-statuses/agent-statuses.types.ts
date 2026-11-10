import type { AgentStatus } from './agent-statuses-herdr.ts';

export const AGENT_LIFECYCLE_STATES = {
  LIVE: 'live',
  DEAD: 'dead',
  COMPLETE: 'complete',
} as const;

export type AgentLifecycle =
  (typeof AGENT_LIFECYCLE_STATES)[keyof typeof AGENT_LIFECYCLE_STATES];

export interface AgentStatusesRosterEntry {
  readonly name: string;
  readonly lifecycle: AgentLifecycle;
  readonly liveStatus?: AgentStatus;
  readonly reportLanded: boolean;
  readonly role?: string;
  readonly cwd?: string;
  readonly paneId?: string;
  readonly focused: boolean;
  readonly backgroundWorkCorrection?: BackgroundWorkCorrection;
}

export interface BackgroundWorkCorrection {
  readonly reportedStatus: AgentStatus;
  readonly description: string;
}

export const AGENT_STATUSES_DESIRED_STATES = {
  RUNNING: 'running',
  DISMISSED: 'dismissed',
} as const;

export type AgentStatusesDesiredState =
  (typeof AGENT_STATUSES_DESIRED_STATES)[keyof typeof AGENT_STATUSES_DESIRED_STATES];
