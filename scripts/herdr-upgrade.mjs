#!/usr/bin/env bun
// herdr-upgrade — move the throne's pinned herdr to a new release, end to end.
//
// Written after doing it by hand on 2026-08-24 (v0.8.0 -> v0.8.2). Every
// guard below exists because that run hit the thing it guards against; see
// src/herdr-update/RUNBOOK.md for the narrative.
//
// Phases, each verified before the next is entered:
//   1 preflight   2 rehearse   3 install   4 pins
//   5 identity snapshot  6 build   7 unit
//   8 restart (detached)  9 identity repair  10 verify
//
// Phase 5 runs BEFORE phase 6 on purpose: the build is what opens the
// client/server protocol mismatch, and once it is open the throne can no
// longer ask herdr who is who. Snapshot the identities while you can still
// read them.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { landPinCommit } from './land-pin-commit.mjs';

const execFileAsync = promisify(execFile);
const REPO = path.resolve(import.meta.dirname, '..');
const HERDR_HOME = path.join(os.homedir(), '.local', 'share', 'throne', 'herdr');
const SESSION = 'throne';
const LOG = path.join(os.homedir(), 'tmp', 'herdr-upgrade.log');
const RESTART_MODULE = path.join(REPO, 'dist', 'src', 'herdr-update', 'herdr-upgrade-restart.js');
const AGREEMENT_MODULE = path.join(REPO, 'dist', 'src', 'herdr-update', 'herdr-version-agreement.js');
const HERDR_SHIM = path.join(REPO, 'bin', 'herdr');

const {
  HERDR_UPGRADE_MODES,
  RELEASE_TAG_PATTERN,
  RESTART_FAILED_PREFIX,
  herdrRestartSteps,
  installedTagRefusal,
  lordsWordsFrom,
  restartRefusal,
  renderedHerdrAgentPath,
  renderedHerdrAgentRefusal,
  shellCommand,
} = await import(RESTART_MODULE);
const { HERDR_PIN_PATHS, dirtyPathsOutsideHerdrPins, herdrPinCommitMessage, rewrittenHerdrPins, writeHerdrPins } =
  await import(path.join(REPO, 'dist', 'src', 'herdr-update', 'herdr-upgrade-pins.js'));
const { herdrIsAtPin, herdrVersionAgreement, onlyBinHerdrMissesThePin, readHerdrVersions } = await import(AGREEMENT_MODULE);
const { HERDR_INSTALL_OUTCOMES, HERDR_UPDATE_REPOSITORY, installRehearsedRelease, installedBinaryHasHash } =
  await import(path.join(REPO, 'dist', 'src', 'herdr-update', 'herdr-update-release.js'));
const { parseAgentList } = await import(path.join(REPO, 'dist', 'src', 'herdr', 'herdr-inventory.service.js'));
const { REAL_DEPS } = await import(path.join(REPO, 'dist', 'src', 'install-services', 'platform.js'));
const PLATFORM = REAL_DEPS.platform;

const argv = process.argv.slice(2);
const previous = await readFile(path.join(REPO, 'src', 'herdr', 'herdr-client.ts'), 'utf8')
  .then((s) => /OWNED_HERDR_CLIENT_RELEASE_TAG = '([^']+)'/.exec(s)?.[1]);
const PINNED = argv.includes('--pinned');
const NAMED_TAG = argv.find((a) => RELEASE_TAG_PATTERN.test(a));
const TAG = PINNED ? previous : NAMED_TAG;
const CHECK = argv.includes('--check');
const DRY = argv.includes('--dry-run');
const YES = argv.includes('--yes');
const LORDS_WORDS = lordsWordsFrom(argv);
const MODE = CHECK ? HERDR_UPGRADE_MODES.CHECK : DRY ? HERDR_UPGRADE_MODES.DRY_RUN : HERDR_UPGRADE_MODES.APPLY;

function appendToLog(line) {
  mkdirSync(path.dirname(LOG), { recursive: true });
  appendFileSync(LOG, `${line}\n`);
}
function say(msg) {
  const line = `herdr-upgrade: ${msg}`;
  appendToLog(line);
  process.stdout.write(`${line}\n`);
}
function die(msg) {
  const line = `herdr-upgrade: REFUSING — ${msg}`;
  appendToLog(line);
  process.stderr.write(`${line}\n`);
  process.exit(1);
}
async function sh(file, args, opts = {}) {
  return execFileAsync(file, args, { maxBuffer: 64 * 1024 * 1024, ...opts });
}

appendToLog(`===== herdr-upgrade ${MODE} ${TAG ?? 'no tag'} ${new Date().toISOString()} =====`);
if (!TAG && !CHECK) {
  die('pass the target release tag, e.g. `bun scripts/herdr-upgrade.mjs v0.8.3`, or --pinned, or --check');
}
if (PINNED && NAMED_TAG) {
  die(`--pinned goes to the tag this checkout pins, so it takes no tag, and ${NAMED_TAG} was passed`);
}

const pinnedBinary = (tag) => path.join(HERDR_HOME, tag, 'herdr');

/** Always address the throne session explicitly. A stray sessionless herdr
 *  server (observed: a brew 0.8.0 daemon alive for five days on
 *  ~/.config/herdr/herdr.sock) will happily answer `status server` with a
 *  DIFFERENT version, which once made a successful upgrade read as a total
 *  failure. Never query herdr without --session during an upgrade. */
async function herdr(binary, args) {
  const { stdout } = await sh(binary, ['--session', SESSION, ...args]);
  return stdout;
}

async function serverStatus(binary) {
  try {
    return JSON.parse(await herdr(binary, ['status', 'server', '--json']));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- phase 1
async function preflight() {
  say(`phase 1: preflight for ${TAG}`);
  const refusal = restartRefusal(MODE, LORDS_WORDS);
  if (refusal) die(refusal);
  if (MODE === HERDR_UPGRADE_MODES.APPLY) say(`  restart ordered by the Lord: ${JSON.stringify(LORDS_WORDS)}`);
  if ((await dirtyPathsOutsideHerdrPins(REPO)) !== '') {
    die('the throne checkout is dirty; commit or stash before an upgrade so a failed run is revertible');
  }
  const installedRefusal = installedTagRefusal(MODE, pinnedBinary(TAG), existsSync(pinnedBinary(TAG)), YES || PINNED);
  if (installedRefusal) die(installedRefusal);
  // A live campaign must never meet the client/server mismatch window opened
  // between phase 5 and phase 8.
  const roster = await sh(path.join(REPO, 'bin', 'throne-cli'), ['agent-statuses'])
    .then((r) => r.stdout)
    .catch(() => '');
  const busy = roster
    .split('\n')
    .filter((l) => /\bLIVE\b/.test(l))
    .filter((l) => /^(alpha|shadow)-/.test(l.trim()));
  if (busy.length > 0 && DRY) {
    say(`  live campaign agents present (a real run would refuse them without --yes):\n${busy.join('\n')}`);
  } else if (busy.length > 0 && !YES) {
    die(
      `live campaign agents present:\n${busy.join('\n')}\n` +
        'phases 6-8 leave every throne herdr call failing protocol_mismatch. ' +
        'Drain the court first, or pass --yes to accept that window.',
    );
  }
  say(`  clean tree${busy.length > 0 ? '' : ', no live campaign agents'}`);
}

// ---------------------------------------------------------------- phase 2
async function rehearse() {
  say(`phase 2: rehearsing ${TAG} in an isolated session`);
  const { rehearseHerdrUpdate } = await import(
    path.join(REPO, 'dist', 'src', 'herdr-update', 'herdr-update-rehearsal.js')
  );
  // The rehearsal REFUSES the live session name; this override is mandatory,
  // not cosmetic.
  process.env.THRONE_HERDR_SESSION_NAME_OVERRIDE = `herdr-upgrade-rehearsal-${TAG}`;
  const ev = await rehearseHerdrUpdate(TAG).catch((error) => die(`rehearsal failed: ${error.message}`));
  delete process.env.THRONE_HERDR_SESSION_NAME_OVERRIDE;
  if (!ev.download.hashMatched) {
    die(`artifact hash ${ev.download.computedSha256} != release metadata ${ev.download.expectedSha256}`);
  }
  const failed = ev.sweep.filter((s) => !s.succeeded);
  if (failed.length > 0) {
    die(`command sweep failed: ${failed.map((f) => f.command).join(', ')}`);
  }
  say(`  isolated session ${ev.sessionName}, torn down after the sweep`);
  say(`  hash verified ${ev.download.computedSha256}`);
  say(`  sweep clean (${ev.sweep.length} commands)`);
  say(`  live protocol reported by ${TAG} itself: ${ev.protocol.liveProtocol}`);
  return { rehearsedSha256: ev.download.computedSha256, protocol: String(ev.protocol.liveProtocol) };
}

// ---------------------------------------------------------------- phase 3
async function install(rehearsedSha256) {
  say(`phase 3: installing ${TAG} alongside existing versions`);
  // NEVER install from PATH or a package manager: the Homebrew 0.8.2 binary
  // was NOT byte-identical to the GitHub release artifact (450cb7b1... vs
  // 976150a1...). Only the hash-verified download is trusted.
  const destination = pinnedBinary(TAG);
  if (DRY) {
    const alreadyInstalled = await installedBinaryHasHash(destination, rehearsedSha256);
    return say(alreadyInstalled ? `  would leave ${destination} in place` : `  would install -> ${destination}`);
  }
  const outcome = await installRehearsedRelease(TAG, rehearsedSha256, destination).catch((error) => die(error.message));
  const { stdout } = await sh(destination, ['--version']);
  say(`  ${outcome === HERDR_INSTALL_OUTCOMES.INSTALLED ? 'installed' : 'left in place'} ${destination} (${stdout.trim()})`);
  // The previous version stays: RUNBOOK retirement criteria require the
  // fallback to survive until the new tag has baked in real use.
}

// ---------------------------------------------------------------- phase 4
async function movePins(protocol) {
  say('phase 4: moving both pins');
  // Digests come from real release metadata, never hand-computed. A previous
  // move of this constant shipped fabricated checksums.
  const metadata = JSON.parse(
    (await sh(path.join(REPO, 'bin', 'gh'), ['api', `repos/${HERDR_UPDATE_REPOSITORY}/releases/tags/${TAG}`])).stdout,
  );
  const target = { tag: TAG, protocol, repositorySlug: HERDR_UPDATE_REPOSITORY, metadata };
  const pins = await rewrittenHerdrPins(REPO, target).catch((error) => die(error.message));
  if (DRY) return say(`  would pin ${TAG} / protocol ${protocol} in both files`);
  await writeHerdrPins(REPO, pins);
  say(`  pinned ${TAG} / protocol ${protocol}, digests from ${HERDR_UPDATE_REPOSITORY} release metadata`);
}

// ---------------------------------------------------------------- phase 6-7
async function build() {
  say('phase 6: build (opens the client/server mismatch window)');
  if (DRY) return say('  would run npm run build');
  await sh('npm', ['run', 'build'], { cwd: REPO });
}

async function renderUnit() {
  if (DRY) return say(`phase 7: would run install-services and check ${renderedServiceFile()} names ${pinnedBinary(TAG)}`);
  say(`phase 7: re-rendering ${renderedServiceFile()} onto the new binary path`);
  await sh(path.join(REPO, 'bin', 'throne-cli'), ['install-services'], { cwd: REPO });
  if (PLATFORM === 'darwin') {
    const refusal = await renderedHerdrAgentRefusal(renderedHerdrAgentPath(), pinnedBinary(TAG));
    if (refusal) die(refusal);
    return say(`  ${renderedHerdrAgentPath()} names ${pinnedBinary(TAG)}`);
  }
  const unit = await sh('systemctl', ['--user', 'cat', 'throne-herdr.service']);
  const exec = unit.stdout.split('\n').find((l) => l.startsWith('ExecStart='));
  if (!exec?.includes(pinnedBinary(TAG))) {
    die(`unit ExecStart does not name ${pinnedBinary(TAG)} after install-services:\n${exec}`);
  }
  say(`  ${exec.trim()}`);
}

function landPins() {
  const message = herdrPinCommitMessage(TAG);
  if (DRY) return say(`phase 7: would land moved pins as one commit "${message}"; unchanged pins make none`);
  const pinCommit = landPinCommit({ repository: REPO, paths: HERDR_PIN_PATHS, message });
  say(`phase 7: ${pinCommit.detail}`);
  if (pinCommit.pushRefused) process.exitCode = 1;
}

function renderedServiceFile() {
  return PLATFORM === 'darwin' ? renderedHerdrAgentPath() : 'throne-herdr.service (systemctl --user cat)';
}

// ---------------------------------------------------------------- phase 5
async function snapshotIdentities(previousBinary) {
  say('phase 5: snapshotting agent identities (the restart wipes these)');
  const agents = parseAgentList(await herdr(previousBinary, ['agent', 'list'])).filter((agent) => agent.name);
  say(`  ${agents.length} named agent(s): ${agents.map((agent) => `${agent.name}@${agent.paneId}`).join(', ')}`);
  return agents;
}

async function snapshotRunningService(status) {
  if (!status) die('cannot read the running herdr version, so its agents cannot be snapshotted');
  if (!status.running) {
    say('phase 5: no herdr server is running, so there are no identities to snapshot');
    return [];
  }
  const runningBinary = pinnedBinary(`v${status.version}`);
  if (!existsSync(runningBinary)) {
    die(`the running server is ${status.version} and ${runningBinary} is missing, so its agents cannot be snapshotted`);
  }
  return snapshotIdentities(runningBinary);
}

// ------------------------------------------------------------- phases 8-10
function restartSteps() {
  const verdict =
    `const { restartedServerVerdict } = await import(${JSON.stringify(pathToFileURL(RESTART_MODULE).href)});` +
    ` const line = restartedServerVerdict(process.argv[1], ${JSON.stringify(TAG)});` +
    " console.log(line); process.exitCode = line.startsWith('FAILED:') ? 1 : 0;";
  return herdrRestartSteps({
    platform: PLATFORM,
    userId: REAL_DEPS.userId(),
    newBinary: pinnedBinary(TAG),
    session: SESSION,
    verifyServer: [process.execPath, '--input-type=module', '-e', verdict, '--'],
  });
}

function versionAgreementCommand() {
  const agreement =
    `const { herdrVersionAgreement, readHerdrVersions } = await import(${JSON.stringify(pathToFileURL(AGREEMENT_MODULE).href)});` +
    ` const line = herdrVersionAgreement(await readHerdrVersions(${JSON.stringify(HERDR_SHIM)}));` +
    ` console.log(line); process.exit(line.startsWith(${JSON.stringify(RESTART_FAILED_PREFIX)}) ? 1 : 0);`;
  return shellCommand([process.execPath, '--input-type=module', '-e', agreement]);
}

function restartScript(identities) {
  const newBin = pinnedBinary(TAG);
  const stepsUnderTheLock = [...restartSteps().map((step) => step.bash), 'sleep 8'].join('\n');
  return `#!/usr/bin/env bash
exec >>${JSON.stringify(LOG)} 2>&1
echo "===== herdr-upgrade ${TAG} restart $(date) ====="
echo "--- restart, resume and identity repair, under the resurrect lock ---"
${shellCommand([process.execPath, path.join(REPO, 'scripts', 'herdr-repair-identities.mjs'), JSON.stringify(identities), newBin, stepsUnderTheLock])} || echo "${RESTART_FAILED_PREFIX} the restart and identity repair exited $?"
echo "--- end-to-end ---"
${JSON.stringify(path.join(REPO, 'bin', 'throne-cli'))} agent-statuses | head -20
echo "===== done $(date) ====="
${versionAgreementCommand()}
`;
}

async function restartDetached(identities) {
  say('phases 8-10: restart, resume and identity repair, detached');
  const scriptPath = path.join(os.homedir(), 'tmp', `herdr-upgrade-${TAG}.sh`);
  if (DRY) {
    say(`  would run ${scriptPath} detached ${PLATFORM === 'darwin' ? 'in its own session' : 'under systemd-run'}:`);
    say('  phase 8: take the resurrect lock, held until the Regent is relaunched');
    for (const step of restartSteps()) say(`  phase 8: ${step.says}`);
    say(`  phase 9: would relaunch the ${identities.length} snapshotted agent(s), the Regent last, under the resurrect lock`);
    say('  phase 10: would print the roster, then the throne cli, bin/herdr and running service versions side by side');
    return;
  }
  await mkdir(path.dirname(scriptPath), { recursive: true });
  await writeFile(scriptPath, restartScript(identities), { mode: 0o755 });
  if (PLATFORM === 'darwin') {
    spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' }).unref();
    return say(`  detached; follow it with:  tail -f ${LOG}`);
  }
  // Its own transient scope, outside the herdr service cgroup, so the run
  // completes regardless of what the restart does to the caller's pane.
  await sh('systemd-run', [
    '--user',
    '--collect',
    `--unit=throne-herdr-upgrade-${TAG.replace(/\./g, '-')}`,
    scriptPath,
  ]);
  say(`  detached; follow it with:  tail -f ${LOG}`);
}

async function reportCheck(pinnedTag, pinnedBinaryPath) {
  const client = await readFile(path.join(REPO, 'src', 'herdr', 'herdr-client.ts'), 'utf8');
  const pinnedProtocol = /THRONE_HERDR_PROTOCOL = '([^']+)'/.exec(client)?.[1];
  say(`check: pinned ${pinnedTag ?? 'unknown'} protocol ${pinnedProtocol ?? 'unknown'}`);
  const installed = await readdir(HERDR_HOME).catch(() => []);
  say(`check: installed under ${HERDR_HOME}: ${installed.filter((name) => /^v\d/.test(name)).join(', ') || 'none'}`);
  const live = await serverStatus(pinnedBinaryPath);
  say(`check: live ${SESSION} server: ${live ? `${live.version} protocol ${live.protocol}` : 'unreachable'}`);
  const agreement = herdrVersionAgreement(await readHerdrVersions(HERDR_SHIM));
  say(`check: ${agreement}`);
  const latest = JSON.parse(
    (await sh(path.join(REPO, 'bin', 'gh'), ['api', `repos/${HERDR_UPDATE_REPOSITORY}/releases/latest`])).stdout,
  );
  say(`check: latest release of ${HERDR_UPDATE_REPOSITORY}: ${latest.tag_name} (${latest.published_at})`);
  return agreement.startsWith(RESTART_FAILED_PREFIX) ? 1 : 0;
}

async function goToNamedTag() {
  await preflight();
  const { rehearsedSha256, protocol } = await rehearse();
  await install(rehearsedSha256);
  await movePins(protocol);
  const identities = await snapshotIdentities(previousBinary);
  await build();
  await renderUnit();
  landPins();
  await restartDetached(identities);
}

async function goToPinnedTag(runningStatus) {
  await preflight();
  const identities = await snapshotRunningService(runningStatus);
  await renderUnit();
  await restartDetached(identities);
}

// ---------------------------------------------------------------------- go
async function runningServiceBinary() {
  const serviceText =
    PLATFORM === 'darwin'
      ? (await sh('launchctl', ['print', `gui/${REAL_DEPS.userId()}/com.throne.throne-herdr`]).catch(() => ({ stdout: '' }))).stdout
      : (await sh('systemctl', ['--user', 'cat', 'throne-herdr.service']).catch(() => ({ stdout: '' }))).stdout;
  const runningTag = /\/herdr\/(v[^/\s"]+)\/herdr\b/.exec(serviceText)?.[1];
  return runningTag && existsSync(pinnedBinary(runningTag)) ? pinnedBinary(runningTag) : undefined;
}
const previousBinary = (await runningServiceBinary()) ?? (previous ? pinnedBinary(previous) : 'herdr');
if (CHECK) {
  process.exit(await reportCheck(previous, previousBinary));
}
say(`current pin ${previous ?? 'unknown'} -> target ${TAG}`);
const before = await serverStatus(previousBinary);
say(`live throne server: ${before ? `${before.version} protocol ${before.protocol}` : 'unreachable'}`);

if (PINNED) {
  const versions = await readHerdrVersions(HERDR_SHIM);
  if (herdrIsAtPin(versions, TAG)) {
    say(herdrVersionAgreement(versions));
    say(`herdr is at its pin ${TAG}, nothing to do`);
    process.exit(0);
  }
  if (onlyBinHerdrMissesThePin(versions, TAG)) {
    die(
      `bin/herdr reports ${versions.shim}, not the pin ${TAG}, while the throne cli and the running service are at the pin. ` +
        `bin/herdr runs the highest release under ${HERDR_HOME}, so a restart cannot change it and nothing was restarted; ` +
        `remove any release above ${TAG} from that folder and run again`,
    );
  }
  say(`herdr is not at its pin ${TAG}: throne cli ${versions.cli}, bin/herdr ${versions.shim}, running service ${versions.service}`);
  await goToPinnedTag(before);
} else {
  await goToNamedTag();
}
say(DRY ? 'dry run done; nothing was changed' : 'done issuing; the detached unit owns the rest');
