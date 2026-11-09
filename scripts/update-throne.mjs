#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { checkDistIsFresh } from './dist-staleness-guard.mjs';
import { acquireTransactionLock } from '../.claude/skills/update-harnesses/scripts/transaction-lock.mjs';
import { versionOutputReports } from '../.claude/skills/update-harnesses/scripts/update-harness.mjs';
import {
  CHECKOUT_KINDS,
  UpdateStopped,
  askGithubAboutRepository,
  checkoutRefusal,
  detectCheckoutKind,
  failed,
  hasNewCommits,
  pullLatest,
  readCheckoutState,
  readCommittedFile,
  readCurrentCommit,
  readPins,
  refused,
} from './update-throne-checkout.mjs';
import {
  AGENTS_PENDING,
  DETACHED_VERDICTS,
  addPendingRestarts,
  herdrHandOverLogIn,
  oweBotBridgesARestart,
  oweHerdrRestart,
  oweUnitsAReload,
  pendingOnceVerdictIsRead,
  readDetachedRestart,
  readHerdrLogLength,
  readPendingRestarts,
  recordAgentRestartHandOver,
  reloadUnitsWhenOwed,
  rememberRestartsOwed,
  removePendingRestart,
  restartServicesThatChanged,
  restartWhatHerdrLeaves,
  serviceFileOfPinnedImage,
  servicesChangedWhileRunning,
  settleDetachedRestart,
  writePendingRestarts,
} from './update-throne-restarts.mjs';

const LINE_PREFIX = 'update-throne: ';
const BRING_IN_UPSTREAM_FLAG = '--bring-in-upstream';
const CHECK_FLAG = '--check';
const RESTART_WORD_FLAG = '--restart-ordered-by-lord';
const USAGE = `usage: update-throne.mjs [${CHECK_FLAG}] [${BRING_IN_UPSTREAM_FLAG}] [${RESTART_WORD_FLAG} "<words>"]`;
const EXIT_DONE = 0;
const EXIT_STOPPED = 1;
const EXIT_BAD_ARGUMENT = 2;
const HARNESSES = [
  { name: 'claude', executable: 'claude' },
  { name: 'codex', executable: 'codex' },
];
const HERDR_SESSION = 'throne';
const LOCKFILE = 'package-lock.json';
const VERSION_IN_OUTPUT = /\d+\.\d+\.\d+\S*/;
const NODE_PIN_LINE = /^\s*node\s*=\s*"([^"]+)"/m;
const HARNESS_MOVED_LINE = /^update-harness: \S+ moved from (\S+) to (\S+)$/m;
const UNKNOWN_VERSION = 'unknown';
const NODE_ON_PATH = 'node';
const SHORT_COMMIT_LENGTH = 12;
const HARNESS_UPDATER = path.join('.claude', 'skills', 'update-harnesses', 'scripts', 'update-harness.mjs');
const HERDR_UPGRADER = path.join('scripts', 'herdr-upgrade.mjs');
const THRONE_COMMAND = path.join('bin', 'throne-cli');
const RUN_LOCK_FOLDER = path.join('vendor', '.stamps', 'update-throne-run');
const RUN_LOCK_NAMES = { holder: 'update-throne run', speaker: 'update-throne' };

export function parseUpdateArguments(argv) {
  const answers = { check: false, bringInUpstream: false, restartWords: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === CHECK_FLAG) answers.check = true;
    else if (argument === BRING_IN_UPSTREAM_FLAG) answers.bringInUpstream = true;
    else if (argument === RESTART_WORD_FLAG) {
      index += 1;
      answers.restartWords = argv[index]?.trim();
      if (!answers.restartWords) return undefined;
    } else return undefined;
  }
  return answers;
}

function runProcessOnThisMachine(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
}

function openLog(home, mode, print) {
  const logFile = path.join(home, 'tmp', 'update-throne.log');
  mkdirSync(path.dirname(logFile), { recursive: true });
  appendFileSync(logFile, `===== update-throne ${mode} ${new Date().toISOString()} =====\n`);
  return (message) => {
    const line = `${LINE_PREFIX}${message}`;
    appendFileSync(logFile, `${line}\n`);
    print(`${line}\n`);
  };
}

function shortCommit(commit) {
  return commit.slice(0, SHORT_COMMIT_LENGTH);
}

function readInstalledHarness(context, harness, pinnedVersion) {
  const binary = path.join(context.root, 'vendor', 'node_modules', '.bin', harness.executable);
  const output = context.runProcess(binary, ['--version']).stdout;
  return {
    installed: VERSION_IN_OUTPUT.exec(output)?.[0] ?? UNKNOWN_VERSION,
    moves: !versionOutputReports(output, pinnedVersion),
  };
}

function readRunningHerdrVersion(context) {
  const herdr = path.join(context.root, 'bin', 'herdr');
  const status = context.runProcess(herdr, ['--session', HERDR_SESSION, 'status', 'server', '--json']);
  try {
    return JSON.parse(status.stdout).version ?? UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}

function lockfileHash(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function installedLockfileStampPath(root) {
  return path.join(root, 'vendor', '.stamps', 'npm-deps');
}

function readInstalledLockfileHash(root) {
  const stamp = installedLockfileStampPath(root);
  return existsSync(stamp) ? readFileSync(stamp, 'utf8').trim() : undefined;
}

function dependenciesAreCurrent(root, contents) {
  return existsSync(path.join(root, 'node_modules')) && readInstalledLockfileHash(root) === lockfileHash(contents);
}

async function planUpdate(context, checkout) {
  const state = readCheckoutState(context, checkout);
  const pins = readPins(context, checkout, state);
  const harnesses = HARNESSES.map((harness) => ({
    ...harness,
    pinned: pins[harness.name],
    ...readInstalledHarness(context, harness, pins[harness.name]),
  }));
  const runningHerdr = readRunningHerdrVersion(context);
  const detachedRestart = readDetachedRestart(context.root);
  return {
    checkout,
    state,
    pins,
    harnesses,
    runningHerdr,
    herdrMoves: runningHerdr !== pins.herdr,
    lockfileChanged: !dependenciesAreCurrent(context.root, readCommittedFile(context, pins.revision, LOCKFILE)),
    detachedRestart,
    agentsNeedRestart: harnesses.some((harness) => harness.moves) || pendingOnceVerdictIsRead(context.root, detachedRestart).includes(AGENTS_PENDING),
  };
}

function detachedRestartIsRunning(plan) {
  return plan.detachedRestart.verdict === DETACHED_VERDICTS.RUNNING;
}

function describeDetachedRestart({ verdict, log }) {
  if (verdict === DETACHED_VERDICTS.RUNNING) return `a detached restart is still running; read ${log}`;
  if (verdict === DETACHED_VERDICTS.SUCCEEDED) return `the detached restart succeeded; read ${log}`;
  return `the detached restart did not succeed, so what it covered stays owed; read ${log}`;
}

function printPlan(say, plan) {
  say(`plan: throne ${shortCommit(plan.state.headCommit)} -> ${shortCommit(plan.state.targetCommit)} (${plan.state.sourceBranch} of ${plan.checkout.source}, ${plan.state.relation})`);
  say(`plan: lockfile ${plan.lockfileChanged ? 'differs from the last install' : 'matches the last install'}`);
  for (const harness of plan.harnesses) say(`plan: ${harness.name} pinned ${harness.pinned}, installed ${harness.installed}`);
  say(`plan: herdr pinned ${plan.pins.herdr}, running service ${plan.runningHerdr}`);
  if (plan.detachedRestart.verdict !== DETACHED_VERDICTS.NONE) say(`plan: ${describeDetachedRestart(plan.detachedRestart)}`);
}

function forkAwaitsItsAnswer(plan) {
  return plan.checkout.kind === CHECKOUT_KINDS.FORK && hasNewCommits(plan.state.relation);
}

function questionsFor(plan) {
  const questions = [];
  if (forkAwaitsItsAnswer(plan)) {
    questions.push(`bring ${plan.state.newCommitCount} new commit(s) from ${plan.checkout.source} ${plan.state.sourceBranch} into this fork? A yes passes ${BRING_IN_UPSTREAM_FLAG}; no answer means no.`);
  }
  if (!detachedRestartIsRunning(plan) && (plan.herdrMoves || plan.agentsNeedRestart)) {
    const what = plan.herdrMoves
      ? `restart herdr to ${plan.pins.herdr}, which ends every agent and relaunches them`
      : 'restart every agent onto the pinned harness, which loses any in-flight tool result';
    questions.push(`${what}? A yes passes ${RESTART_WORD_FLAG} "<the invoker's words, verbatim>".`);
  }
  return questions;
}

function herdrRefusal(plan, answers) {
  if (!plan.herdrMoves || answers.restartWords !== undefined) return undefined;
  return `the update moves herdr from ${plan.runningHerdr} to ${plan.pins.herdr}, and every herdr call fails until a restart that ends every agent; pass ${RESTART_WORD_FLAG} "<the invoker's words, verbatim>"`;
}

function detachedRestartRefusal(plan) {
  if (!detachedRestartIsRunning(plan)) return undefined;
  return `a detached restart is still running, so nothing was started a second time; read ${plan.detachedRestart.log} and run again when it ends`;
}

function refusalWhateverTheAnswers(plan) {
  return detachedRestartRefusal(plan) ?? checkoutRefusal(plan.checkout, plan.state) ?? plan.pins.mergeConflict;
}

function refusalBeforePull(plan, answers) {
  return refusalWhateverTheAnswers(plan) ?? herdrRefusal(plan, answers);
}

function runStepKeepingItsResult(context, say, label, command, args) {
  say(`running ${label}`);
  return context.runProcess(command, args, { cwd: context.root });
}

function stopWhenStepFailed(label, result) {
  if (result.status !== 0) {
    throw failed(`${label} exited ${result.status}: ${result.stdout.trim()} ${result.stderr.trim()}`);
  }
}

function runStep(context, say, label, command, args) {
  const result = runStepKeepingItsResult(context, say, label, command, args);
  stopWhenStepFailed(label, result);
  return result.stdout;
}

function pinnedNodeBinary(context) {
  const version = NODE_PIN_LINE.exec(readFileSync(path.join(context.root, 'mise.toml'), 'utf8'))?.[1];
  return path.join(context.home, '.local', 'share', 'mise', 'installs', 'node', String(version), 'bin', 'node');
}

function installPinnedNode(context, say) {
  if (!existsSync(pinnedNodeBinary(context))) runStep(context, say, 'mise install node', 'mise', ['install', 'node']);
}

function withPinnedNodeFirstOnPath(context) {
  const nodeFolder = path.dirname(pinnedNodeBinary(context));
  const env = { ...process.env, PATH: `${nodeFolder}${path.delimiter}${process.env.PATH}` };
  return { ...context, runProcess: (command, args, options = {}) => context.runProcess(command, args, { env, ...options }) };
}

function installDependencies(context, say) {
  const lockfile = readFileSync(path.join(context.root, LOCKFILE));
  if (dependenciesAreCurrent(context.root, lockfile)) return;
  runStep(context, say, 'npm ci', 'npm', ['ci', '--no-audit', '--no-fund']);
  mkdirSync(path.dirname(installedLockfileStampPath(context.root)), { recursive: true });
  writeFileSync(installedLockfileStampPath(context.root), `${lockfileHash(lockfile)}\n`);
}

function buildWhenBehindSource(context, say) {
  if (!checkDistIsFresh(context.root, path.join(context.root, 'dist')).ok) {
    oweBotBridgesARestart(context);
    runStep(context, say, 'npm run build', 'npm', ['run', 'build']);
  }
}

function harnessStayedPut(context, harness) {
  return readInstalledHarness(context, harness, harness.pinned).installed === harness.installed;
}

function moveHarnessToPin(context, say, harness) {
  const label = `update-harness pinned ${harness.name}`;
  const updater = path.join(context.root, HARNESS_UPDATER);
  const owedBeforeTheStep = readPendingRestarts(context.root);
  if (harness.moves) addPendingRestarts(context.root, [AGENTS_PENDING]);
  const result = runStepKeepingItsResult(context, say, label, NODE_ON_PATH, [
    updater,
    'pinned',
    '--harness',
    harness.name,
    '--throne-root',
    context.root,
  ]);
  if (result.status !== 0 && harnessStayedPut(context, harness)) writePendingRestarts(context.root, owedBeforeTheStep);
  stopWhenStepFailed(label, result);
  const moved = HARNESS_MOVED_LINE.exec(result.stdout);
  return moved === null ? `report: ${harness.name} ${harness.pinned} unchanged` : `report: ${harness.name} ${moved[1]} -> ${moved[2]}`;
}

async function installServices(context, say) {
  const label = 'install-services';
  const result = runStepKeepingItsResult(context, say, label, path.join(context.root, THRONE_COMMAND), ['install-services']);
  const changed = servicesChangedWhileRunning(result.stdout);
  await rememberRestartsOwed(context, changed);
  if (result.status !== 0) oweUnitsAReload(context);
  stopWhenStepFailed(label, result);
  await reloadUnitsWhenOwed(context);
  return changed;
}

function whyAgentsWaitForTheWord(plan) {
  if (plan.detachedRestart.verdict === DETACHED_VERDICTS.FAILED) {
    return `their detached restart did not succeed and no restart word was given; read ${plan.detachedRestart.log}`;
  }
  if (plan.harnesses.some((harness) => harness.moves)) return 'a harness moved and no restart word was given, so they still run the old binary';
  return 'an earlier run owed them a restart that has not happened, and no restart word was given';
}

function agentRestartOutcome(context, plan, answers) {
  if (plan.herdrMoves || !readPendingRestarts(context.root).includes(AGENTS_PENDING)) return { restartsNext: false, notRestarted: [] };
  if (answers.restartWords === undefined) {
    return { restartsNext: false, notRestarted: [{ what: 'agents', why: whyAgentsWaitForTheWord(plan) }] };
  }
  return { restartsNext: true, notRestarted: [] };
}

function reportLines(context, plan, outcomes) {
  const herdrLine = plan.herdrMoves
    ? `report: herdr ${plan.runningHerdr} -> ${plan.pins.herdr}`
    : `report: herdr ${plan.pins.herdr} unchanged`;
  const lines = [
    `report: throne ${shortCommit(plan.state.headCommit)} -> ${shortCommit(readCurrentCommit(context))}`,
    ...outcomes.harnesses,
    herdrLine,
  ];
  if (outcomes.madeMergeCommit) lines.push('report: merged upstream locally, nothing was pushed');
  for (const what of outcomes.restarts.restarted) lines.push(`report: restarted ${what}`);
  for (const { what, why } of outcomes.restarts.notRestarted) lines.push(`report: not restarted ${what} — ${why}`);
  if (outcomes.agentsRestartNext) lines.push('report: restarting every agent, by throne restart-harnesses --force, which runs next');
  return lines;
}

function reportHandOver(say, what, log) {
  say(`report: handed ${what} to a detached run, which is not yet a result; read ${log}`);
}

function restartAgents(context, say) {
  const output = runStep(context, say, 'throne restart-harnesses --force', path.join(context.root, THRONE_COMMAND), ['restart-harnesses', '--force']);
  relay(say, output);
  const handedOverTo = recordAgentRestartHandOver(context.root, output);
  if (handedOverTo !== undefined) {
    reportHandOver(say, "every agent's restart", handedOverTo);
    return;
  }
  removePendingRestart(context.root, AGENTS_PENDING);
  say('report: restarted every agent');
}

function relay(say, output) {
  for (const line of output.split('\n')) {
    if (line.trim() !== '') say(line);
  }
}

async function finishThroughHerdrUpgrade(context, say, plan, answers) {
  const label = 'herdr-upgrade --pinned';
  const word = answers.restartWords === undefined ? [] : ['--yes', RESTART_WORD_FLAG, answers.restartWords];
  const owedBeforeTheStep = readPendingRestarts(context.root);
  const logLengthBeforeTheStep = readHerdrLogLength(context);
  if (plan.herdrMoves) await oweHerdrRestart(context, logLengthBeforeTheStep);
  const result = runStepKeepingItsResult(context, say, label, NODE_ON_PATH, [path.join(context.root, HERDR_UPGRADER), '--pinned', ...word]);
  const handedOverTo = herdrHandOverLogIn(result.stdout);
  if (handedOverTo === undefined) writePendingRestarts(context.root, owedBeforeTheStep);
  else if (!plan.herdrMoves) await oweHerdrRestart(context, logLengthBeforeTheStep);
  stopWhenStepFailed(label, result);
  relay(say, result.stdout);
  if (handedOverTo !== undefined) reportHandOver(say, "herdr's restart", handedOverTo);
}

function pullOwingWhatThePullChanges(context, plan) {
  const owedBeforeThePull = readPendingRestarts(context.root);
  const toolsOwed = [...plan.pins.toolsWhoseImageMoved, ...plan.pins.toolsWhoseServedFilesChanged];
  addPendingRestarts(context.root, toolsOwed.map((tool) => serviceFileOfPinnedImage(context.platform, tool)));
  try {
    return pullLatest(context, plan.checkout, plan.state);
  } catch (error) {
    writePendingRestarts(context.root, owedBeforeThePull);
    throw error;
  }
}

async function performUpdate(contextBeforePull, say, plan, answers) {
  settleDetachedRestart(contextBeforePull.root, plan.detachedRestart);
  const madeMergeCommit = pullOwingWhatThePullChanges(contextBeforePull, plan);
  installPinnedNode(contextBeforePull, say);
  const context = withPinnedNodeFirstOnPath(contextBeforePull);
  installDependencies(context, say);
  buildWhenBehindSource(context, say);
  const harnesses = plan.harnesses.map((harness) => moveHarnessToPin(context, say, harness));
  const changedServices = await installServices(context, say);
  const services = plan.herdrMoves
    ? await restartWhatHerdrLeaves(context)
    : await restartServicesThatChanged(context, changedServices);
  const agents = agentRestartOutcome(context, plan, answers);
  const restarts = {
    restarted: services.restarted,
    notRestarted: [...services.notRestarted, ...agents.notRestarted],
  };
  for (const line of reportLines(context, plan, { madeMergeCommit, harnesses, restarts, agentsRestartNext: agents.restartsNext })) say(line);
  if (agents.restartsNext) restartAgents(context, say);
  await finishThroughHerdrUpgrade(context, say, plan, answers);
  return EXIT_DONE;
}

async function checkOrUpdate(context, say, answers) {
  const checkout = await detectCheckoutKind(context);
  say(`checkout: ${checkout.kind} (${checkout.reason})`);
  const plan = await planUpdate(context, checkout);
  printPlan(say, plan);
  if (answers.check) {
    for (const question of questionsFor(plan)) say(`question: ${question}`);
    const refusal = refusalWhateverTheAnswers(plan);
    if (refusal !== undefined) say(`a run would refuse: ${refusal}`);
    return EXIT_DONE;
  }
  if (forkAwaitsItsAnswer(plan) && !answers.bringInUpstream) {
    say(`fork left alone: ${plan.state.newCommitCount} new commit(s) from ${plan.checkout.source} were not brought in, and nothing changed`);
    return EXIT_DONE;
  }
  const refusal = refusalBeforePull(plan, answers);
  if (refusal !== undefined) throw refused(refusal);
  return performUpdate(context, say, plan, answers);
}

function takeRunLock(context) {
  try {
    return acquireTransactionLock(path.join(context.root, RUN_LOCK_FOLDER), RUN_LOCK_NAMES);
  } catch (error) {
    throw refused(error.message);
  }
}

async function checkOrUpdateAlone(context, say, answers) {
  if (answers.check) return checkOrUpdate(context, say, answers);
  const runLock = takeRunLock(context);
  try {
    return await checkOrUpdate(context, say, answers);
  } finally {
    rmSync(runLock, { recursive: true, force: true });
  }
}

export async function runUpdateThrone({
  root,
  argv,
  runProcess = runProcessOnThisMachine,
  askHost = askGithubAboutRepository,
  platform = process.platform,
  userId = process.getuid(),
  home = os.homedir(),
  serviceGenerationMarkerDirectory,
  print = (text) => process.stdout.write(text),
}) {
  const answers = parseUpdateArguments(argv);
  if (answers === undefined) {
    print(`${LINE_PREFIX}${USAGE}\n`);
    return EXIT_BAD_ARGUMENT;
  }
  const say = openLog(home, answers.check ? 'check' : 'run', print);
  const context = { root, runProcess, askHost, platform, userId, home, serviceGenerationMarkerDirectory };
  try {
    return await checkOrUpdateAlone(context, say, answers);
  } catch (error) {
    say(error instanceof UpdateStopped ? error.message : `FAILED: ${error.message}`);
    return EXIT_STOPPED;
  }
}

function calledAsTheEntryScript() {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
}

if (calledAsTheEntryScript()) {
  process.exitCode = await runUpdateThrone({
    root: path.resolve(import.meta.dirname, '..'),
    argv: process.argv.slice(2),
  });
}
