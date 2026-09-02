// Real-condition harness for the prevent/detect/recover honest probes
// (`stranded-spawn-honest-probes.canary.test.ts`): a faithful-stand-in fake
// `claude` binary that computes real Claude Code's first-run trust gate from
// whatever is actually on disk, a fake `herdr` binary implementing the real
// herdr CLI protocol shape the production client speaks, and the scratch
// worktree/pane plumbing both are driven through. No test assertions live
// here -- this file only builds the real conditions the tests assert on.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeComposerLine, claudeScreen, DIM_HINT } from './claude-screens.ts';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');

export const REAL_MODAL_FIXTURE = readFileSync(
  path.join(REPO_ROOT, 'test/fixtures/claude-live-fleet-interactive-select-menu.ansi'),
  'utf8',
);
export const EMPTY_COMPOSER_FIXTURE = claudeScreen(claudeComposerLine(DIM_HINT));
export const UNSUBMITTED_DRAFT_FIXTURE = claudeScreen(
  claudeComposerLine('read your assignment and begin'),
);
export const AGENT_TYPED_FOLLOWUP_FIXTURE = claudeScreen(
  claudeComposerLine('one more thing before I start'),
);

interface CanaryProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runCommand(
  executable: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<CanaryProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Writes a fake `claude` executable that reproduces the exact gate
 * `spawn-trust-suppression.md` documents: it reads `settings.json` and
 * `.claude.json` off disk and decides trust the same way, then reports that
 * decision to a sentinel file the fake herdr binary below reads to pick the
 * pane fixture. It never hardcodes the verdict: the verdict is computed from
 * whatever is actually on disk.
 *
 * Resolves those files the way real Claude Code does -- under
 * `CLAUDE_CONFIG_DIR` when set, otherwise under `HOME`. Throne no longer sets
 * that variable (per-spawn config directories expired logins; see
 * `claude-worktree-trust.ts`), so the HOME branch is the production path and
 * the `CLAUDE_CONFIG_DIR` branch survives only so this probe still models a
 * harness launched with one set by something else.
 */
async function writeFakeClaudeBinary(binDir: string): Promise<void> {
  const script = String.raw`#!/usr/bin/env node
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

function readJsonOrEmpty(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

const configDir = process.env.CLAUDE_CONFIG_DIR;
const settingsPath = configDir
  ? path.join(configDir, 'settings.json')
  : path.join(process.env.HOME, '.claude', 'settings.json');
const accountConfigPath = configDir
  ? path.join(configDir, '.claude.json')
  : path.join(process.env.HOME, '.claude.json');
const settings = readJsonOrEmpty(settingsPath);
const accountConfig = readJsonOrEmpty(accountConfigPath);
const cwdRealPath = realpathSync(process.cwd());
const trusted =
  settings.skipDangerousModePermissionPrompt === true &&
  settings.skipAutoPermissionPrompt === true &&
  accountConfig.projects?.[cwdRealPath]?.hasTrustDialogAccepted === true;

writeFileSync(process.env.PROBE_DECISION_FILE, JSON.stringify({ trusted }));
`;
  await writeFile(path.join(binDir, 'claude'), script, { mode: 0o755 });
}

/**
 * A minimal herdr binary implementing the real protocol shape (`--session
 * throne <verb> ...`, JSON-on-stdout results) that the production
 * `herdr-client.ts` speaks -- the same faithful-stand-in pattern the
 * existing `create-agent` canary tests use, trimmed to the verbs this
 * probe's real callers (`readVisibleAnsi`, `sendText`, `pressEnter`,
 * `pressPaneKey`, and the `claudey` launch path) actually issue. Every
 * mutation is logged so a probe can assert what was, and was not, written
 * into the pane.
 */
async function writeFakeHerdrBinary(binDir: string): Promise<void> {
  const script = String.raw`#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error('missing ' + name);
  return value;
}
function emit(value) { process.stdout.write(JSON.stringify(value) + '\n'); }

const statePath = required('PROBE_HERDR_STATE');
const mutationLog = required('PROBE_HERDR_MUTATION_LOG');
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const save = () => writeFileSync(statePath, JSON.stringify(state) + '\n');
const logMutation = (entry) => appendFileSync(mutationLog, JSON.stringify(entry) + '\n');

const invocationArgs = process.argv.slice(2);
if (invocationArgs[0] !== '--session' || invocationArgs[1] !== 'throne') {
  process.stderr.write('expected --session throne');
  process.exit(96);
}
const args = invocationArgs.slice(2);
const findPane = (paneId) => {
  const pane = state.panes[paneId];
  if (!pane) { process.stderr.write('unknown pane: ' + paneId); process.exit(95); }
  return pane;
};

if (args[0] === 'agent' && args[1] === 'read') {
  emit({ result: { read: { text: findPane(args[2]).screen } } });
} else if (args[0] === 'pane' && args[1] === 'run') {
  const targetPane = args[2];
  const scriptPath = args[4];
  const decisionFile = state.pendingDecisionFile;
  const launched = spawnSync(args[3], [scriptPath], {
    cwd: state.panes[targetPane].cwd,
    env: { ...process.env, PROBE_DECISION_FILE: decisionFile },
    encoding: 'utf8',
  });
  if (launched.status !== 0) {
    process.stderr.write(launched.stderr || 'fake claude launch failed');
    process.exit(98);
  }
  const decision = JSON.parse(readFileSync(decisionFile, 'utf8'));
  state.panes[targetPane].screen = decision.trusted
    ? state.emptyFixture
    : state.modalFixture;
  state.panes[targetPane].composer = decision.trusted ? 'empty' : 'modal';
  save();
  emit({ result: {} });
} else if (args[0] === 'pane' && args[1] === 'send-text') {
  const pane = findPane(args[2]);
  const text = args[3];
  logMutation({ verb: 'send-text', pane: args[2], text });
  pane.pendingSubmitText = text;
  save();
  emit({ result: {} });
} else if (args[0] === 'pane' && args[1] === 'send-keys') {
  const pane = findPane(args[2]);
  const key = args[3];
  logMutation({ verb: 'send-keys', pane: args[2], key });
  if (key === '2' && pane.composer === 'modal') {
    pane.composer = 'empty';
    pane.screen = state.emptyFixture;
  } else if (key === 'Enter') {
    if (pane.pendingSubmitText) {
      pane.submitted.push(pane.pendingSubmitText);
      pane.pendingSubmitText = undefined;
    }
    pane.composer = 'empty';
    pane.screen = state.emptyFixture;
  }
  save();
  emit({ result: {} });
} else {
  process.stderr.write('unsupported herdr verb: ' + args.join(' '));
  process.exit(97);
}
`;
  await writeFile(path.join(binDir, 'herdr'), script, { mode: 0o755 });
}

export interface ProbeEnvironment {
  scratchRoot: string;
  worktreePath: string;
  binDir: string;
  herdrStatePath: string;
  mutationLogPath: string;
  decisionFilePath: string;
  dataDir: string;
}

async function buildRealNeverSeenWorktree(scratchRoot: string): Promise<string> {
  const sourceRepo = path.join(scratchRoot, 'source-repo');
  await mkdir(sourceRepo, { recursive: true });
  await runCommand('git', ['init', '--quiet'], { cwd: sourceRepo, env: process.env });
  await runCommand('git', ['config', 'user.email', 'probe@example.invalid'], {
    cwd: sourceRepo,
    env: process.env,
  });
  await runCommand('git', ['config', 'user.name', 'Probe'], { cwd: sourceRepo, env: process.env });
  await writeFile(path.join(sourceRepo, 'README.md'), 'honest spawn probe fixture repo\n');
  await runCommand('git', ['add', '.'], { cwd: sourceRepo, env: process.env });
  await runCommand('git', ['commit', '--quiet', '-m', 'seed'], { cwd: sourceRepo, env: process.env });
  const worktreePath = path.join(scratchRoot, 'never-before-seen-worktree');
  const result = await runCommand('git', ['worktree', 'add', '--quiet', worktreePath], {
    cwd: sourceRepo,
    env: process.env,
  });
  assert.equal(result.code, 0, `git worktree add failed: ${result.stderr}`);
  return worktreePath;
}

export async function buildProbeEnvironment(label: string): Promise<ProbeEnvironment> {
  const scratchRoot = await mkdtemp(path.join(os.homedir(), 'tmp', `spr06-${label}-`));
  const worktreePath = await buildRealNeverSeenWorktree(scratchRoot);
  const binDir = path.join(scratchRoot, 'bin');
  await mkdir(binDir, { recursive: true });
  await writeFakeClaudeBinary(binDir);
  await writeFakeHerdrBinary(binDir);
  const dataDir = path.join(scratchRoot, 'data');
  await mkdir(dataDir, { recursive: true });
  return {
    scratchRoot,
    worktreePath,
    binDir,
    herdrStatePath: path.join(scratchRoot, 'herdr-state.json'),
    mutationLogPath: path.join(scratchRoot, 'herdr-mutations.jsonl'),
    decisionFilePath: path.join(scratchRoot, 'trust-decision.json'),
    dataDir,
  };
}

export async function seedHerdrState(
  environment: ProbeEnvironment,
  panes: Record<string, { cwd: string; screen: string; composer: 'modal' | 'empty' | 'draft'; submitted?: string[] }>,
): Promise<void> {
  await writeFile(environment.mutationLogPath, '');
  await writeFile(
    environment.herdrStatePath,
    JSON.stringify({
      panes: Object.fromEntries(
        Object.entries(panes).map(([id, pane]) => [
          id,
          { cwd: pane.cwd, screen: pane.screen, composer: pane.composer, submitted: pane.submitted ?? [] },
        ]),
      ),
      emptyFixture: EMPTY_COMPOSER_FIXTURE,
      modalFixture: REAL_MODAL_FIXTURE,
      pendingDecisionFile: environment.decisionFilePath,
    }),
  );
}

export function herdrEnv(environment: ProbeEnvironment): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${environment.binDir}:${process.env.PATH}`,
    PROBE_HERDR_STATE: environment.herdrStatePath,
    PROBE_HERDR_MUTATION_LOG: environment.mutationLogPath,
  };
}

export async function readVisibleAnsiViaRealHerdr(environment: ProbeEnvironment, paneId: string): Promise<string> {
  const result = await runCommand('herdr', ['--session', 'throne', 'agent', 'read', paneId], {
    cwd: environment.worktreePath,
    env: herdrEnv(environment),
  });
  assert.equal(result.code, 0, `real herdr agent read failed: ${result.stderr}`);
  return (JSON.parse(result.stdout).result.read.text) as string;
}

export async function pressPaneKeyViaRealHerdr(environment: ProbeEnvironment, paneId: string, key: string): Promise<void> {
  const result = await runCommand('herdr', ['--session', 'throne', 'pane', 'send-keys', paneId, key], {
    cwd: environment.worktreePath,
    env: herdrEnv(environment),
  });
  assert.equal(result.code, 0, `real herdr pane send-keys failed: ${result.stderr}`);
}

export async function sendTextViaRealHerdr(environment: ProbeEnvironment, paneId: string, text: string): Promise<void> {
  const result = await runCommand('herdr', ['--session', 'throne', 'pane', 'send-text', paneId, text], {
    cwd: environment.worktreePath,
    env: herdrEnv(environment),
  });
  assert.equal(result.code, 0, `real herdr pane send-text failed: ${result.stderr}`);
}

export async function readMutationLog(environment: ProbeEnvironment): Promise<Array<{ verb: string; pane: string }>> {
  const text = await readFile(environment.mutationLogPath, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

export async function cleanupProbe(environment: ProbeEnvironment): Promise<void> {
  await rm(environment.scratchRoot, { recursive: true, force: true });
}
