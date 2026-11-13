import {
  REAL_BLOCKED_AGENT_PAGING_DEPENDENCIES,
  reconcileBlockedAgentPages,
} from '../../src/blocked-paging/blocked-agent-paging.hosted-worker.ts';
import type { BlockedPageLedgerEntry } from '../../src/blocked-paging/blocked-agent-escalation-ledger.ts';
import { AGENT_LIFECYCLE_STATES, type AgentStatusesRosterEntry } from '../../src/agent-statuses/agent-statuses.types.ts';
import type { AgentStatus } from '../../src/herdr/herdr-inventory.service.ts';
import { resolveAgent } from '../../src/herdr/herdr-runtime.service.ts';
import { NO_IDLING_REGENT_NAME } from '../../src/no-idling/idle-family.ts';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ScratchAgent {
  readonly name: string;
  readonly paneId: string;
  readonly cwd: string;
}

export interface Submission {
  readonly recipient: string;
  readonly prompt: string;
  readonly delivered: boolean;
  readonly key?: string;
}

export interface PassRecord {
  readonly agentsVisited: string[];
  readonly submissions: Submission[];
}

export function candidateRememberedPath(agent: ScratchAgent): string {
  return path.join(agent.cwd, 'candidate-own-run-wake.json');
}

export async function runPagerPass(
  agent: ScratchAgent,
  escalationLedger: BlockedPageLedgerEntry[],
  clockMilliseconds: number,
): Promise<PassRecord> {
  const record: PassRecord = { agentsVisited: [], submissions: [] };
  const liveStatus = (await resolveAgent(agent.name)).agentStatus as AgentStatus;
  const entry: AgentStatusesRosterEntry = {
    name: agent.name,
    lifecycle: AGENT_LIFECYCLE_STATES.LIVE,
    liveStatus,
    reportLanded: false,
    role: 'Shadow',
    cwd: agent.cwd,
    paneId: agent.paneId,
    focused: false,
  };
  await reconcileBlockedAgentPages({
    ...REAL_BLOCKED_AGENT_PAGING_DEPENDENCIES,
    getRoster: async () => {
      record.agentsVisited.push(agent.name);
      return [entry];
    },
    readAgentSupervisor: async () => '',
    readRememberedOwnRunWait: async () => {
      try {
        return JSON.parse(await readFile(candidateRememberedPath(agent), 'utf8'));
      } catch {
        return null;
      }
    },
    writeRememberedOwnRunWait: async (_name, remembered) => {
      await writeFile(candidateRememberedPath(agent), `${JSON.stringify(remembered)}\n`);
    },
    submitToAgent: async (target, sender, prompt, options) => {
      const recipient = target.name ?? '';
      const delivered = recipient === agent.name;
      record.submissions.push({ recipient, prompt, delivered, key: options?.key });
      if (delivered) await REAL_BLOCKED_AGENT_PAGING_DEPENDENCIES.submitToAgent(target, sender, prompt, options);
    },
    resolveAgent: async (name) =>
      name === NO_IDLING_REGENT_NAME ? { name, agent: 'claude', agentStatus: 'idle' } as never : resolveAgent(name),
    readEscalationLedger: async () => [...escalationLedger],
    appendEscalationLedger: async (ledgerEntry) => {
      escalationLedger.push(ledgerEntry);
    },
    notifyLord: async (message) => {
      record.submissions.push({ recipient: 'Lord', prompt: message, delivered: false });
      return true;
    },
    now: () => clockMilliseconds,
    stderr: (text) => process.stderr.write(text),
  });
  return record;
}
