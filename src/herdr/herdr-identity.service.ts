import { Injectable } from '@nestjs/common';
import type { HerdrAgent } from './herdr-identity-contracts.ts';
import { AgentResolutionError, sameAgentName } from './herdr-identity-contracts.ts';

export { AgentResolutionError } from './herdr-identity-contracts.ts';

export const HERDR_AGENT_NAME_MAX_LENGTH = 32;
const HERDR_AGENT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function herdrAgentNameRefusal(name: string): string | undefined {
  if (name.length > HERDR_AGENT_NAME_MAX_LENGTH) {
    return `agent name "${name}" is ${name.length} characters; Herdr allows at most ${HERDR_AGENT_NAME_MAX_LENGTH}`;
  }
  if (!HERDR_AGENT_NAME_PATTERN.test(name)) {
    return `agent name "${name}" must be lowercase ASCII alphanumeric words separated by single hyphens`;
  }
  return undefined;
}


export function sameRecipientPaneIdentity(initial: HerdrAgent, refreshed: HerdrAgent): boolean {
  return initial.terminalId === refreshed.terminalId &&
    initial.tabId === refreshed.tabId &&
    initial.paneId === refreshed.paneId &&
    initial.agent === refreshed.agent;
}

export function sameNamedRecipientIdentity(initial: HerdrAgent, refreshed: HerdrAgent): boolean {
  return initial.name === refreshed.name && sameRecipientPaneIdentity(initial, refreshed);
}

export function namedRecipientIdentityText(agent: HerdrAgent): string {
  return `name=${JSON.stringify(agent.name)}, pane=${JSON.stringify(agent.paneId)}, terminal=${JSON.stringify(agent.terminalId)}, harness=${JSON.stringify(agent.agent)}`;
}

@Injectable()
export class HerdrIdentityService {
  readonly sameAgentName = sameAgentName;
  readonly AgentResolutionError = AgentResolutionError;
}
