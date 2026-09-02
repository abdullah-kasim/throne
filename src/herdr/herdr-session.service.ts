import { Injectable } from '@nestjs/common';
import { AgentResolutionError } from '../herdr/herdr-identity-contracts.ts';
import type { HerdrAgent } from '../herdr/herdr-inventory.service.ts';
import { HerdrClientService } from './herdr-client.ts';
import { parseHerdrAgentList } from '../agent-statuses/agent-statuses-herdr.ts';

export async function insideHerdr(): Promise<boolean> {
  return new HerdrSessionService().isInside();
}

export async function currentPaneId(): Promise<string> {
  return new HerdrSessionService().currentPaneId();
}

export async function resolveCurrentAgentName(): Promise<string> {
  return new HerdrSessionService().resolveCurrentAgentName();
}

@Injectable()
export class HerdrSessionService {
  private readonly client: HerdrClientService;

  constructor(client: HerdrClientService = new HerdrClientService()) {
    this.client = client;
  }

  async isInside(): Promise<boolean> {
    try {
      await this.client.execute(['pane', 'current']);
      return true;
    } catch {
      return false;
    }
  }

  async currentPaneId(): Promise<string> {
    const fromEnv = process.env.HERDR_PANE_ID;
    if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
    const { stdout } = await this.client.execute(['pane', 'current']);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (cause) {
      throw new Error(
        `herdr pane current: output was not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    const paneId = (parsed as { result?: { pane?: { pane_id?: unknown } } } | null)
      ?.result?.pane?.pane_id;
    if (typeof paneId !== 'string' || paneId.length === 0) {
      throw new Error(
        'herdr pane current: JSON missing "result.pane.pane_id" — not inside a herdr session?',
      );
    }
    return paneId;
  }

  async resolveCurrentAgentName(): Promise<string> {
    const paneId = await this.currentPaneId();
    const agents: HerdrAgent[] = parseHerdrAgentList(
      (await this.client.execute(['agent', 'list'])).stdout,
    ).map((agent) => ({
      ...agent,
      name: agent.name,
    }));
    const paneMatches = agents.filter((agent) => agent.paneId === paneId);
    if (paneMatches.length !== 1) {
      throw new Error(`current herdr pane "${paneId}" resolves to ${paneMatches.length} live agents`);
    }
    const current = paneMatches[0]!;
    if (!current.name) {
      throw new Error(`current herdr pane "${paneId}" has no canonical agent name`);
    }
    const nameMatches = agents.filter((agent) => agent.name === current.name);
    if (nameMatches.length !== 1) throw new AgentResolutionError(current.name, nameMatches.length);
    return current.name;
  }
}

