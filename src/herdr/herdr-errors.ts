import type { HerdrCommandError } from "./herdr-client.ts";

export const OPENING_PROMPT_NAME_REGISTRATION_ATTEMPTS = 31;
export const OPENING_PROMPT_NAME_REGISTRATION_POLL_MILLISECONDS = 100;

export class OpeningPromptDeliveryError extends Error {
  readonly name = "OpeningPromptDeliveryError";
  readonly agentName: string;
  readonly retrySafe: boolean;
  constructor(
    agentName: string,
    retrySafe: boolean,
    detail: string,
    cause?: unknown,
  ) {
    super(
      `opening prompt for "${agentName}" was ${retrySafe ? "not delivered" : "left indeterminate"}: ${detail}`,
      cause === undefined ? undefined : { cause },
    );
    this.agentName = agentName;
    this.retrySafe = retrySafe;
  }
}

export class RegisteredAgentRestoredTabCollisionError extends Error {
  readonly name = "RegisteredAgentRestoredTabCollisionError";
  readonly registeredAgentName: string;
  constructor(
    registeredAgentName: string,
    detail: string,
    cause?: unknown,
  ) {
    super(
      `cannot resume registered agent "${registeredAgentName}" in its restored tab: ${detail}`,
      cause === undefined ? undefined : { cause },
    );
    this.registeredAgentName = registeredAgentName;
  }
}

export class AgentStartIndeterminateError extends Error {
  readonly name = "AgentStartIndeterminateError";
  readonly agentName: string;
  readonly tabId: string;
  readonly paneId: string;
  constructor(
    agentName: string,
    tabId: string,
    paneId: string,
    cause: unknown,
  ) {
    super(
      `direct harness launch for "${agentName}" failed after the command was issued; exact tab "${tabId}" and pane "${paneId}" were RETAINED because a harness may already be live there — reconcile that exact tab instead of spawning again`,
      { cause },
    );
    this.agentName = agentName;
    this.tabId = tabId;
    this.paneId = paneId;
  }
}

export class AgentStartPaneBusyError extends Error {
  readonly name = "AgentStartPaneBusyError";
  readonly agentName: string;
  readonly tabId: string;
  readonly paneId: string;
  readonly attempts: number;
  constructor(
    agentName: string,
    tabId: string,
    paneId: string,
    attempts: number,
    cause: HerdrCommandError,
  ) {
    super(
      `herdr agent start for "${agentName}" was rejected as pane-busy on all ${attempts} bounded attempts against pane "${paneId}", whose shell had already executed the readiness sentinel; no agent was registered`,
      { cause },
    );
    this.agentName = agentName;
    this.tabId = tabId;
    this.paneId = paneId;
    this.attempts = attempts;
  }
}
