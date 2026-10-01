import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { Injectable } from '@nestjs/common';

export const OWNED_HERDR_CLIENT_RELEASE_TAG = 'v0.8.2';

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
/** The wire protocol `OWNED_HERDR_CLIENT_RELEASE_TAG` actually speaks, as
 *  reported by `herdr --session <name> status`. Verified against the pinned
 *  release, never assumed: v0.8.2 reports 20 — read from the new binary's
 *  own live `status server --json` inside the isolated rehearsal session on
 *  2026-08-24, not inferred from the mismatch error text. (v0.8.0 reported
 *  19.) An incorrect value here rejects a perfectly good server as
 *  incompatible. Re-read it from the binary whenever the pinned tag moves. */
export const THRONE_HERDR_PROTOCOL = '20';
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

function isMutatingHerdrCommand(commandArgs: readonly string[]): boolean {
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
    return this.execute(commandArgs);
  }

  async preflightCompatibility(): Promise<void> {
    const version = await this.execute(['--version']);
    const status = await this.execute(['status', 'server']);
    const expectedVersion = `herdr ${OWNED_HERDR_CLIENT_RELEASE_TAG.slice(1)}`;
    if (version.stdout.trim() !== expectedVersion) {
      throw new HerdrCompatibilityError(
        `throne owned herdr client version mismatch: expected "${expectedVersion}", received "${version.stdout.trim()}"`,
      );
    }
    const fields: Record<string, string> = {};
    for (const line of status.stdout.trim().split('\n')) {
      const separator = line.indexOf(':');
      if (separator < 0) throw new HerdrCompatibilityError('herdr status server returned a malformed response');
      fields[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
    }
    if (
      fields.status !== 'running' ||
      fields.version !== OWNED_HERDR_CLIENT_RELEASE_TAG.slice(1) ||
      fields.protocol !== THRONE_HERDR_PROTOCOL ||
      fields.compatible !== 'yes' ||
      !fields.socket?.includes(`/sessions/${THRONE_HERDR_SESSION_NAME}/`)
    ) {
      throw new HerdrCompatibilityError(
        `throne herdr server is incompatible for named session "${THRONE_HERDR_SESSION_NAME}": ` +
          `expected running version ${OWNED_HERDR_CLIENT_RELEASE_TAG.slice(1)}, protocol ${THRONE_HERDR_PROTOCOL}, ` +
          `compatible yes, and an isolated /sessions/${THRONE_HERDR_SESSION_NAME}/ socket; ` +
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
    return this.run(['pane', 'send-text', target, text]).then(() => undefined);
  }

  pressEnter(pane: string): Promise<void> {
    return this.run(['pane', 'send-keys', pane, 'Enter']).then(() => undefined);
  }

  pressPaneKey(pane: string, key: string): Promise<void> {
    return this.run(['pane', 'send-keys', pane, key]).then(() => undefined);
  }
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
  if (isMutatingHerdrCommand(args)) {
    return client.preflightCompatibility().then(execute);
  }
  return execute();
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

export function pressPaneKey(pane: string, key: string): Promise<void> {
  return DEFAULT_CLIENT.pressPaneKey(pane, key);
}

