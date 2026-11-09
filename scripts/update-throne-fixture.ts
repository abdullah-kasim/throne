import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

import { turnOffCommitSigningThatTheEnvironmentTurnedOn } from '../test/git-repo-test-fixture.ts';
import { BUILD_SOURCE_FINGERPRINT_MARKER_FILENAME, computeBuildInputManifest } from './source-content-fingerprint.mjs';
import { runUpdateThrone } from './update-throne.mjs';

turnOffCommitSigningThatTheEnvironmentTurnedOn();

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..');
const LOCKFILE = 'package-lock.json';
const STARTING_VERSIONS = { claude: '2.0.0', codex: '0.50.0', herdr: '0.9.5' };

export const USER_ID = 501;
export const THE_WORD = ['--restart-ordered-by-lord', 'restart them all'];
export const AGENT_RESTART_CALL = 'throne-cli restart-harnesses --force';
export const HERDR_HAND_OFF = `herdr-upgrade.mjs --pinned --yes ${THE_WORD.join(' ')}`;
export const CHANGED_NTFY_UNIT = 'install-services: ntfy.service: installed content changed while the unit was running. Nothing was restarted, stopped or killed; applying the new content is an operator decision.\n';

export const AGENTS_FINISHED_CLEANLY = 'restart-harnesses: finished — 2 restarted, 0 skipped, 0 failed\n';
export const AGENTS_FINISHED_WITH_A_FAILURE = 'restart-harnesses: failed    first — no session\nrestart-harnesses: finished — 1 restarted, 0 skipped, 1 failed\n';
export const AGENTS_STILL_RESTARTING = 'restart-harnesses: restarted second\n';
export const HERDR_RELAUNCH_HEADER = '===== herdr-upgrade v0.9.6 restart Sat Nov  7 =====\n';
export const HERDR_RELAUNCH_SUCCEEDED = `${HERDR_RELAUNCH_HEADER}repair: every snapshotted name sits on a pane with a live harness\n===== done Sat Nov  7 =====\nthrone cli herdr 0.9.6, bin/herdr 0.9.6, running service 0.9.6\n`;
export const HERDR_RELAUNCH_FAILED = `${HERDR_RELAUNCH_HEADER}repair: STILL WRONG for first\nFAILED: the restart and identity repair exited 1\n===== done Sat Nov  7 =====\nthrone cli herdr 0.9.6, bin/herdr 0.9.6, running service 0.9.6\n`;
export const HERDR_RELAUNCH_RUNNING = `${HERDR_RELAUNCH_HEADER}repair: final mapping\n`;

const HERDR_RELAUNCH_OPENING = 'herdr-upgrade: phases 8-10: restart, resume and identity repair, detached\n';
const HOST_RESTART_COMMANDS = ['bash', 'systemctl', 'launchctl'];
const READ_ONLY_SERVICE_CALLS = ['is-active', 'list-units'];

type ProcessResult = { status: number; stdout: string; stderr: string };
type Handler = (args: readonly string[]) => ProcessResult | undefined;

export type Court = {
  directory: string;
  checkout: string;
  home: string;
  markerDirectory: string;
  origin: string;
  upstream: string;
  seed: string;
  running: { claude: string; codex: string; herdr: string };
  calls: string[];
  installServicesOutput: string;
  commandFailures: Map<string, string>;
  runningBotBridges: string[];
  restartCommands: string[];
  pathOfCall: Map<string, string | undefined>;
  onCall: Map<string, () => void>;
  originUrlSeen?: string;
  gitBehindShim?: { command: string; env: NodeJS.ProcessEnv };
  distGeneration: number;
  detachedAgentRestart?: string;
  detachedHerdrRelaunch: string;
};

export type RunResult = { code: number; output: string };

function ok(stdout = ''): ProcessResult {
  return { status: 0, stdout, stderr: '' };
}

const TEMPLATE_ORIGIN_NAME = 'court';
let repositoriesToCopy: string | undefined;

function realProcess(command: string, args: readonly string[], options: object = {}): ProcessResult {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function git(repository: string, ...args: string[]): string {
  const result = realProcess('git', ['-C', repository, ...args]);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function herdrClientSource(version: string): string {
  return `export const OWNED_HERDR_CLIENT_RELEASE_TAG = 'v${version}';\n`;
}

function vendorPins(claude: string, codex: string, ntfyImage = 'example.test/ntfy:v1'): string {
  return `${JSON.stringify(
    {
      tools: { ntfy: { image: ntfyImage }, tea: { version: '1.0.0' } },
      harnesses: { claude: { version: claude }, codex: { version: codex } },
    },
    null,
    2,
  )}\n`;
}

function writeFiles(repository: string, files: Record<string, string>): void {
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repository, file)), { recursive: true });
    writeFileSync(path.join(repository, file), contents);
  }
}

function commitEverything(repository: string, message: string): void {
  git(repository, 'add', '-A');
  git(repository, 'commit', '-m', message);
}

function identify(repository: string): void {
  git(repository, 'config', 'user.name', 'Court Tester');
  git(repository, 'config', 'user.email', 'tester@example.test');
}

function makeSeed(directory: string): string {
  const seed = path.join(directory, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '--template=', '--initial-branch=main');
  identify(seed);
  writeFiles(seed, {
    '.gitignore': '/dist\n/dist.build.*/\n/vendor/\n/node_modules/\n',
    'package.json': '{ "name": "court" }\n',
    [LOCKFILE]: '{ "lockfileVersion": 3 }\n',
    'mise.toml': '[tools]\nnode = "24.0.0"\n',
    'vendor-pins.json': vendorPins(STARTING_VERSIONS.claude, STARTING_VERSIONS.codex),
    'src/herdr/herdr-client.ts': herdrClientSource(STARTING_VERSIONS.herdr),
  });
  commitEverything(seed, 'Start the court');
  return seed;
}

function makeBareCopy(directory: string, seed: string, name: string): string {
  const bare = path.join(directory, `${name}.git`);
  realProcess('git', ['clone', '--bare', '--template=', seed, bare]);
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  return bare;
}

export function publishFreshDist(court: Court): void {
  court.distGeneration += 1;
  const generation = `dist.build.${court.distGeneration}-1`;
  const generationDirectory = path.join(court.checkout, generation);
  const restartPlans = pathToFileURL(path.join(REPOSITORY_ROOT, 'src/herdr-update/herdr-upgrade-restart.ts')).href;
  writeFiles(generationDirectory, {
    [BUILD_SOURCE_FINGERPRINT_MARKER_FILENAME]: JSON.stringify(computeBuildInputManifest(court.checkout)),
    'package.json': '{ "type": "module" }\n',
    'src/herdr-update/herdr-upgrade-restart.js': `export * from ${JSON.stringify(restartPlans)};\n`,
  });
  rmSync(path.join(court.checkout, 'dist'), { force: true });
  symlinkSync(generation, path.join(court.checkout, 'dist'));
}

export function backendRuns(court: Court, generation: string): void {
  mkdirSync(court.markerDirectory, { recursive: true });
  writeFileSync(
    path.join(court.markerDirectory, 'throne-backend.service.json'),
    `${JSON.stringify({ generation, startedAt: 'earlier', pid: 1 })}\n`,
  );
}

export function currentDistGeneration(court: Court): string {
  return `dist.build.${court.distGeneration}-1`;
}

function stampInstalledDependencies(court: Court): void {
  const hash = createHash('sha256').update(readFileSync(path.join(court.checkout, LOCKFILE))).digest('hex');
  writeFiles(court.checkout, { 'vendor/.stamps/npm-deps': `${hash}\n`, 'node_modules/.keep': '' });
}

function makeCheckout(directory: string, origin: string): string {
  const checkout = path.join(directory, 'checkout');
  realProcess('git', ['clone', '--template=', origin, checkout]);
  identify(checkout);
  return checkout;
}

function makeRepositoriesOnce(): string {
  if (repositoriesToCopy !== undefined) return repositoriesToCopy;
  const directory = mkdtempSync(path.join(tmpdir(), 'update-throne-repositories-'));
  process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
  const seed = makeSeed(directory);
  const origin = makeBareCopy(directory, seed, TEMPLATE_ORIGIN_NAME);
  const upstream = makeBareCopy(directory, seed, 'upstream-court');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'remote', 'add', 'upstream', upstream);
  makeCheckout(directory, origin);
  repositoriesToCopy = directory;
  return directory;
}

function repointConfig(configFile: string, from: string, to: string, originName: string): void {
  const config = readFileSync(configFile, 'utf8');
  writeFileSync(configFile, config.replaceAll(from, to).replaceAll(`/${TEMPLATE_ORIGIN_NAME}.git`, `/${originName}.git`));
}

function copyRepositories(directory: string, originName: string): void {
  const template = makeRepositoriesOnce();
  cpSync(template, directory, { recursive: true });
  renameSync(path.join(directory, `${TEMPLATE_ORIGIN_NAME}.git`), path.join(directory, `${originName}.git`));
  for (const config of ['seed/.git/config', 'checkout/.git/config', `${originName}.git/config`, 'upstream-court.git/config']) {
    repointConfig(path.join(directory, config), template, directory, originName);
  }
}

export function makeCourt(
  cleanUp: (work: () => void) => void,
  { originName = 'court', withUpstream = false }: { originName?: string; withUpstream?: boolean } = {},
): Court {
  const directory = mkdtempSync(path.join(tmpdir(), 'update-throne-'));
  cleanUp(() => rmSync(directory, { recursive: true, force: true }));
  copyRepositories(directory, originName);
  const seed = path.join(directory, 'seed');
  const origin = path.join(directory, `${originName}.git`);
  const upstream = path.join(directory, 'upstream-court.git');
  const checkout = path.join(directory, 'checkout');
  if (withUpstream) git(checkout, 'remote', 'add', 'upstream', upstream);
  const court: Court = {
    directory,
    checkout,
    home: path.join(directory, 'home'),
    markerDirectory: path.join(directory, 'markers'),
    origin,
    upstream,
    seed,
    running: { ...STARTING_VERSIONS },
    calls: [],
    installServicesOutput: '',
    commandFailures: new Map(),
    runningBotBridges: [],
    restartCommands: [],
    pathOfCall: new Map(),
    onCall: new Map(),
    distGeneration: 0,
    detachedHerdrRelaunch: HERDR_RELAUNCH_SUCCEEDED,
  };
  writeFiles(court.home, { '.local/share/mise/installs/node/24.0.0/bin/node': '' });
  stampInstalledDependencies(court);
  publishFreshDist(court);
  backendRuns(court, currentDistGeneration(court));
  return court;
}

export function land(court: Court, remote: 'origin' | 'upstream', files: Record<string, string>): string {
  writeFiles(court.seed, files);
  commitEverything(court.seed, 'Land a change');
  git(court.seed, 'push', remote, 'main');
  return git(court.seed, 'rev-parse', 'HEAD');
}

export function commitInCheckout(court: Court, files: Record<string, string>): string {
  writeFiles(court.checkout, files);
  commitEverything(court.checkout, 'A commit only this checkout has');
  return git(court.checkout, 'rev-parse', 'HEAD');
}

export function runGitBehindShimWithNoIdentity(court: Court): void {
  const shimFolder = path.join(court.directory, 'throne-bin');
  mkdirSync(shimFolder);
  copyFileSync(path.join(REPOSITORY_ROOT, 'bin', 'git'), path.join(shimFolder, 'git'));
  git(court.checkout, 'config', '--unset', 'user.name');
  git(court.checkout, 'config', '--unset', 'user.email');
  court.gitBehindShim = {
    command: path.join(shimFolder, 'git'),
    env: { HOME: court.home, PATH: `${shimFolder}:/usr/bin:/bin`, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  };
}

export function pinsMoving(versions: { claude?: string; codex?: string; ntfyImage?: string }): Record<string, string> {
  return {
    'vendor-pins.json': vendorPins(
      versions.claude ?? STARTING_VERSIONS.claude,
      versions.codex ?? STARTING_VERSIONS.codex,
      versions.ntfyImage,
    ),
  };
}

export function herdrPinMovingTo(version: string): Record<string, string> {
  return { 'src/herdr/herdr-client.ts': herdrClientSource(version) };
}

export function failOnce(court: Court, call: string, stdout = ''): void {
  court.commandFailures.set(call, stdout);
}

export function dieHere(): never {
  throw new Error('the run was killed here');
}

function pinnedHarnessVersion(court: Court, harness: 'claude' | 'codex'): string {
  return JSON.parse(readFileSync(path.join(court.checkout, 'vendor-pins.json'), 'utf8')).harnesses[harness].version;
}

function moveHarness(court: Court, harness: 'claude' | 'codex'): ProcessResult {
  const pinned = pinnedHarnessVersion(court, harness);
  const installed = court.running[harness];
  const evidence = 'evidence: /evidence/a run that moved from one to two.json\n';
  if (installed === pinned) return ok(`update-harness: ${harness} unchanged at ${pinned}\n${evidence}`);
  court.running[harness] = pinned;
  return ok(`update-harness: ${harness} moved from ${installed} to ${pinned}\n${evidence}`);
}

function listedBotBridges(court: Court): string {
  return court.runningBotBridges.map((bridge) => `${bridge} loaded active running throne-bot bridge daemon\n`).join('');
}

export function agentRestartLog(court: Court): string {
  return path.join(court.home, 'tmp', 'restart-harnesses.log');
}

export function herdrUpgradeLog(court: Court): string {
  return path.join(court.home, 'tmp', 'herdr-upgrade.log');
}

function appendToLog(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, text);
}

function restartAgents(court: Court): ProcessResult {
  if (court.detachedAgentRestart === undefined) return ok('restarted every agent\n');
  appendToLog(agentRestartLog(court), `=== restart-harnesses run 2026-11-07T00:00:00.000Z --force ===\n${court.detachedAgentRestart}`);
  return ok(`restart-harnesses: continuing in a detached run; read ${agentRestartLog(court)}\n`);
}

function pinnedHerdrVersion(court: Court): string | undefined {
  return /'v([^']+)'/.exec(readFileSync(path.join(court.checkout, 'src/herdr/herdr-client.ts'), 'utf8'))?.[1];
}

export function upgradeHerdr(court: Court): ProcessResult {
  const pinned = String(pinnedHerdrVersion(court));
  if (court.running.herdr === pinned) return ok(`herdr-upgrade: throne cli herdr ${pinned}, bin/herdr ${pinned}, running service ${pinned}\n`);
  court.running.herdr = pinned;
  appendToLog(herdrUpgradeLog(court), `${HERDR_RELAUNCH_OPENING}${court.detachedHerdrRelaunch}`);
  return ok(`${HERDR_RELAUNCH_OPENING}herdr-upgrade:   detached; follow it with:  tail -f ${herdrUpgradeLog(court)}\nherdr-upgrade: done issuing; the detached unit owns the rest\n`);
}

function stubbedCommands(court: Court): Record<string, Handler> {
  return {
    claude: () => ok(`${court.running.claude} (Claude Code)\n`),
    codex: () => ok(`codex-cli ${court.running.codex}\n`),
    herdr: () => ok(JSON.stringify({ running: true, version: court.running.herdr })),
    npm: (args) => {
      if (args[0] === 'run') publishFreshDist(court);
      return ok();
    },
    mise: () => ok(),
    'throne-cli': (args) => (args[0] === 'install-services' ? ok(court.installServicesOutput) : restartAgents(court)),
    bash: () => ok(),
    systemctl: (args) => ok(args.includes('list-units') ? listedBotBridges(court) : ''),
    launchctl: () => ok(),
    'update-harness.mjs': (args) => moveHarness(court, args[args.indexOf('--harness') + 1] as 'claude' | 'codex'),
    'herdr-upgrade.mjs': () => upgradeHerdr(court),
  };
}

function commandName(command: string, args: readonly string[]): string {
  return path.basename(command === 'node' ? String(args[0]) : command);
}

function describeCall(name: string, command: string, args: readonly string[]): string {
  const shownArgs = command === 'node' ? args.slice(1) : args;
  return [name, ...shownArgs].join(' ');
}

function failureFor(court: Court, call: string): ProcessResult | undefined {
  const stdout = court.commandFailures.get(call);
  if (stdout === undefined) return undefined;
  court.commandFailures.delete(call);
  return { status: 1, stdout, stderr: `${call} was made to fail` };
}

function processBoundary(court: Court) {
  const commands = stubbedCommands(court);
  return (command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv } = {}): ProcessResult => {
    if (command === 'git') {
      if (court.originUrlSeen !== undefined && args.at(-2) === 'get-url' && args.at(-1) === 'origin') {
        return ok(`${court.originUrlSeen}\n`);
      }
      const result = court.gitBehindShim === undefined ? realProcess(command, args, options) : realProcess(court.gitBehindShim.command, args, { env: court.gitBehindShim.env });
      court.onCall.get(`git ${args[2]}`)?.();
      return result;
    }
    const name = commandName(command, args);
    const call = describeCall(name, command, args);
    court.calls.push(call);
    court.pathOfCall.set(call, options.env?.PATH);
    if (args[0] === 'restart-harnesses') court.restartCommands.push(command);
    (court.onCall.get(call) ?? court.onCall.get(name))?.();
    const handler = commands[name];
    if (handler === undefined) throw new Error(`no stub for ${call}`);
    return failureFor(court, call) ?? handler(args) ?? ok();
  };
}

export async function runUpdate(
  court: Court,
  argv: string[] = [],
  { platform = 'linux', askHost }: { platform?: string; askHost?: (repository: string) => Promise<unknown> } = {},
): Promise<RunResult> {
  let output = '';
  const code = await runUpdateThrone({
    root: court.checkout,
    argv,
    runProcess: processBoundary(court),
    askHost: askHost ?? (async () => ({ fork: false })),
    platform,
    userId: USER_ID,
    home: court.home,
    serviceGenerationMarkerDirectory: court.markerDirectory,
    print: (text: string) => {
      output += text;
    },
  });
  return { code, output };
}

export function readLog(court: Court): string {
  return readFileSync(path.join(court.home, 'tmp', 'update-throne.log'), 'utf8');
}

export function callsTo(court: Court, opening: string): string[] {
  return court.calls.filter((call) => call.startsWith(opening));
}

export function courtFor(t: TestContext, options?: { originName?: string; withUpstream?: boolean }): Court {
  return makeCourt((work) => t.after(work), options);
}

export function restartCalls(court: Court): string[] {
  return court.calls.filter(
    (call) =>
      (HOST_RESTART_COMMANDS.some((command) => call.startsWith(`${command} `)) && !READ_ONLY_SERVICE_CALLS.some((word) => call.includes(word))) ||
      call.startsWith(AGENT_RESTART_CALL),
  );
}

export function snapshotCheckout(court: Court): Record<string, string> {
  return {
    head: git(court.checkout, 'rev-parse', 'HEAD'),
    status: git(court.checkout, 'status', '--porcelain'),
    config: readFileSync(path.join(court.checkout, '.git', 'config'), 'utf8'),
    tree: git(court.checkout, 'ls-files', '--stage'),
  };
}
