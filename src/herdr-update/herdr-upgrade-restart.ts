import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  LAUNCH_AGENTS_DIR,
  LAUNCHD_AGENT_NAMES,
  SERVICE_MANAGER_EXECUTABLES,
  SYSTEMD_UNIT_NAMES,
} from '../install-services/service-unit-renderer.service.ts';
import { errorText } from '../shared-policy/error-text.ts';

export const HERDR_UPGRADE_MODES = {
  CHECK: 'check',
  DRY_RUN: 'dry-run',
  APPLY: 'apply',
} as const;

export type HerdrUpgradeMode = (typeof HERDR_UPGRADE_MODES)[keyof typeof HERDR_UPGRADE_MODES];

export const LORDS_WORD_FLAG = '--restart-ordered-by-lord';

export const RELEASE_TAG_PATTERN = /^v\d+\.\d+\.\d+$/;

export const RESTART_FAILED_PREFIX = 'FAILED:';

export type RestartStep = { readonly says: string; readonly bash: string };

export type HerdrRestartTarget = {
  readonly platform: string;
  readonly userId: number;
  readonly newBinary: string;
  readonly session: string;
  readonly verifyServer: readonly string[];
};

const SECONDS_TO_WAIT_FOR_BOOTOUT = 30;
const BOOTSTRAP_ATTEMPTS = 10;
const SECONDS_BETWEEN_BOOTSTRAP_ATTEMPTS = 2;
const SERVER_WAIT_ATTEMPTS = 30;
const SECONDS_BETWEEN_SERVER_WAITS = 2;

function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

function shellCommand(command: readonly string[]): string {
  return command.map(shellQuote).join(' ');
}

function failAndStop(message: string): string[] {
  return [`  echo ${shellQuote(`${RESTART_FAILED_PREFIX} `)}"${message}"`, '  exit 1'];
}

export function launchdAgentReloadSteps(
  userId: number,
  label: string,
  plistPath: string,
  newBinary: string,
): RestartStep[] {
  const launchctl = SERVICE_MANAGER_EXECUTABLES.LAUNCHCTL;
  const domain = `gui/${userId}`;
  const job = `${domain}/${label}`;
  const printJob = shellCommand([launchctl, 'print', job]);
  const bootstrap = [launchctl, 'bootstrap', domain, plistPath];
  const howToLoad = `; the agent ${label} may be unloaded, load it with: ${bootstrap.join(' ')}`;
  return [
    { says: `${launchctl} bootout ${job}`, bash: shellCommand([launchctl, 'bootout', job]) },
    {
      says: `wait until ${launchctl} print ${job} no longer finds the job (at most ${SECONDS_TO_WAIT_FOR_BOOTOUT} s)`,
      bash: [
        'bootout_confirmed=no',
        `for attempt in $(seq 1 ${SECONDS_TO_WAIT_FOR_BOOTOUT}); do`,
        `  ${printJob} >/dev/null 2>&1 || { bootout_confirmed=yes; break; }`,
        '  sleep 1',
        'done',
        'if [ "$bootout_confirmed" != yes ]; then',
        ...failAndStop(
          `${launchctl} print ${job} still finds the job ${SECONDS_TO_WAIT_FOR_BOOTOUT} s after bootout: $(${printJob} 2>&1 | head -5)${howToLoad}`,
        ),
        'fi',
      ].join('\n'),
    },
    {
      says: `${bootstrap.join(' ')} (at most ${BOOTSTRAP_ATTEMPTS} attempts while launchd refuses)`,
      bash: [
        'bootstrapped=no',
        `for attempt in $(seq 1 ${BOOTSTRAP_ATTEMPTS}); do`,
        `  if bootstrap_output=$(${shellCommand(bootstrap)} 2>&1); then bootstrapped=yes; break; fi`,
        `  sleep ${SECONDS_BETWEEN_BOOTSTRAP_ATTEMPTS}`,
        'done',
        'if [ "$bootstrapped" != yes ]; then',
        ...failAndStop(
          `${bootstrap.join(' ')} refused ${BOOTSTRAP_ATTEMPTS} times: $bootstrap_output${howToLoad}`,
        ),
        'fi',
      ].join('\n'),
    },
    {
      says: `confirm ${launchctl} print ${job} names ${newBinary}`,
      bash: [
        `if ! ${printJob} 2>&1 | grep -qF -- ${shellQuote(newBinary)}; then`,
        ...failAndStop(
          `${launchctl} print ${job} does not name ${newBinary} after bootstrap: $(${printJob} 2>&1 | grep -A3 arguments)`,
        ),
        'fi',
      ].join('\n'),
    },
  ];
}

function restartSystemdUnitStep(unit: string): RestartStep {
  const command = [SERVICE_MANAGER_EXECUTABLES.SYSTEMCTL, '--user', 'restart', unit];
  return { says: command.join(' '), bash: shellCommand(command) };
}

function kickstartLaunchdAgentStep(userId: number, label: string): RestartStep {
  const command = [SERVICE_MANAGER_EXECUTABLES.LAUNCHCTL, 'kickstart', '-k', `gui/${userId}/${label}`];
  return { says: command.join(' '), bash: shellCommand(command) };
}

function restartHerdrSteps(target: HerdrRestartTarget): RestartStep[] {
  if (target.platform === 'darwin') {
    return launchdAgentReloadSteps(
      target.userId,
      LAUNCHD_AGENT_NAMES.THRONE_HERDR.label,
      renderedHerdrAgentPath(),
      target.newBinary,
    );
  }
  if (target.platform === 'linux') {
    return [restartSystemdUnitStep(SYSTEMD_UNIT_NAMES.THRONE_HERDR)];
  }
  throw new Error(`no restart plan for the terminal server on platform "${target.platform}"`);
}

function restartBackendStep(target: HerdrRestartTarget): RestartStep {
  return target.platform === 'darwin'
    ? kickstartLaunchdAgentStep(target.userId, LAUNCHD_AGENT_NAMES.THRONE_BACKEND.label)
    : restartSystemdUnitStep(SYSTEMD_UNIT_NAMES.THRONE_BACKEND);
}

export function herdrRestartSteps(target: HerdrRestartTarget): RestartStep[] {
  const serverStatus = shellCommand([target.newBinary, '--session', target.session, 'status', 'server', '--json']);
  return [
    ...restartHerdrSteps(target),
    {
      says: `wait for ${target.newBinary} --session ${target.session} status server --json`,
      bash: [
        `for attempt in $(seq 1 ${SERVER_WAIT_ATTEMPTS}); do`,
        `  sleep ${SECONDS_BETWEEN_SERVER_WAITS}`,
        `  ${serverStatus} >/dev/null 2>&1 && break`,
        'done',
      ].join('\n'),
    },
    {
      says: `verify the restarted ${target.session} server runs the target release, else write ${RESTART_FAILED_PREFIX} and stop`,
      bash: [`server_status=$(${serverStatus})`, `${shellCommand(target.verifyServer)} "$server_status" || exit 1`].join(
        '\n',
      ),
    },
    restartBackendStep(target),
  ];
}

export function restartedServerVerdict(statusOutput: string, tag: string): string {
  let status: { version?: unknown; protocol?: unknown };
  try {
    status = JSON.parse(statusOutput);
  } catch {
    return `${RESTART_FAILED_PREFIX} the restarted server is unreachable, so ${tag} did not take: ${statusOutput.trim()}`;
  }
  if (status.version !== tag.replace(/^v/, '')) {
    return `${RESTART_FAILED_PREFIX} the restarted server runs ${String(status.version)}, not ${tag}, so the update did not take`;
  }
  return `restarted server runs ${status.version} protocol ${String(status.protocol)}`;
}

export function lordsWordsFrom(argv: readonly string[]): string | undefined {
  const flagAt = argv.indexOf(LORDS_WORD_FLAG);
  const words = flagAt === -1 ? undefined : argv[flagAt + 1];
  if (words === undefined || words.startsWith('-') || RELEASE_TAG_PATTERN.test(words)) {
    return undefined;
  }
  return words;
}

export function restartRefusal(mode: HerdrUpgradeMode, lordsWords: string | undefined): string | undefined {
  if (mode !== HERDR_UPGRADE_MODES.APPLY) {
    return undefined;
  }
  if ((lordsWords ?? '').trim() !== '') {
    return undefined;
  }
  return (
    'a real upgrade restarts herdr and the backend, and only the Lord orders that restart; ' +
    `pass ${LORDS_WORD_FLAG} "<the Lord's words, verbatim>" or run --dry-run`
  );
}

export function renderedHerdrAgentPath(): string {
  return path.join(LAUNCH_AGENTS_DIR, LAUNCHD_AGENT_NAMES.THRONE_HERDR.basename);
}

export async function renderedHerdrAgentRefusal(
  agentPath: string,
  newBinary: string,
): Promise<string | undefined> {
  let agent: string;
  try {
    agent = await readFile(agentPath, 'utf8');
  } catch (error) {
    return `cannot read ${agentPath} after install-services: ${errorText(error)}`;
  }
  return agent.includes(newBinary)
    ? undefined
    : `${agentPath} does not name ${newBinary} after install-services`;
}
