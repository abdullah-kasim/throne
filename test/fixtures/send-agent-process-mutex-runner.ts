import net from 'node:net';
import { runNestCommanderApplication } from '../../src/application.ts';
import { parseAgentList, parsePaneProcessInfo, type HerdrAgent } from '../../src/herdr/herdr-inventory.service.ts';
import { submitToAgent } from '../../src/herdr/herdr-send.service.ts';
import { RecipientPaneLockService } from '../../src/shared-policy/recipient-pane-lock.service.ts';
import { stagePayload } from '../../src/send-agent/payload-transport.ts';
import type { SendAgentCommandDependencies } from '../../src/send-agent/send-agent-dependencies.types.ts';
import type { KeepGoingDependencies } from '../../src/keep-going/keep-going.command.ts';
import type { SubmitToAgentDeps } from '../../src/herdr/herdr-send.types.ts';

interface HerdrResponse { code: number; stdout: string; stderr: string }
const socketPath = process.env.MUTEX_TEST_SOCKET;
const producer = process.env.MUTEX_TEST_PRODUCER;
if (!socketPath || !producer) throw new Error('missing fake Herdr environment');

const fixtureStart = Date.now();
let fixtureElapsed = 0;

function request(args: string[]): Promise<HerdrResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath!);
    socket.setEncoding('utf8');
    let input = '';
    socket.once('connect', () => socket.write(JSON.stringify({ producer, args: ['--session', 'throne', ...args] }) + '\n'));
    socket.on('data', (chunk: string) => {
      input += chunk;
      const newline = input.indexOf('\n');
      if (newline === -1) return;
      const response = JSON.parse(input.slice(0, newline)) as HerdrResponse;
      socket.end();
      resolve(response);
    });
    socket.once('error', reject);
  });
}

async function runFakeHerdr(args: string[]): Promise<string> {
  const response = await request(args);
  if (response.code !== 0) throw new Error(response.stderr || `fake herdr exited ${response.code}`);
  return response.stdout;
}

async function listAgents(): Promise<HerdrAgent[]> { return parseAgentList(await runFakeHerdr(['agent', 'list'])); }
async function resolveAgent(name: string): Promise<HerdrAgent> {
  const matches = (await listAgents()).filter((agent) => agent.name?.toLowerCase() === name.toLowerCase());
  if (matches.length !== 1) throw new Error(`expected one fake agent named "${name}", found ${matches.length}`);
  return matches[0]!;
}

const sendText: SubmitToAgentDeps['sendText'] = async (paneId, text) => { await runFakeHerdr(['pane', 'send-text', paneId, text]); };
const pressEnter: SubmitToAgentDeps['pressEnter'] = async (paneId) => { await runFakeHerdr(['pane', 'send-keys', paneId, 'Enter']); };
const pressPaneKey: SubmitToAgentDeps['pressPaneKey'] = async (paneId, key) => { await runFakeHerdr(['pane', 'send-keys', paneId, key]); };
const getPaneProcessInfo: SubmitToAgentDeps['getPaneProcessInfo'] = async (paneId) => parsePaneProcessInfo(await runFakeHerdr(['pane', 'process-info', '--pane', paneId]));
const readScreen = async (paneId: string): Promise<string> => JSON.parse(await runFakeHerdr(['agent', 'read', paneId, '--source', 'visible']))?.result?.read?.text ?? '';
const lock = new RecipientPaneLockService();
const submitDeps: SubmitToAgentDeps = {
  sendText, pressEnter, pressPaneKey, getPaneProcessInfo,
  // This fixture exercises the recipient MUTEX, not omp delivery; the omp
  // branch never runs for its claude-harness agents.
  deliverToOmp: async () => ({ kind: 'delivered' }) as const,
  readVisibleAgentAnsi: readScreen, readRecentAgentAnsi: readScreen,
  readVisibleCodexAgentAnsi: readScreen, readRecentCodexAgentAnsi: readScreen,
  sleep: async (milliseconds) => {
    fixtureElapsed += milliseconds;
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  },
  now: () => fixtureStart + fixtureElapsed,
  refreshRecipientIdentity: resolveAgent,
  withRecipientPaneLock: lock.withRecipientPaneLock.bind(lock), stagePayload,
  fileBackedPayloadsEnabled: false,
};
const sendAgentDependencies: SendAgentCommandDependencies = {
  resolveAgent,
  resolveCurrentAgentName: async () => producer,
  submitToAgent: (recipient, sender, prompt, options) => submitToAgent(recipient as HerdrAgent, sender, prompt, options, submitDeps),
};
const keepGoingDependencies: KeepGoingDependencies = {
  resolveAgent, findLiveRegent: async () => null,
  readDesiredState: async () => 'dismissed', resurrectRegent: async () => undefined,
  submitToAgent: (target, sender, prompt, options) => submitToAgent(target, sender, prompt, options, submitDeps),
  evaluateThrottle: async () => ({ shouldNudge: false, signal: { status: 'unsupported' as const }, band: { name: 'NORMAL', minIntervalMs: 0, advisory: '' } }),
  now: () => new Date(),
};
process.exitCode = await runNestCommanderApplication(process.argv, sendAgentDependencies, keepGoingDependencies);
