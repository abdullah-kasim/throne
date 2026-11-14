import { text as readStreamAsText } from 'node:stream/consumers';
import {
  AGENT_STATES,
  LONGEST_REMIND_IN_MINUTES,
  SHORTEST_REMIND_IN_MINUTES,
  declareAgentState,
  isAgentStateName,
  readAgentState,
  type AgentStateDeclaration,
} from '../agentdata/agent-state.service.ts';
import { IdentityLineReadStatus, readAgentRole, type IdentityLineRead } from '../agentdata/identity-data.service.ts';
import { resolveCurrentAgentName } from '../herdr/herdr-session.service.ts';
import { canonicalRegentAuthority } from '../shared-policy/regent-authority.ts';
import { stateFromTurnEndMessage } from './turn-end-marker.ts';

export const MY_STATE_USAGE =
  'usage: throne my-state <state> [--by <child>]... [--agent <name>] [<words>]\n' +
  `  states: ${AGENT_STATES.join(', ')}\n` +
  '  blocked: --by names each child you wait on\n' +
  '  waiting-on-own-run: the words say what you are waiting on\n' +
  '  reapable: the words give the reason, for example completed\n' +
  '  --agent: the Regent only, to write another agent\'s state\n' +
  'usage: throne my-state --turn-end < <final message>\n' +
  '  records the state a marker line in your turn\'s final message declares\n';

const TURN_END_OPTION = '--turn-end';

export interface MyStateDependencies {
  currentAgentName: () => Promise<string>;
  readRole: (name: string) => Promise<IdentityLineRead>;
  readMessage: () => Promise<string>;
  dataDirectory?: string;
  print: (text: string) => void;
  printError: (text: string) => void;
}

const productionDependencies: MyStateDependencies = {
  currentAgentName: resolveCurrentAgentName,
  readRole: (name) => readAgentRole(name),
  readMessage: () => readStreamAsText(process.stdin),
  print: (text) => process.stdout.write(text),
  printError: (text) => process.stderr.write(text),
};

interface MyStateRequest {
  state: string;
  children: string[];
  targetAgent: string | undefined;
  words: string[];
  remindInMinutes: number | undefined;
}

const REMIND_IN_OPTION = '--remind-in';

function parseRemindInMinutes(value: string | undefined): number | string {
  const refusal = `${REMIND_IN_OPTION} needs a whole number of minutes from ${SHORTEST_REMIND_IN_MINUTES} to ${LONGEST_REMIND_IN_MINUTES}`;
  if (value === undefined || !/^\d+$/.test(value)) return refusal;
  const minutes = Number(value);
  if (minutes < SHORTEST_REMIND_IN_MINUTES || minutes > LONGEST_REMIND_IN_MINUTES) return refusal;
  return minutes;
}

function parseRequest(passedParams: readonly string[]): MyStateRequest | string {
  const [state, ...rest] = passedParams;
  if (state === undefined) return 'a state is required';
  const request: MyStateRequest = { state, children: [], targetAgent: undefined, words: [], remindInMinutes: undefined };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (argument === '--by' || argument === '--agent') {
      const value = rest[index + 1];
      if (value === undefined) return `${argument} needs a name`;
      if (argument === '--by') request.children.push(value);
      else request.targetAgent = value;
      index += 1;
    } else if (argument === REMIND_IN_OPTION) {
      const minutes = parseRemindInMinutes(rest[index + 1]);
      if (typeof minutes === 'string') return minutes;
      request.remindInMinutes = minutes;
      index += 1;
    } else {
      request.words.push(argument);
    }
  }
  return request;
}

async function callerIsRegent(caller: string, deps: MyStateDependencies): Promise<boolean> {
  if (canonicalRegentAuthority(caller) !== undefined) return true;
  const role = await deps.readRole(caller);
  return role.status === IdentityLineReadStatus.Found && role.value.toLowerCase() === 'regent';
}

export async function runMyState(
  passedParams: readonly string[],
  deps: MyStateDependencies = productionDependencies,
): Promise<number> {
  if (passedParams[0] === TURN_END_OPTION) return recordTurnEndMarker(deps);
  const request = parseRequest(passedParams);
  if (typeof request === 'string') {
    deps.printError(`my-state: ${request}\n${MY_STATE_USAGE}`);
    return 2;
  }
  if (!isAgentStateName(request.state)) {
    deps.printError(`my-state: unknown state "${request.state}"\n${MY_STATE_USAGE}`);
    return 2;
  }
  const caller = await deps.currentAgentName();
  const target = request.targetAgent ?? caller;
  const writesAnotherAgent = target !== caller;
  if (writesAnotherAgent && !(await callerIsRegent(caller, deps))) {
    deps.printError(`my-state: only the Regent may write another agent's state; "${caller}" may write only its own\n`);
    return 1;
  }
  const words = request.words.join(' ').trim();
  const declaration: AgentStateDeclaration = {
    state: request.state,
    blockedBy: request.children,
    waitingOn: request.state === 'reapable' || words === '' ? null : words,
    reapableReason: request.state === 'reapable' && words !== '' ? words : null,
    declaredBy: writesAnotherAgent ? 'regent' : 'agent',
    remindInMinutes: request.remindInMinutes,
  };
  const written = await declareAgentState(target, declaration, deps.dataDirectory);
  deps.print(`${target}: ${written.state}\n`);
  return 0;
}

async function recordTurnEndMarker(deps: MyStateDependencies): Promise<number> {
  const declaration = stateFromTurnEndMessage(await deps.readMessage());
  if (declaration === null) return 0;
  const caller = await deps.currentAgentName();
  const current = await readAgentState(caller, deps.dataDirectory);
  if (current.declaredBy !== 'turn-start') return 0;
  const written = await declareAgentState(caller, declaration, deps.dataDirectory);
  deps.print(`${caller}: ${written.state}\n`);
  return 0;
}
