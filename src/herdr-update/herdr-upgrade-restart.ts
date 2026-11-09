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

export const BACKEND_SERVICE_UNIT = SYSTEMD_UNIT_NAMES.THRONE_BACKEND;

export type HerdrRestartTarget = {
  readonly platform: string;
  readonly userId: number;
  readonly newBinary: string;
  readonly session: string;
  readonly verifyServer: readonly string[];
};

export type ServiceRestartTarget = Pick<HerdrRestartTarget, 'platform' | 'userId'>;

const SECONDS_TO_WAIT_FOR_BOOTOUT = 30;
const BOOTSTRAP_ATTEMPTS = 10;
const SECONDS_BETWEEN_BOOTSTRAP_ATTEMPTS = 2;
const SERVER_WAIT_ATTEMPTS = 30;
const SECONDS_BETWEEN_SERVER_WAITS = 2;
const SERVER_RUNNING_FIELD = '"running":true';
const BOT_SESSION = 'throne-bot';
const EVERY_BOT_BRIDGE = SYSTEMD_UNIT_NAMES.THRONE_BOT_BRIDGE_TEMPLATE.replace('@.', '@*.');
const BOT_BRIDGE_UNIT_PREFIX = SYSTEMD_UNIT_NAMES.THRONE_BOT_BRIDGE_TEMPLATE.replace('.service', '');
const SIGNING_AGENT = 'gpg-agent';
const SIGNING_AGENT_SCOPE_PREFIX = 'throne-gpg-agent-';
const SECONDS_TO_WAIT_FOR_SIGNING_AGENT_MOVE = 10;
const SIGNING_AGENT_LOST_CONSEQUENCE = 'signing will need the passphrase after the restart';
const START_TRANSIENT_UNIT = [
  'busctl',
  '--user',
  'call',
  'org.freedesktop.systemd1',
  '/org/freedesktop/systemd1',
  'org.freedesktop.systemd1.Manager',
  'StartTransientUnit',
  'ssa(sv)a(sa(sv))',
] as const;

function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

export function shellCommand(command: readonly string[]): string {
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

export function reloadUnitsStep(): RestartStep {
  const command = [SERVICE_MANAGER_EXECUTABLES.SYSTEMCTL, '--user', 'daemon-reload'];
  return { says: command.join(' '), bash: shellCommand(command) };
}

export function runningBotBridgesCommand(): string[] {
  return [
    SERVICE_MANAGER_EXECUTABLES.SYSTEMCTL,
    '--user',
    'list-units',
    '--type=service',
    '--state=running',
    '--plain',
    '--no-legend',
    EVERY_BOT_BRIDGE,
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

function moveSigningAgentsOutStep(): RestartStep {
  const units = [SYSTEMD_UNIT_NAMES.THRONE_HERDR, SYSTEMD_UNIT_NAMES.THRONE_BOT_HERDR];
  const insideUnits = units.map((unit) => unit.replaceAll('.', '\\.')).join('|');
  const signingAgents = shellCommand(['ps', '-C', SIGNING_AGENT, '-o', 'pid=,cgroup=']);
  const failedMove = (reason: string): string =>
    `  echo ${shellQuote(`${RESTART_FAILED_PREFIX} `)}"${SIGNING_AGENT} $agent_pid ${reason}, so ${SIGNING_AGENT_LOST_CONSEQUENCE}"`;
  return {
    says: `move any ${SIGNING_AGENT} out of ${units.join(' and ')} so its cached passphrase outlives the restart; a ${RESTART_FAILED_PREFIX} line here does not stop the run`,
    bash: [
      `agents_to_move=$(${signingAgents} | grep -E ${shellQuote(`/(${insideUnits})(/|$)`)} | awk '{print $1}')`,
      'if [ -z "$agents_to_move" ]; then',
      `  echo ${shellQuote(`no ${SIGNING_AGENT} inside ${units.join(' or ')}, nothing to move`)}`,
      'fi',
      'for agent_pid in $agents_to_move; do',
      `  agent_scope=${SIGNING_AGENT_SCOPE_PREFIX}$agent_pid.scope`,
      `  if ! move_output=$(${shellCommand(START_TRANSIENT_UNIT)} "$agent_scope" fail 1 PIDs au 1 "$agent_pid" 0 2>&1); then`,
      `  ${failedMove('could not be moved: $move_output')}`,
      '    continue',
      '  fi',
      '  agent_moved=no',
      `  for attempt in $(seq 1 ${SECONDS_TO_WAIT_FOR_SIGNING_AGENT_MOVE}); do`,
      `    if ${signingAgents} | grep -q "^ *$agent_pid .*/$agent_scope$"; then agent_moved=yes; break; fi`,
      '    sleep 1',
      '  done',
      '  if [ "$agent_moved" = yes ]; then',
      `    echo "moved ${SIGNING_AGENT} $agent_pid into $agent_scope with its cache intact"`,
      '  else',
      `  ${failedMove(`did not reach $agent_scope within ${SECONDS_TO_WAIT_FOR_SIGNING_AGENT_MOVE} s`)}`,
      '  fi',
      'done',
    ].join('\n'),
  };
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
    return [moveSigningAgentsOutStep(), restartSystemdUnitStep(SYSTEMD_UNIT_NAMES.THRONE_HERDR)];
  }
  throw new Error(`no restart plan for the terminal server on platform "${target.platform}"`);
}

function tryRestartSystemdUnitStep(unit: string): RestartStep {
  const command = [SERVICE_MANAGER_EXECUTABLES.SYSTEMCTL, '--user', 'try-restart', unit];
  const failureLine = `${RESTART_FAILED_PREFIX} ${command.join(' ')} exited non-zero`;
  return { says: command.join(' '), bash: `${shellCommand(command)} || echo ${shellQuote(failureLine)}` };
}

function tryRestartBotServerAndBridgesSteps(target: HerdrRestartTarget): RestartStep[] {
  if (target.platform !== 'linux') return [];
  return [tryRestartSystemdUnitStep(SYSTEMD_UNIT_NAMES.THRONE_BOT_HERDR), tryRestartSystemdUnitStep(EVERY_BOT_BRIDGE)];
}

function serverStatusCommand(binary: string, session: string): string {
  return shellCommand([binary, '--session', session, 'status', 'server', '--json']);
}

function waitForRunningServer(serverStatus: string): string {
  return [
    `for attempt in $(seq 1 ${SERVER_WAIT_ATTEMPTS}); do`,
    `  sleep ${SECONDS_BETWEEN_SERVER_WAITS}`,
    `  ${serverStatus} 2>/dev/null | grep -qF ${shellQuote(SERVER_RUNNING_FIELD)} && break`,
    'done',
  ].join('\n');
}

function verifyBotServerSteps(target: HerdrRestartTarget): RestartStep[] {
  if (target.platform !== 'linux') return [];
  const serverStatus = serverStatusCommand(target.newBinary, BOT_SESSION);
  const unitIsActive = shellCommand([
    SERVICE_MANAGER_EXECUTABLES.SYSTEMCTL,
    '--user',
    'is-active',
    '--quiet',
    SYSTEMD_UNIT_NAMES.THRONE_BOT_HERDR,
  ]);
  return [
    {
      says: `when ${SYSTEMD_UNIT_NAMES.THRONE_BOT_HERDR} is active, verify the ${BOT_SESSION} server runs the target release; a ${RESTART_FAILED_PREFIX} line here does not stop the run`,
      bash: [
        `if ${unitIsActive}; then`,
        waitForRunningServer(serverStatus),
        `bot_server_status=$(${serverStatus})`,
        `echo ${shellQuote(`${BOT_SESSION} server:`)}`,
        `${shellCommand(target.verifyServer)} "$bot_server_status"`,
        'fi',
      ].join('\n'),
    },
  ];
}

export function restartBackendStep(target: ServiceRestartTarget): RestartStep {
  return target.platform === 'darwin'
    ? kickstartLaunchdAgentStep(target.userId, LAUNCHD_AGENT_NAMES.THRONE_BACKEND.label)
    : restartSystemdUnitStep(SYSTEMD_UNIT_NAMES.THRONE_BACKEND);
}

export function backendServiceFile(target: ServiceRestartTarget): string {
  return target.platform === 'darwin' ? LAUNCHD_AGENT_NAMES.THRONE_BACKEND.basename : SYSTEMD_UNIT_NAMES.THRONE_BACKEND;
}

const TERMINAL_SERVER_FILES: readonly string[] = [
  SYSTEMD_UNIT_NAMES.THRONE_HERDR,
  SYSTEMD_UNIT_NAMES.THRONE_BOT_HERDR,
  LAUNCHD_AGENT_NAMES.THRONE_HERDR.basename,
];

export function isTerminalServerFile(serviceFile: string): boolean {
  return TERMINAL_SERVER_FILES.includes(serviceFile);
}

function launchdLabelOf(serviceFile: string): string {
  return serviceFile.replace(/\.plist$/, '');
}

export function serviceIsRunningCommand(target: ServiceRestartTarget, serviceFile: string): string[] {
  return target.platform === 'darwin'
    ? [SERVICE_MANAGER_EXECUTABLES.LAUNCHCTL, 'print', `gui/${target.userId}/${launchdLabelOf(serviceFile)}`]
    : [SERVICE_MANAGER_EXECUTABLES.SYSTEMCTL, '--user', 'is-active', '--quiet', serviceFile];
}

export function changedServiceRestartSteps(
  target: ServiceRestartTarget,
  serviceFile: string,
  checkoutRoot: string,
): RestartStep[] {
  return target.platform === 'darwin'
    ? launchdAgentReloadSteps(
        target.userId,
        launchdLabelOf(serviceFile),
        path.join(LAUNCH_AGENTS_DIR, serviceFile),
        checkoutRoot,
      )
    : [restartSystemdUnitStep(serviceFile)];
}

export function herdrRestartSteps(target: HerdrRestartTarget): RestartStep[] {
  const serverStatus = serverStatusCommand(target.newBinary, target.session);
  return [
    ...restartHerdrSteps(target),
    ...tryRestartBotServerAndBridgesSteps(target),
    {
      says: `wait until ${target.newBinary} --session ${target.session} status server --json reports it running`,
      bash: waitForRunningServer(serverStatus),
    },
    {
      says: `verify the restarted ${target.session} server runs the target release, else write ${RESTART_FAILED_PREFIX} and stop`,
      bash: [`server_status=$(${serverStatus})`, `${shellCommand(target.verifyServer)} "$server_status" || exit 1`].join(
        '\n',
      ),
    },
    ...verifyBotServerSteps(target),
    restartBackendStep(target),
  ];
}

export function herdrRestartCoversService(service: string): boolean {
  return service === BACKEND_SERVICE_UNIT || service.startsWith(BOT_BRIDGE_UNIT_PREFIX);
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

export function installedTagRefusal(
  mode: HerdrUpgradeMode,
  binaryPath: string,
  binaryExists: boolean,
  yes: boolean,
): string | undefined {
  if (mode !== HERDR_UPGRADE_MODES.APPLY || !binaryExists || yes) {
    return undefined;
  }
  return `${binaryPath} already exists; pass --yes to reuse it`;
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
