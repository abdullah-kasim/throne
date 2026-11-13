import type { AgentState } from '../agentdata/agent-state.service.ts';
import type { LastMessageTagState } from './idle-pane-tag-classification.ts';

export type ReadAgentState = (name: string) => Promise<AgentState>;

const FAILED_REAPABLE_REASON = /^\s*fail/i;

export function tagOfAgentState(declared: AgentState, running: string | undefined): LastMessageTagState {
  switch (declared.state) {
    case 'blocked':
      return { kind: 'blocked', blockedBy: declared.blockedBy };
    case 'waiting-on-own-run':
      return { kind: 'blocked', blockedBy: [], waitsOnOwnBackgroundRun: true };
    case 'waiting-on-supervisor':
      return { kind: 'blocked', blockedBy: [] };
    case 'reapable':
      return FAILED_REAPABLE_REASON.test(declared.reapableReason ?? '')
        ? { kind: 'reapable-failed' }
        : { kind: 'reapable' };
    case 'working':
      return running === undefined ? { kind: 'unmarked' } : { kind: 'busy', running };
  }
}

export async function readDeclaredTag(
  name: string,
  readAgentState: ReadAgentState,
  readRunning: () => Promise<string | undefined> = async () => undefined,
): Promise<LastMessageTagState> {
  try {
    const declared = await readAgentState(name);
    return tagOfAgentState(declared, declared.state === 'working' ? await readRunning() : undefined);
  } catch {
    return { kind: 'unreadable' };
  }
}
