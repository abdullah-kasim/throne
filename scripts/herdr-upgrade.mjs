#!/usr/bin/env node
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
import { readFile, readdir, writeFile, mkdir, copyFile, chmod } from 'node:fs/promises';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const REPO = path.resolve(import.meta.dirname, '..');
const HERDR_HOME = path.join(os.homedir(), '.local', 'share', 'throne', 'herdr');
const SESSION = 'throne';
const LOG = path.join(os.homedir(), 'tmp', 'herdr-upgrade.log');
const RESTART_MODULE = path.join(REPO, 'dist', 'src', 'herdr-update', 'herdr-upgrade-restart.js');

const {
  HERDR_UPGRADE_MODES,
  RELEASE_TAG_PATTERN,
  herdrRestartSteps,
  lordsWordsFrom,
  restartRefusal,
  renderedHerdrAgentPath,
  renderedHerdrAgentRefusal,
} = await import(RESTART_MODULE);
const { REAL_DEPS } = await import(path.join(REPO, 'dist', 'src', 'install-services', 'platform.js'));
const PLATFORM = REAL_DEPS.platform;

const argv = process.argv.slice(2);
const TAG = argv.find((a) => RELEASE_TAG_PATTERN.test(a));
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
  die('pass the target release tag, e.g. `node scripts/herdr-upgrade.mjs v0.8.3`, or --check');
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
  const { stdout: dirty } = await sh('git', ['-C', REPO, 'status', '--porcelain']);
  if (dirty.trim() !== '') {
    die('the throne checkout is dirty; commit or stash before an upgrade so a failed run is revertible');
  }
  if (existsSync(pinnedBinary(TAG)) && !YES) {
    die(`${pinnedBinary(TAG)} already exists; pass --yes to reuse it`);
  }
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
  const dir = path.join(HERDR_HOME, TAG);
  if (DRY) return say(`  would install -> ${path.join(dir, 'herdr')}`);
  const { downloadAndVerifyHerdrRelease } = await import(
    path.join(REPO, 'dist', 'src', 'herdr-update', 'herdr-update-release.js')
  );
  const download = await downloadAndVerifyHerdrRelease(TAG);
  const matchesRehearsal = download.hashMatched && download.computedSha256 === rehearsedSha256;
  try {
    if (matchesRehearsal) {
      await mkdir(dir, { recursive: true });
      await copyFile(download.artifactPath, path.join(dir, 'herdr'));
      await chmod(path.join(dir, 'herdr'), 0o755);
    }
  } finally {
    await download.cleanup();
  }
  if (!matchesRehearsal) {
    die(`install download hash ${download.computedSha256} is not the rehearsed ${rehearsedSha256}`);
  }
  const { stdout } = await sh(pinnedBinary(TAG), ['--version']);
  say(`  installed ${path.join(dir, 'herdr')} (${stdout.trim()})`);
  // The previous version stays: RUNBOOK retirement criteria require the
  // fallback to survive until the new tag has baked in real use.
}

// ---------------------------------------------------------------- phase 4
async function movePins(protocol) {
  say('phase 4: moving both pins');
  const version = TAG.replace(/^v/, '');
  const clientPath = path.join(REPO, 'src', 'herdr', 'herdr-client.ts');
  let client = await readFile(clientPath, 'utf8');
  const tagLine = /export const OWNED_HERDR_CLIENT_RELEASE_TAG = '[^']+';/;
  const protoLine = /export const THRONE_HERDR_PROTOCOL = '[^']+';/;
  if (!tagLine.test(client) || !protoLine.test(client)) {
    die('herdr-client.ts pin constants not found in their expected shape');
  }
  client = client
    .replace(tagLine, `export const OWNED_HERDR_CLIENT_RELEASE_TAG = '${TAG}';`)
    .replace(protoLine, `export const THRONE_HERDR_PROTOCOL = '${protocol}';`);

  // Digests come from real release metadata, never hand-computed. A previous
  // move of this constant shipped fabricated checksums.
  const releasePath = path.join(REPO, 'src', 'install-services', 'herdr-release.service.ts');
  let release = await readFile(releasePath, 'utf8');
  const repoSlug = /export const HERDR_UPDATE_REPOSITORY = '([^']+)'/.exec(
    await readFile(path.join(REPO, 'src', 'herdr-update', 'herdr-update-release.ts'), 'utf8'),
  )?.[1];
  if (!repoSlug) die('could not read HERDR_UPDATE_REPOSITORY');
  const meta = JSON.parse(
    (await sh(path.join(REPO, 'bin', 'gh'), ['api', `repos/${repoSlug}/releases/tags/${TAG}`])).stdout,
  );
  const digestOf = (name) => {
    const asset = meta.assets.find((a) => a.name === name);
    const digest = asset?.digest;
    if (!digest?.startsWith('sha256:')) die(`no sha256 digest in release metadata for ${name}`);
    return digest.slice('sha256:'.length);
  };
  release = release
    .replace(/version: '[^']+',/, `version: '${version}',`)
    .replace(/repository: '[^']+',/, `repository: '${repoSlug}',`)
    .replace(/tag: '[^']+',/, `tag: '${TAG}',`);
  for (const target of ['linux-aarch64', 'linux-x86_64', 'macos-aarch64', 'macos-x86_64']) {
    const filename = `herdr-${target}`;
    const block = new RegExp(`(filename: '${filename}',\\s*\\n\\s*sha256: ')[0-9a-f]{64}(')`);
    if (!block.test(release)) die(`could not locate the ${target} sha256 slot`);
    release = release.replace(block, `$1${digestOf(filename)}$2`);
  }
  if (DRY) return say(`  would pin ${TAG} / protocol ${protocol} in both files`);
  await writeFile(clientPath, client);
  await writeFile(releasePath, release);
  say(`  pinned ${TAG} / protocol ${protocol}, digests from ${repoSlug} release metadata`);
}

// ---------------------------------------------------------------- phase 6-7
async function buildAndRender() {
  say('phase 6: build (opens the client/server mismatch window)');
  if (DRY) {
    say('  would run npm run build');
    say(`phase 7: would run install-services and check ${renderedServiceFile()} names ${pinnedBinary(TAG)}`);
    return;
  }
  await sh('npm', ['run', 'build'], { cwd: REPO });
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

function renderedServiceFile() {
  return PLATFORM === 'darwin' ? renderedHerdrAgentPath() : 'throne-herdr.service (systemctl --user cat)';
}

// ---------------------------------------------------------------- phase 5
async function snapshotIdentities(previousBinary) {
  say('phase 5: snapshotting agent identities (the restart wipes these)');
  const list = JSON.parse(await herdr(previousBinary, ['agent', 'list']));
  const map = list.result.agents
    .filter((a) => a.name)
    .map((a) => ({ name: a.name, paneId: a.pane_id, session: a.agent_session?.value }));
  say(`  ${map.length} named agent(s): ${map.map((m) => `${m.name}@${m.paneId}`).join(', ')}`);
  return map;
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

function restartScript(identities) {
  const newBin = pinnedBinary(TAG);
  return `#!/usr/bin/env bash
exec >>${JSON.stringify(LOG)} 2>&1
echo "===== herdr-upgrade ${TAG} restart $(date) ====="
${restartSteps()
  .map((step) => step.bash)
  .join('\n')}
sleep 8
echo "--- identity repair ---"
${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(REPO, 'scripts', 'herdr-repair-identities.mjs'))} ${JSON.stringify(JSON.stringify(identities))} ${JSON.stringify(newBin)}
echo "--- end-to-end ---"
${JSON.stringify(path.join(REPO, 'bin', 'throne-cli'))} agent-statuses | head -20
echo "===== done $(date) ====="
`;
}

async function restartDetached(identities) {
  say('phases 8-10: restart + identity repair, detached');
  const scriptPath = path.join(os.homedir(), 'tmp', `herdr-upgrade-${TAG}.sh`);
  if (DRY) {
    say(`  would run ${scriptPath} detached ${PLATFORM === 'darwin' ? 'in its own session' : 'under systemd-run'}:`);
    for (const step of restartSteps()) say(`  phase 8: ${step.says}`);
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
  const { HERDR_UPDATE_REPOSITORY } = await import(
    path.join(REPO, 'dist', 'src', 'herdr-update', 'herdr-update-release.js')
  );
  const latest = JSON.parse(
    (await sh(path.join(REPO, 'bin', 'gh'), ['api', `repos/${HERDR_UPDATE_REPOSITORY}/releases/latest`])).stdout,
  );
  say(`check: latest release of ${HERDR_UPDATE_REPOSITORY}: ${latest.tag_name} (${latest.published_at})`);
}

// ---------------------------------------------------------------------- go
const previous = await readFile(path.join(REPO, 'src', 'herdr', 'herdr-client.ts'), 'utf8')
  .then((s) => /OWNED_HERDR_CLIENT_RELEASE_TAG = '([^']+)'/.exec(s)?.[1]);
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
  await reportCheck(previous, previousBinary);
  process.exit(0);
}
say(`current pin ${previous ?? 'unknown'} -> target ${TAG}`);
const before = await serverStatus(previousBinary);
say(`live throne server: ${before ? `${before.version} protocol ${before.protocol}` : 'unreachable'}`);

await preflight();
const { rehearsedSha256, protocol } = await rehearse();
await install(rehearsedSha256);
await movePins(protocol);
const identities = await snapshotIdentities(previousBinary);
await buildAndRender();
await restartDetached(identities);
say(DRY ? 'dry run done; nothing was changed' : 'done issuing; the detached unit owns the rest');
