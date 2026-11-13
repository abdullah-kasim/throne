import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { writeBlockedMarker, readBlockedMarker, clearBlockedMarker } from '../../src/agentdata/blocked-marker.service.ts';
import { readAgent, resolveAgent } from '../../src/herdr/herdr-runtime.service.ts';
import { classifyLastMessageTags, lastMessageBlock } from '../../src/no-idling/idle-pane-tag-classification.ts';
import { resolveBlockedTag, type BlockedMarkerLedger } from '../../src/no-idling/blocked-marker-resolution.ts';
import { registerScratchPane } from '../../src/scratch-pane/scratch-pane.ts';
import { agentRegistrationExists } from '../../src/agentdata/spawn-data-contracts.ts';
import { THRONE_DATA_DIR, resolveThroneHome } from '../../src/shared-policy/throne-home.ts';

const runFile = promisify(execFile);

export const OWN_RUN_MARKER = '{"blocked":true} BLOCKED_BY_own-background-run (x)';
export const WAKE_OPENING = 'You are waiting on your own background run.';
const HARNESS_COMMAND = 'claude --model haiku --dangerously-skip-permissions';
const POLL_MILLISECONDS = 500;
const PROMPT_ATTEMPTS = 3;
const DELIVERED_WAKE = /<message\d+>\s+You are waiting on your own background run\./g;
export const SCRATCH_NAME_PREFIX = 'ownrunwake-';

export const SWEEP_LEDGER: BlockedMarkerLedger = {
  readBlockedMarker: (name) => readBlockedMarker(name),
  writeBlockedMarker: (name, blockedBy) => writeBlockedMarker(name, { blockedBy }),
  clearBlockedMarker: (name) => clearBlockedMarker(name),
};

async function herdr(...commandArguments: string[]): Promise<string> {
  const { stdout } = await runFile('herdr', commandArguments, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

export async function waitUntil(check: () => Promise<boolean>, timeoutMilliseconds: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MILLISECONDS));
  }
  return check();
}

function workspaceOfThisPane(): string {
  return (process.env.HERDR_PANE_ID ?? 'w1:').split(':')[0] ?? 'w1';
}

export class ScratchHarness {
  readonly startedProcessGroups: number[] = [];

  private constructor(
    readonly name: string,
    readonly paneId: string,
    readonly tabId: string,
    readonly directory: string,
  ) {}

  static async open(name: string, directory: string, owner: string): Promise<ScratchHarness> {
    if (!name.startsWith(SCRATCH_NAME_PREFIX)) throw new Error(`scratch harness names start with ${SCRATCH_NAME_PREFIX}`);
    await mkdir(directory, { recursive: true });
    const created = JSON.parse(
      await herdr('tab', 'create', '--workspace', workspaceOfThisPane(), '--cwd', directory, '--label', name),
    ) as { result: { root_pane: { pane_id: string }; tab: { tab_id: string } } };
    const harness = new ScratchHarness(name, created.result.root_pane.pane_id, created.result.tab.tab_id, directory);
    try {
      await registerScratchPane(
        { paneId: harness.paneId, owner, until: new Date(Date.now() + 60 * 60 * 1000) },
        {
          environment: process.env,
          now: () => new Date(),
          isKnownAgent: (agentName) => agentRegistrationExists(agentName, THRONE_DATA_DIR),
          writeStdout: () => undefined,
          writeStderr: () => undefined,
        },
      );
      await herdr('pane', 'run', harness.paneId, HARNESS_COMMAND);
      const ready = await waitUntil(async () => (await harness.screen()).includes('bypass permissions'), 60_000);
      if (!ready) throw new Error(`the Claude harness in ${harness.paneId} never showed its prompt`);
      const named = await waitUntil(
        async () => herdr('agent', 'rename', harness.paneId, name).then(() => true, () => false),
        60_000,
      );
      if (!named) throw new Error(`herdr never saw an agent in ${harness.paneId} to name`);
      await mkdir(path.join(THRONE_DATA_DIR, name), { recursive: true });
      return harness;
    } catch (error) {
      await harness.close();
      throw error;
    }
  }

  async screen(): Promise<string> {
    return herdr('pane', 'read', this.paneId);
  }

  async transcript(): Promise<string> {
    return readAgent(this.name, { lines: 400 }).catch(async () => this.screen());
  }

  async status(): Promise<string> {
    return (await resolveAgent(this.name)).agentStatus;
  }

  async isIdle(): Promise<boolean> {
    return ['idle', 'done'].includes(await this.status());
  }

  async say(text: string): Promise<void> {
    for (let attempt = 1; attempt <= PROMPT_ATTEMPTS; attempt += 1) {
      await herdr('agent', 'prompt', this.name, text);
      if (await waitUntil(async () => (await this.status()) === 'working', 15_000)) break;
    }
    await waitUntil(() => this.isIdle(), 120_000);
  }

  async lastMessageTag(): Promise<ReturnType<typeof classifyLastMessageTags>> {
    return classifyLastMessageTags(lastMessageBlock(await this.transcript()));
  }

  async publish(marker: string): Promise<void> {
    await this.sayUntilMarked(`Print the following text verbatim as your whole reply, every character, inside no code block, and use no tool: ${marker}`);
  }

  async sayUntilMarked(text: string): Promise<void> {
    for (let attempt = 1; attempt <= PROMPT_ATTEMPTS; attempt += 1) {
      await this.say(text);
      const tag = await this.lastMessageTag();
      if (tag.kind === 'blocked' && (tag.waitsOnOwnBackgroundRun === true || tag.blockedBy.length > 0)) {
        if (await waitUntil(() => this.isIdle(), 60_000)) return;
        throw new Error(`${this.name} published the blocked marker but never went idle`);
      }
    }
    throw new Error(`${this.name} never published the blocked marker`);
  }

  async sweep(): Promise<void> {
    await resolveBlockedTag(this.name, () => this.lastMessageTag(), SWEEP_LEDGER);
  }

  async blockedAt(): Promise<number> {
    const marker = await readBlockedMarker(this.name);
    if (marker === null) throw new Error(`${this.name} has no blocked marker in the ledger`);
    return Date.parse(marker.blockedAt);
  }

  async start(shellCommand: string): Promise<number> {
    const child = spawn('sh', ['-c', `${shellCommand} </dev/null >/dev/null 2>&1 & echo $!`], {
      cwd: this.directory,
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (child.pid !== undefined) this.startedProcessGroups.push(child.pid);
    let printed = '';
    child.stdout.on('data', (chunk: Buffer) => {
      printed += chunk.toString();
    });
    await new Promise((resolve) => child.on('close', resolve));
    const pid = Number(printed.trim());
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`could not start ${shellCommand}`);
    return pid;
  }

  async composerIsEmpty(): Promise<boolean> {
    const promptLines = (await this.screen()).split('\n').filter((line) => line.startsWith('❯'));
    return (promptLines.at(-1) ?? '').trim() === '❯';
  }

  async repliedAfterLastMessage(): Promise<boolean> {
    const transcript = await this.transcript();
    return /●\s*\S/.test(transcript.slice(transcript.lastIndexOf('</message')));
  }

  async wakesReceived(): Promise<number> {
    return (await this.transcript()).match(DELIVERED_WAKE)?.length ?? 0;
  }

  async capture(file: string): Promise<void> {
    await writeFile(file, await this.transcript().catch(async () => this.screen()));
  }

  async close(): Promise<void> {
    for (const group of this.startedProcessGroups) {
      try {
        process.kill(-group, 'SIGKILL');
      } catch {
        continue;
      }
    }
    await herdr('tab', 'close', this.tabId).catch(() => '');
    await killProcessesWorkingIn(this.directory);
    await rm(path.join(resolveThroneHome(), 'scratch-panes', `${encodeURIComponent(this.paneId)}.json`), { force: true });
    await rm(path.join(THRONE_DATA_DIR, this.name), { recursive: true, force: true });
  }
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function processesWorkingIn(folder: string): Promise<{ pid: number; command: string }[]> {
  const directory = await realpath(folder).catch(() => folder);
  const found: { pid: number; command: string }[] = [];
  for (const entry of await readdir('/proc')) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    const workingDirectory = await readlink(`/proc/${pid}/cwd`).catch(() => '');
    if (workingDirectory !== directory && !workingDirectory.startsWith(`${directory}/`)) continue;
    const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
    found.push({ pid, command: command.split('\0').join(' ').trim() });
  }
  return found;
}

async function killProcessesWorkingIn(directory: string): Promise<void> {
  for (const { pid } of await processesWorkingIn(directory)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      continue;
    }
  }
}
