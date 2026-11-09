import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { failed } from './update-throne-checkout.mjs';
import { readServiceGenerationMarker, SERVICE_GENERATION_MARKER_DIR } from '../src/status/service-generation-marker.ts';
import { readCurrentDistGeneration } from '../src/status/dist-generation.ts';

export const AGENTS_PENDING = 'agents';
export const DETACHED_VERDICTS = { NONE: 'none', RUNNING: 'running', SUCCEEDED: 'succeeded', FAILED: 'failed' };

const DETACHED_RESTART_PENDING_PREFIX = 'detached-restart ';
const DETACHED_LOG_QUIET_LIMIT_MS = 30 * 60 * 1000;
const WHOLE_LOG = 0;
const AGENT_RESTART = 'agents';
const HERDR_RESTART = 'herdr';
export const DETACHED_LOG_LINES = {
  [AGENT_RESTART]: {
    handOver: /^restart-harnesses: continuing in a detached run; read (.+)$/m,
    opening: /^=== restart-harnesses run /gm,
    closing: /^restart-harnesses: finished — /m,
    failure: /^restart-harnesses: finished — .*, [1-9]\d* failed$/m,
  },
  [HERDR_RESTART]: {
    handOver: /^herdr-upgrade:\s+detached; follow it with:\s+tail -f (.+)$/m,
    opening: /^herdr-upgrade: phases 8-10: /gm,
    closing: /^===== done [\s\S]*^(?:throne cli herdr |FAILED:)/m,
    failure: /^FAILED: (?!gpg-agent )/m,
  },
};
const BOT_BRIDGES_PENDING = 'bot-bridges';
const UNITS_RELOAD_PENDING = 'units-reload';
const PLATFORM_WITH_SYSTEMD_UNITS = 'linux';
const CHANGED_SERVICE_LINE = /^install-services: (\S+): installed content changed while the (?:unit was running|agent was loaded)\./gm;

function pendingRestartsPath(root) {
  return path.join(root, 'vendor', '.stamps', 'update-throne-pending-restarts');
}

export function readPendingRestarts(root) {
  const file = pendingRestartsPath(root);
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((entry) => entry !== '') : [];
}

export function writePendingRestarts(root, entries) {
  const file = pendingRestartsPath(root);
  if (entries.length === 0) return rmSync(file, { force: true });
  mkdirSync(path.dirname(file), { recursive: true });
  return writeFileSync(file, `${entries.join('\n')}\n`);
}

export function addPendingRestarts(root, entries) {
  writePendingRestarts(root, [...new Set([...readPendingRestarts(root), ...entries])]);
}

export function removePendingRestart(root, entry) {
  writePendingRestarts(root, readPendingRestarts(root).filter((pending) => pending !== entry));
}

function isDetachedRestartEntry(entry) {
  return entry.startsWith(DETACHED_RESTART_PENDING_PREFIX);
}

function lastSectionOf(logText, opening) {
  const openings = [...logText.matchAll(opening)];
  return openings.length === 0 ? '' : logText.slice(openings.at(-1).index);
}

function logHasGoneQuiet(log) {
  return Date.now() - statSync(log).mtimeMs > DETACHED_LOG_QUIET_LIMIT_MS;
}

function logTextAfter(log, logLengthAtHandOver) {
  return readFileSync(log).subarray(logLengthAtHandOver).toString('utf8');
}

function stepNeverWroteToLog(log, logLengthAtHandOver) {
  return statSync(log).size <= logLengthAtHandOver;
}

function verdictInLog(kind, log, logLengthAtHandOver) {
  if (!existsSync(log) || stepNeverWroteToLog(log, logLengthAtHandOver)) return DETACHED_VERDICTS.FAILED;
  const lines = DETACHED_LOG_LINES[kind];
  const section = lastSectionOf(logTextAfter(log, logLengthAtHandOver), lines.opening);
  if (lines.closing.test(section)) return lines.failure.test(section) ? DETACHED_VERDICTS.FAILED : DETACHED_VERDICTS.SUCCEEDED;
  return logHasGoneQuiet(log) ? DETACHED_VERDICTS.FAILED : DETACHED_VERDICTS.RUNNING;
}

export function readDetachedRestart(root) {
  const entry = readPendingRestarts(root).find(isDetachedRestartEntry);
  if (entry === undefined) return { verdict: DETACHED_VERDICTS.NONE };
  const { kind, log, clears, logLengthAtHandOver } = JSON.parse(entry.slice(DETACHED_RESTART_PENDING_PREFIX.length));
  return { verdict: verdictInLog(kind, log, logLengthAtHandOver), entry, log, clears };
}

export function pendingOnceVerdictIsRead(root, detachedRestart) {
  const pending = readPendingRestarts(root);
  if (detachedRestart.verdict === DETACHED_VERDICTS.SUCCEEDED) {
    return pending.filter((entry) => entry !== detachedRestart.entry && !detachedRestart.clears.includes(entry));
  }
  if (detachedRestart.verdict === DETACHED_VERDICTS.FAILED) return pending.filter((entry) => entry !== detachedRestart.entry);
  return pending;
}

export function settleDetachedRestart(root, detachedRestart) {
  writePendingRestarts(root, pendingOnceVerdictIsRead(root, detachedRestart));
}

function recordDetachedRestart(root, kind, log, clears, logLengthAtHandOver) {
  const otherEntries = readPendingRestarts(root).filter((entry) => !isDetachedRestartEntry(entry));
  writePendingRestarts(root, [...otherEntries, `${DETACHED_RESTART_PENDING_PREFIX}${JSON.stringify({ kind, log, clears, logLengthAtHandOver })}`]);
}

function handOverLogIn(kind, output) {
  return DETACHED_LOG_LINES[kind].handOver.exec(output)?.[1];
}

export function recordAgentRestartHandOver(root, output) {
  const log = handOverLogIn(AGENT_RESTART, output);
  if (log !== undefined) recordDetachedRestart(root, AGENT_RESTART, log, [AGENTS_PENDING], WHOLE_LOG);
  return log;
}

function hasSystemdUnits(context) {
  return context.platform === PLATFORM_WITH_SYSTEMD_UNITS;
}

export function oweBotBridgesARestart(context) {
  if (hasSystemdUnits(context)) addPendingRestarts(context.root, [BOT_BRIDGES_PENDING]);
}

export function oweUnitsAReload(context) {
  if (hasSystemdUnits(context)) addPendingRestarts(context.root, [UNITS_RELOAD_PENDING]);
}

export function serviceFileOfPinnedImage(platform, tool) {
  return platform === 'darwin' ? `com.throne.${tool}.plist` : `${tool}.service`;
}

export function servicesChangedWhileRunning(installServicesOutput) {
  return [...installServicesOutput.matchAll(CHANGED_SERVICE_LINE)].map((match) => match[1]);
}

function loadRestartPlans(root) {
  const restartModule = path.join(root, 'dist', 'src', 'herdr-update', 'herdr-upgrade-restart.js');
  return import(pathToFileURL(restartModule).href);
}

function runRestartStep(context, step) {
  const result = context.runProcess('bash', ['-c', step.bash], { cwd: context.root });
  if (result.status !== 0) throw failed(`${step.says}: ${result.stdout.trim()} ${result.stderr.trim()}`);
}

function readBackendGeneration(context, backendUnit) {
  const markerDirectory = context.serviceGenerationMarkerDirectory ?? SERVICE_GENERATION_MARKER_DIR;
  return readServiceGenerationMarker(backendUnit, markerDirectory)?.generation;
}

function generationIsOld(context, running) {
  const current = readCurrentDistGeneration(path.join(context.root, 'dist'));
  return current !== undefined && running !== current;
}

function restartPendingService(context, plans, target, service, outcome) {
  const [command, ...args] = plans.serviceIsRunningCommand(target, service);
  if (context.runProcess(command, args, { cwd: context.root }).status !== 0) {
    outcome.notRestarted.push({ what: service, why: 'it is not running' });
    return;
  }
  for (const step of plans.changedServiceRestartSteps(target, service, context.root)) runRestartStep(context, step);
  outcome.restarted.push(service);
}

function restartBackendWhenStale(context, plans, target, outcome) {
  if (outcome.restarted.includes(plans.backendServiceFile(target))) return;
  const running = readBackendGeneration(context, plans.BACKEND_SERVICE_UNIT);
  if (running === undefined) {
    outcome.notRestarted.push({ what: 'throne-backend', why: 'it left no generation marker, so what it runs cannot be read' });
    return;
  }
  if (!generationIsOld(context, running)) return;
  runRestartStep(context, plans.restartBackendStep(target));
  outcome.restarted.push('throne-backend');
}

function listRunningBotBridges(context, plans) {
  const [command, ...args] = plans.runningBotBridgesCommand();
  const listing = context.runProcess(command, args, { cwd: context.root });
  if (listing.status !== 0) throw failed(`${command} ${args.join(' ')}: ${listing.stdout.trim()} ${listing.stderr.trim()}`);
  return listing.stdout.split('\n').map((line) => line.trim().split(/\s+/)[0]).filter((unit) => unit !== '');
}

function nameTheBotBridgesOwed(context, plans) {
  if (!readPendingRestarts(context.root).includes(BOT_BRIDGES_PENDING)) return;
  addPendingRestarts(context.root, listRunningBotBridges(context, plans));
  removePendingRestart(context.root, BOT_BRIDGES_PENDING);
}

export async function reloadUnitsWhenOwed(context) {
  if (!readPendingRestarts(context.root).includes(UNITS_RELOAD_PENDING)) return;
  const plans = await loadRestartPlans(context.root);
  runRestartStep(context, plans.reloadUnitsStep());
  removePendingRestart(context.root, UNITS_RELOAD_PENDING);
}

export async function rememberRestartsOwed(context, changedServices) {
  const plans = await loadRestartPlans(context.root);
  addPendingRestarts(context.root, changedServices.filter((service) => !plans.isTerminalServerFile(service)));
}

function restartTargetOf(context) {
  return { platform: context.platform, userId: context.userId };
}

function restartPendingServices(context, plans, services, outcome) {
  for (const service of services) {
    restartPendingService(context, plans, restartTargetOf(context), service, outcome);
    removePendingRestart(context.root, service);
  }
}

export async function restartServicesThatChanged(context, changedServices) {
  const plans = await loadRestartPlans(context.root);
  const outcome = { restarted: [], notRestarted: [] };
  for (const service of changedServices.filter(plans.isTerminalServerFile)) {
    outcome.notRestarted.push({ what: service, why: 'its file changed with no herdr version move, and restarting it ends every agent' });
  }
  nameTheBotBridgesOwed(context, plans);
  restartPendingServices(context, plans, readPendingRestarts(context.root).filter((entry) => entry !== AGENTS_PENDING), outcome);
  restartBackendWhenStale(context, plans, restartTargetOf(context), outcome);
  return outcome;
}

function herdrRestartCovers(plans, entry) {
  return entry === AGENTS_PENDING || entry === BOT_BRIDGES_PENDING || plans.herdrRestartCoversService(entry);
}

function whatHerdrRestarts(context) {
  const services = hasSystemdUnits(context) ? 'herdr, any bot server and bot bridges, the backend' : 'herdr, the backend';
  return `${services} and every agent, by herdr-upgrade.mjs --pinned, which runs next`;
}

export async function restartWhatHerdrLeaves(context) {
  const plans = await loadRestartPlans(context.root);
  const outcome = { restarted: [whatHerdrRestarts(context)], notRestarted: [] };
  restartPendingServices(context, plans, readPendingRestarts(context.root).filter((entry) => !herdrRestartCovers(plans, entry)), outcome);
  return outcome;
}

function herdrUpgradeLog(context) {
  return path.join(context.home, 'tmp', 'herdr-upgrade.log');
}

export function readHerdrLogLength(context) {
  const log = herdrUpgradeLog(context);
  return existsSync(log) ? statSync(log).size : WHOLE_LOG;
}

export function herdrHandOverLogIn(output) {
  return handOverLogIn(HERDR_RESTART, output);
}

export async function oweHerdrRestart(context, logLengthAtHandOver) {
  const plans = await loadRestartPlans(context.root);
  addPendingRestarts(context.root, [AGENTS_PENDING]);
  const clears = readPendingRestarts(context.root).filter((entry) => herdrRestartCovers(plans, entry));
  recordDetachedRestart(context.root, HERDR_RESTART, herdrUpgradeLog(context), clears, logLengthAtHandOver);
}
