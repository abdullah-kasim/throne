import { execFile, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { RecipientPaneLockService } from '../shared-policy/recipient-pane-lock.service.ts';
import { executeHerdrOverSocketOrCommandLine } from './herdr-socket.ts';

export const OWNED_HERDR_CLIENT_RELEASE_TAG = 'v0.9.5';

/** The session name every herdr-dependent command targets. Resolved once, at
 *  module load, from `THRONE_HERDR_SESSION_NAME_OVERRIDE`: a set non-empty
 *  value replaces the default; unset or empty reproduces today's `'throne'`
 *  literal exactly. */
export function resolveThroneHerdrSessionName(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.THRONE_HERDR_SESSION_NAME_OVERRIDE;
  return override && override.length > 0 ? override : 'throne';
}

export const THRONE_HERDR_SESSION_NAME = resolveThroneHerdrSessionName();
export const THRONE_HERDR_SESSION_NAMES: readonly string[] = [
  THRONE_HERDR_SESSION_NAME,
  'throne-bot',
];

export class DuplicateAgentNameAcrossSessionsError extends Error {
  readonly name = 'DuplicateAgentNameAcrossSessionsError';
  constructor(agentName: string, sessionNames: readonly string[]) {
    super(
      `agent name "${agentName}" exists in more than one registered herdr session (${sessionNames.join(', ')}); addressing it is ambiguous`,
    );
  }
}
export const THRONE_HERDR_PROTOCOL = '22';
export const CODEX_HERDR_READ_TIMEOUT_MS = 10_000;
export const THRONE_HERDR_SESSION = THRONE_HERDR_SESSION_NAME;
export interface HerdrAttachBoundary {
  attach(executablePath: string, args: string[]): Promise<number>;
}

export interface HerdrProcessBoundary {
  execute(
    executablePath: string,
    args: readonly string[],
    options?: { env?: NodeJS.ProcessEnv; timeoutMilliseconds?: number },
  ): Promise<HerdrReadOnlyResult>;
}

export class HerdrCompatibilityError extends Error {
  readonly name = 'HerdrCompatibilityError';
}

export interface HerdrReadOnlyInvocation {
  readonly executablePath: string;
  readonly args: readonly string[];
}

export interface HerdrReadOnlyResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface HerdrReadOnlyClientDependencies {
  readonly ownedHerdrClientPath: () => string;
  readonly executeHerdrReadOnly: (
    executablePath: string,
    args: readonly string[],
    options?: { env?: NodeJS.ProcessEnv; timeoutMilliseconds?: number },
  ) => Promise<HerdrReadOnlyResult>;
}

const MUTATING_HERDR_COMMANDS = new Set([
  'agent prompt',
  'agent rename',
  'pane run',
  'pane close',
  'pane send-keys',
  'pane send-text',
  'tab close',
  'tab create',
  'tab rename',
]);

export function isMutatingHerdrCommand(commandArgs: readonly string[]): boolean {
  return MUTATING_HERDR_COMMANDS.has(`${commandArgs[0] ?? ''} ${commandArgs[1] ?? ''}`);
}

export class NestHerdrCommandError extends Error {
  readonly name = 'HerdrCommandError';
  readonly args: readonly string[];
  readonly code?: string;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    args: readonly string[],
    detail: string,
    options: {
      code?: string;
      stdout?: string;
      stderr?: string;
      cause?: unknown;
    } = {},
  ) {
    super(
      `herdr ${args.join(' ')} failed${options.code ? ` (${options.code})` : ''}: ${detail}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.args = [...args];
    this.code = options.code;
    this.stdout = options.stdout ?? '';
    this.stderr = options.stderr ?? '';
  }
}

export { NestHerdrCommandError as HerdrCommandError };

export const HERDR_SERVER_NOT_RUNNING_ERROR_CODE = 'server_not_running';

export function isHerdrServerNotRunning(failure: unknown): boolean {
  return (
    failure instanceof NestHerdrCommandError &&
    failure.code === HERDR_SERVER_NOT_RUNNING_ERROR_CODE
  );
}

const HERDR_ERROR_CODES_MEANING_THE_SERVER_CHANGED = new Set([
  HERDR_SERVER_NOT_RUNNING_ERROR_CODE,
  'server_unavailable',
  'protocol_mismatch',
]);

export function herdrFailureMeansServerChanged(failure: unknown): boolean {
  return (
    failure instanceof NestHerdrCommandError &&
    failure.code !== undefined &&
    HERDR_ERROR_CODES_MEANING_THE_SERVER_CHANGED.has(failure.code)
  );
}

type HerdrExecute = HerdrReadOnlyClientDependencies['executeHerdrReadOnly'];

const compatibleHerdrByExecute = new WeakMap<HerdrExecute, string>();

function herdrIdentity(executablePath: string): string {
  try {
    const binary = statSync(executablePath);
    return [executablePath, binary.ino, binary.size, binary.mtimeMs, THRONE_HERDR_SESSION_NAME].join('|');
  } catch {
    return [executablePath, 'unreadable', THRONE_HERDR_SESSION_NAME].join('|');
  }
}

export const HERDR_PANE_NOT_FOUND_ERROR_CODE = 'pane_not_found';

export function isHerdrPaneGone(failure: unknown): boolean {
  if (failure instanceof NestHerdrCommandError) {
    return failure.code === HERDR_PANE_NOT_FOUND_ERROR_CODE;
  }
  return failure instanceof Error && isHerdrPaneGone(failure.cause);
}

export async function listAgentsReadingStoppedSessionAsEmpty<Agent>(
  sessionName: string,
  listAgentsInSession: (sessionName: string) => Promise<Agent[]>,
): Promise<Agent[]> {
  try {
    return await listAgentsInSession(sessionName);
  } catch (failure) {
    if (isHerdrServerNotRunning(failure)) return [];
    throw failure;
  }
}

export function ownedHerdrClientPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir(),
): string {
  const explicitPath = env.THRONE_HERDR_CLIENT_PATH?.trim();
  if (explicitPath) return explicitPath;
  const dataHome = env.XDG_DATA_HOME?.trim() || path.join(homeDirectory, '.local', 'share');
  return path.join(
    dataHome,
    'throne',
    'herdr',
    OWNED_HERDR_CLIENT_RELEASE_TAG,
    'herdr',
  );
}

export function resolveHerdrReadOnlyInvocation(
  commandArgs: readonly string[],
  resolveOwnedHerdrClientPath: () => string = ownedHerdrClientPath,
): HerdrReadOnlyInvocation {
  return resolveHerdrReadOnlyInvocationForSession(
    THRONE_HERDR_SESSION_NAME,
    commandArgs,
    resolveOwnedHerdrClientPath,
  );
}

export function resolveHerdrReadOnlyInvocationForSession(
  sessionName: string,
  commandArgs: readonly string[],
  resolveOwnedHerdrClientPath: () => string = ownedHerdrClientPath,
): HerdrReadOnlyInvocation {
  return {
    executablePath: resolveOwnedHerdrClientPath(),
    args: ['--session', sessionName, ...commandArgs],
  };
}

export function parseHerdrErrorCode(...outputs: string[]): string | undefined {
  for (const output of outputs) {
    if (output.trim().length === 0) {
      continue;
    }
    try {
      const code = (
        JSON.parse(output) as { error?: { code?: unknown } } | null
      )?.error?.code;
      if (typeof code === 'string' && code.length > 0) {
        return code;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

export function executeHerdrReadOnly(
  executablePath: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMilliseconds?: number } = {},
): Promise<HerdrReadOnlyResult> {
  return executeHerdrOverSocketOrCommandLine(executablePath, args, options, launchHerdr);
}

function launchHerdr(
  executablePath: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMilliseconds?: number },
): Promise<HerdrReadOnlyResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executablePath,
      [...args],
      {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: options.env,
        timeout: options.timeoutMilliseconds,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const detail = stderr.trim() || stdout.trim() || error.message;
          reject(
            new NestHerdrCommandError(args, detail, {
              code: parseHerdrErrorCode(stderr, stdout),
              stdout,
              stderr,
              cause: error,
            }),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

export const DEFAULT_HERDR_READ_ONLY_CLIENT_DEPENDENCIES: HerdrReadOnlyClientDependencies = {
  ownedHerdrClientPath,
  executeHerdrReadOnly,
};

export const DEFAULT_HERDR_PROCESS_BOUNDARY: HerdrProcessBoundary = {
  execute: executeHerdrReadOnly,
};

@Injectable()
export class HerdrClientService {
  readonly dependencies: HerdrReadOnlyClientDependencies;

  constructor(dependencies: HerdrReadOnlyClientDependencies = DEFAULT_HERDR_READ_ONLY_CLIENT_DEPENDENCIES) {
    this.dependencies = dependencies;
  }

  invoke(commandArgs: readonly string[]): HerdrReadOnlyInvocation {
    return resolveHerdrReadOnlyInvocation(
      commandArgs,
      this.dependencies.ownedHerdrClientPath,
    );
  }

  execute(commandArgs: readonly string[]): Promise<HerdrReadOnlyResult> {
    const invocation = this.invoke(commandArgs);
    return this.dependencies.executeHerdrReadOnly(
      invocation.executablePath,
      invocation.args,
    );
  }

  async run(commandArgs: readonly string[]): Promise<HerdrReadOnlyResult> {
    if (isMutatingHerdrCommand(commandArgs)) {
      await this.preflightCompatibility();
    }
    return this.forgettingCompatibilityWhenTheServerChanged(this.execute(commandArgs));
  }

  async forgettingCompatibilityWhenTheServerChanged<Result>(call: Promise<Result>): Promise<Result> {
    try {
      return await call;
    } catch (failure) {
      if (herdrFailureMeansServerChanged(failure)) {
        compatibleHerdrByExecute.delete(this.dependencies.executeHerdrReadOnly);
      }
      throw failure;
    }
  }

  async preflightCompatibility(): Promise<void> {
    const execute = this.dependencies.executeHerdrReadOnly;
    const identity = herdrIdentity(this.dependencies.ownedHerdrClientPath());
    if (compatibleHerdrByExecute.get(execute) === identity) return;
    compatibleHerdrByExecute.delete(execute);
    await this.checkCompatibility();
    compatibleHerdrByExecute.set(execute, identity);
  }

  private async checkCompatibility(): Promise<void> {
    const version = await this.execute(['--version']);
    const status = await this.execute(['status', 'server', '--json']);
    const expectedVersion = `herdr ${OWNED_HERDR_CLIENT_RELEASE_TAG.slice(1)}`;
    if (version.stdout.trim() !== expectedVersion) {
      throw new HerdrCompatibilityError(
        `throne owned herdr client version mismatch: expected "${expectedVersion}", received "${version.stdout.trim()}"`,
      );
    }
    let fields: { status?: unknown; version?: unknown; protocol?: unknown; compatible?: unknown; socket?: unknown };
    try {
      fields = JSON.parse(status.stdout) ?? {};
    } catch {
      throw new HerdrCompatibilityError('herdr status server returned a malformed response');
    }
    if (
      fields.status !== 'running' ||
      fields.version !== OWNED_HERDR_CLIENT_RELEASE_TAG.slice(1) ||
      String(fields.protocol) !== THRONE_HERDR_PROTOCOL ||
      fields.compatible !== true ||
      typeof fields.socket !== 'string' ||
      !fields.socket.includes(`/sessions/${THRONE_HERDR_SESSION_NAME}/`)
    ) {
      throw new HerdrCompatibilityError(
        `throne herdr server is incompatible for named session "${THRONE_HERDR_SESSION_NAME}": ` +
          `expected running version ${OWNED_HERDR_CLIENT_RELEASE_TAG.slice(1)}, protocol ${THRONE_HERDR_PROTOCOL}, ` +
          `compatible true, and an isolated /sessions/${THRONE_HERDR_SESSION_NAME}/ socket; ` +
          `received ${JSON.stringify(fields)}`,
      );
    }
  }

  async attach(
    args: string[],
    attachBoundary: HerdrAttachBoundary = DEFAULT_HERDR_ATTACH_BOUNDARY,
  ): Promise<number> {
    const forbiddenSelector = args.find((arg) =>
      arg === '--session' || arg.startsWith('--session=') || arg === '--no-session' || arg === '--remote',
    );
    if (forbiddenSelector !== undefined) {
      throw new HerdrCompatibilityError(
        `throne attach refuses selector ${JSON.stringify(forbiddenSelector)}; the target is fixed to named session "${THRONE_HERDR_SESSION_NAME}"`,
      );
    }
    await this.preflightCompatibility();
    return attachBoundary.attach(this.dependencies.ownedHerdrClientPath(), [
      '--session', THRONE_HERDR_SESSION_NAME, ...args,
    ]);
  }

  sendText(target: string, text: string): Promise<void> {
    return writeToPaneHoldingItsLock(target, () => this.run(['pane', 'send-text', target, text]));
  }

  pressEnter(pane: string): Promise<void> {
    return writeToPaneHoldingItsLock(pane, () => this.run(['pane', 'send-keys', pane, 'Enter']));
  }

  pressPaneKey(pane: string, key: string): Promise<void> {
    return writeToPaneHoldingItsLock(pane, () => this.run(['pane', 'send-keys', pane, key]));
  }
}

const PANE_LOCK = new RecipientPaneLockService();

export async function writeToPaneHoldingItsLock(
  paneId: string,
  write: () => Promise<unknown>,
): Promise<void> {
  await PANE_LOCK.withRecipientPaneLock(paneId, async () => {
    await PANE_LOCK.confirmStillOwnsPaneLock(paneId);
    await write();
  });
}


const DEFAULT_HERDR_ATTACH_BOUNDARY: HerdrAttachBoundary = {
  attach(executablePath, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(executablePath, args, { stdio: 'inherit', env: process.env });
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (signal !== null) {
          reject(new Error(`throne attach to named herdr session "${THRONE_HERDR_SESSION_NAME}" ended by ${signal}`));
          return;
        }
        resolve(code ?? 1);
      });
    });
  },
};

const DEFAULT_CLIENT = new HerdrClientService();

export function runHerdr(
  args: string[],
  processBoundary: HerdrProcessBoundary = DEFAULT_HERDR_PROCESS_BOUNDARY,
  options: { env?: NodeJS.ProcessEnv; timeoutMilliseconds?: number } = {},
): Promise<HerdrReadOnlyResult> {
  const client = clientOverProcessBoundary(processBoundary);
  const invocation = client.invoke(args);
  const execute = () => client.dependencies.executeHerdrReadOnly(
    invocation.executablePath,
    invocation.args,
    options,
  );
  const call = isMutatingHerdrCommand(args)
    ? client.preflightCompatibility().then(execute)
    : execute();
  return client.forgettingCompatibilityWhenTheServerChanged(call);
}

export function runHerdrInSession(
  sessionName: string,
  args: string[],
  processBoundary: HerdrProcessBoundary = DEFAULT_HERDR_PROCESS_BOUNDARY,
  options: { env?: NodeJS.ProcessEnv; timeoutMilliseconds?: number } = {},
): Promise<HerdrReadOnlyResult> {
  const invocation = resolveHerdrReadOnlyInvocationForSession(sessionName, args);
  return processBoundary.execute(invocation.executablePath, invocation.args, options);
}

export async function preflightHerdrCompatibility(
  processBoundary: HerdrProcessBoundary = DEFAULT_HERDR_PROCESS_BOUNDARY,
): Promise<void> {
  return clientOverProcessBoundary(processBoundary).preflightCompatibility();
}

export async function attachThroneHerdr(
  args: string[],
  processBoundary: HerdrProcessBoundary = DEFAULT_HERDR_PROCESS_BOUNDARY,
  attachBoundary: HerdrAttachBoundary = DEFAULT_HERDR_ATTACH_BOUNDARY,
): Promise<number> {
  return clientOverProcessBoundary(processBoundary).attach(args, attachBoundary);
}

function clientOverProcessBoundary(
  processBoundary: HerdrProcessBoundary,
): HerdrClientService {
  return new HerdrClientService({
    ownedHerdrClientPath: DEFAULT_CLIENT.dependencies.ownedHerdrClientPath,
    executeHerdrReadOnly: processBoundary.execute,
  });
}

export function sendText(target: string, text: string): Promise<void> {
  return DEFAULT_CLIENT.sendText(target, text);
}

export function pressEnter(pane: string): Promise<void> {
  return DEFAULT_CLIENT.pressEnter(pane);
}

export async function pressEnterIgnoringLocks(
  pane: string,
  processBoundary: HerdrProcessBoundary = DEFAULT_HERDR_PROCESS_BOUNDARY,
): Promise<void> {
  await runHerdr(['pane', 'send-keys', pane, 'Enter'], processBoundary);
}

export function pressPaneKey(pane: string, key: string): Promise<void> {
  return DEFAULT_CLIENT.pressPaneKey(pane, key);
}

