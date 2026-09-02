import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_PERSONA_CONFIG } from '../src/application-config.service.ts';
import { resolveThroneHerdrSessionName } from '../src/herdr/herdr-client.ts';
import { HERDR_RELEASE } from '../src/install-services/herdr-release.service.ts';
import { openRegentQueueStore, resolveRegentQueueDatabasePath } from '../src/regent-queue/regent-queue.store.ts';

interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface CanaryEnvironment {
  scratchRoot: string;
  scratchHome: string;
  scratchThrone: string;
  binDir: string;
  hookPath: string;
  herdrStatePath: string;
}

interface WitnessPaths {
  readonlyHerdrLog: string;
  mutationHerdrLog: string;
  launcherLog: string;
  networkLog: string;
}

interface CommandWitness {
  result: CommandResult;
  paths: WitnessPaths;
}

interface LauncherRecord {
  launcher: string;
  args: string[];
  cwd: string;
}

export function runCommand(
  executable: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function readIfPresent(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function witnessPaths(scratchRoot: string, label: string): WitnessPaths {
  const witnessDir = path.join(scratchRoot, 'witnesses');
  return {
    readonlyHerdrLog: path.join(witnessDir, `${label}.herdr-readonly.jsonl`),
    mutationHerdrLog: path.join(witnessDir, `${label}.herdr-mutation.jsonl`),
    launcherLog: path.join(witnessDir, `${label}.launcher.jsonl`),
    networkLog: path.join(witnessDir, `${label}.network.log`),
  };
}

/** Resolves `PERSONA_CONFIG`/`NTFY_USER_CONFIG` against `liveThroneRoot`'s
 *  merged `config.user.ts` in a fresh, isolated process — the CRITICAL HAZARD
 *  witness that a `steering`-only whole-file write leaves persona/ntfy at
 *  their committed defaults. A dedicated subprocess (rather than importing
 *  `application-config.service.ts` into this test file's own process) avoids
 *  colliding with the module-level `PERSONA_CONFIG` singleton this file's own
 *  top-level imports already resolve once against the real repo's root. */
export async function readPersonaSafetyProbe(
  environment: CanaryEnvironment,
  liveThroneRoot: string,
): Promise<{ persona: unknown; ntfy: unknown }> {
  const moduleUrl = pathToFileURL(
    path.join(environment.scratchThrone, 'src', 'application-config.service.ts'),
  ).href;
  const probe = [
    `const appConfig = await import(${JSON.stringify(moduleUrl)});`,
    'process.stdout.write(JSON.stringify({',
    '  persona: appConfig.PERSONA_CONFIG,',
    '  ntfy: appConfig.NTFY_USER_CONFIG,',
    '}));',
  ].join('\n');
  const result = await runCommand(
    process.execPath,
    ['--import', environment.hookPath, '--input-type=module', '-e', probe],
    {
      cwd: environment.scratchThrone,
      env: {
        ...process.env,
        HOME: environment.scratchHome,
        THRONE_LIVE_ROOT: liveThroneRoot,
        NODE_OPTIONS: '',
        NODE_NO_WARNINGS: '1',
      },
    },
  );
  assert.equal(result.code, 0, `persona safety probe failed:\n${result.stderr}`);
  return JSON.parse(result.stdout) as { persona: unknown; ntfy: unknown };
}

export async function runCreateAgent(
  environment: CanaryEnvironment,
  label: string,
  args: string[],
  codexHome = path.join(environment.scratchHome, '.codex'),
): Promise<CommandWitness> {
  const paths = witnessPaths(environment.scratchRoot, label);
  const result = await runCommand(
    process.execPath,
    [
      '--import',
      environment.hookPath,
      'src/tools.ts',
      'create-agent',
      ...args,
    ],
    {
      cwd: environment.scratchThrone,
      env: {
        ...process.env,
        HOME: environment.scratchHome,
        CODEX_HOME: codexHome,
        CLAUDE_CONFIG_DIR: path.join(environment.scratchHome, '.claude'),
        XDG_CONFIG_HOME: path.join(environment.scratchHome, '.config'),
        THRONE_WORKTREES_HOME: path.join(
          environment.scratchRoot,
          'managed-worktrees',
        ),
        THRONE_DATA_HOME: environment.scratchThrone,
        // Cleared, not inherited: the outer test run's own `THRONE_LIVE_ROOT`
        // (set for ITS hermeticity, see `package.json`'s `test` script) would
        // otherwise leak into this child and steer its steering/persona
        // config reads at the outer fixture root instead of `scratchThrone`,
        // silently discarding every fixture this test writes into the
        // scratch copy.
        THRONE_LIVE_ROOT: '',
        PATH: `${environment.binDir}:${process.env.PATH ?? ''}`,
        // Spawns name their launcher by absolute path, so the fake claudey /
        // codexy / claudey-all are wired in through the resolver's override —
        // PATH alone would no longer keep this hermetic.
        THRONE_LAUNCHER_DIR: environment.binDir,
        NODE_OPTIONS: '',
        NODE_NO_WARNINGS: '1',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
        http_proxy: '',
        https_proxy: '',
        all_proxy: '',
        CANARY_HERDR_STATE: environment.herdrStatePath,
        CANARY_HERDR_READONLY_LOG: paths.readonlyHerdrLog,
        CANARY_HERDR_MUTATION_LOG: paths.mutationHerdrLog,
        CANARY_HERDR_VERSION: HERDR_RELEASE.version,
        // The fake herdr stub (below) refuses any `--session` argument that
        // doesn't match this — read dynamically rather than hardcoded
        // "throne" so this stays correct under a per-suite
        // THRONE_HERDR_SESSION_NAME_OVERRIDE (scripts/run-suite-container.mjs,
        // slice cts-06), same seam `resolveThroneHerdrSessionName` already
        // resolves for the real `create-agent` invocation this spawns.
        CANARY_HERDR_SESSION: resolveThroneHerdrSessionName(),
        CANARY_LAUNCHER_LOG: paths.launcherLog,
        CANARY_NETWORK_LOG: paths.networkLog,
      },
    },
  );
  return { result, paths };
}

function parseJsonLines<T>(text: string): T[] {
  if (text === '') return [];
  return text
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as T);
}

async function findDirectLaunchInvocation(
  paths: WitnessPaths,
  name: string,
): Promise<string[]> {
  const invocations = parseJsonLines<string[]>(
    await readIfPresent(paths.mutationHerdrLog),
  );
  const expectedSession = resolveThroneHerdrSessionName();
  assert.ok(
    invocations.every(
      (args) => args[0] === '--session' && args[1] === expectedSession,
    ),
  );
  const renames = invocations.filter((args) => {
    const commandArgs = args.slice(2);
    return (
      commandArgs[0] === 'agent' &&
      commandArgs[1] === 'rename' &&
      commandArgs[3] === name
    );
  });
  assert.equal(renames.length, 1, `${name} must cross one herdr agent-rename boundary`);
  const paneId = renames[0]![4];
  const launches = invocations.filter((args) => {
    const commandArgs = args.slice(2);
    return (
      commandArgs[0] === 'pane' &&
      commandArgs[1] === 'run' &&
      commandArgs[2] === paneId &&
      commandArgs[3] === 'bash'
    );
  });
  assert.equal(launches.length, 1, `${name} must cross one direct pane-run boundary`);
  return launches[0]!.slice(2);
}

export async function assertSuccessfulBoundary(
  witness: CommandWitness,
  name: string,
  launcher: string,
): Promise<{ launchInvocation: string[]; launcherRecord: LauncherRecord }> {
  assert.equal(
    witness.result.code,
    0,
    `${name} command failed:\n${witness.result.stderr}`,
  );
  assert.equal(witness.result.signal, null);
  assert.doesNotMatch(witness.result.stderr, /refusing|failed after|timed out/);
  assert.equal(
    await readIfPresent(witness.paths.networkLog),
    '',
    `${name} attempted an unexpected network request`,
  );
  const launchInvocation = await findDirectLaunchInvocation(witness.paths, name);
  const launcherRecords = parseJsonLines<LauncherRecord>(
    await readIfPresent(witness.paths.launcherLog),
  );
  assert.equal(launcherRecords.length, 1, `${name} must invoke one fake launcher`);
  assert.equal(launcherRecords[0]?.launcher, launcher);
  return { launchInvocation, launcherRecord: launcherRecords[0]! };
}

export async function resetHerdrRuntime(statePath: string, throneCwd = '/home/throne'): Promise<void> {
  await writeFile(
    statePath,
    `${JSON.stringify({
      next: 1,
      agents: [{
        agent: 'claude', name: 'Regent', composer: '', submitted: [],
        agent_status: 'working', cwd: throneCwd, focused: false,
        pane_id: 'regent-pane', tab_id: 'regent-tab', terminal_id: 'regent-terminal',
      }],
      tabs: [{ tab_id: 'regent-tab', label: 'Regent', pane_count: 1, root_pane_id: 'regent-pane' }],
    })}\n`,
    'utf8',
  );
}

export async function linkShellParserRuntime(
  sourceThrone: string,
  scratchThrone: string,
): Promise<void> {
  await symlink(
    path.join(sourceThrone, 'node_modules'),
    path.join(scratchThrone, 'node_modules'),
    'junction',
  );
}

/** Pre-seeds an `open` queue item for `objectiveCode` at the exact on-disk
 *  path the spawned `create-agent` child resolves under its own
 *  `THRONE_DATA_HOME=scratchThrone` (see `runCreateAgent`), so the
 *  queue-linkage gate finds a match and every campaign spawn in this canary
 *  keeps proceeding through its real, intended production path instead of
 *  being refused by a gate this fixture predates. */
export async function seedQueueItemForObjectiveCode(
  environment: CanaryEnvironment,
  objectiveCode: string,
): Promise<void> {
  const store = openRegentQueueStore(
    resolveRegentQueueDatabasePath(path.join(environment.scratchThrone, 'data')),
  );
  try {
    store.insertItem({ objectiveCode, body: `canary fixture item for ${objectiveCode}` });
  } finally {
    store.close();
  }
}

export function registrationDir(environment: CanaryEnvironment, name: string): string {
  return path.join(environment.scratchThrone, 'data', name);
}

export async function readSpawnEvidence(
  environment: CanaryEnvironment,
  name: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(path.join(registrationDir(environment, name), 'spawn.json'), 'utf8'),
  ) as Record<string, unknown>;
}

export async function assertObjectiveRefusal(opts: {
  environment: CanaryEnvironment;
  label: string;
  args: string[];
  finalName: string;
  diagnostic: RegExp;
}): Promise<void> {
  const codexHome = path.join(
    opts.environment.scratchRoot,
    'refusal-configs',
    opts.label,
  );
  const configPath = path.join(codexHome, 'config.toml');
  const originalConfig = 'canary_sentinel = "unchanged"\n';
  await mkdir(codexHome, { recursive: true });
  await writeFile(configPath, originalConfig, 'utf8');

  const witness = await runCreateAgent(
    opts.environment,
    opts.label,
    opts.args,
    codexHome,
  );

  assert.notEqual(witness.result.code, 0, `${opts.label} unexpectedly succeeded`);
  assert.equal(witness.result.signal, null);
  assert.equal(witness.result.stdout, '');
  assert.match(witness.result.stderr, opts.diagnostic);
  assert.equal(
    existsSync(registrationDir(opts.environment, opts.finalName)),
    false,
    `${opts.label} created a registration`,
  );
  assert.equal(await readFile(configPath, 'utf8'), originalConfig);
  assert.equal(await readIfPresent(witness.paths.networkLog), '');
  assert.equal(await readIfPresent(witness.paths.mutationHerdrLog), '');
  assert.equal(await readIfPresent(witness.paths.launcherLog), '');
}
