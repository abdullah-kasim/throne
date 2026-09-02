#!/usr/bin/env node
// herdr-upgrade — move the throne's pinned herdr to a new release, end to end.
//
// Written after doing it by hand on 2026-08-24 (v0.8.0 -> v0.8.2). Every
// guard below exists because that run hit the thing it guards against; see
// src/herdr-update/RUNBOOK.md for the narrative.
//
//   node scripts/herdr-upgrade.mjs v0.8.3 [--dry-run] [--yes]
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
//
// Phases 8-10 run inside a systemd transient unit so they complete even if
// the caller's own pane dies. Panes are NOT expected to die -- that was a
// confident prediction that proved false -- but agent NAME registrations are
// wiped by the restart, which is what phases 7 and 9 exist for.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, copyFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const REPO = path.resolve(import.meta.dirname, '..');
const HERDR_HOME = path.join(os.homedir(), '.local', 'share', 'throne', 'herdr');
const SESSION = 'throne';
const LOG = path.join(os.homedir(), 'tmp', 'herdr-upgrade.log');

const argv = process.argv.slice(2);
const TAG = argv.find((a) => /^v\d+\.\d+\.\d+$/.test(a));
const DRY = argv.includes('--dry-run');
const YES = argv.includes('--yes');

function say(msg) {
  process.stdout.write(`herdr-upgrade: ${msg}\n`);
}
function die(msg) {
  process.stderr.write(`herdr-upgrade: REFUSING — ${msg}\n`);
  process.exit(1);
}
async function sh(file, args, opts = {}) {
  return execFileAsync(file, args, { maxBuffer: 64 * 1024 * 1024, ...opts });
}

if (!TAG) {
  die('pass the target release tag, e.g. `node scripts/herdr-upgrade.mjs v0.8.3`');
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
  if (busy.length > 0 && !YES) {
    die(
      `live campaign agents present:\n${busy.join('\n')}\n` +
        'phases 6-8 leave every throne herdr call failing protocol_mismatch. ' +
        'Drain the court first, or pass --yes to accept that window.',
    );
  }
  say('  clean tree, no live campaign agents');
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
  const ev = await rehearseHerdrUpdate(TAG);
  delete process.env.THRONE_HERDR_SESSION_NAME_OVERRIDE;
  if (!ev.download.hashMatched) {
    die(`artifact hash ${ev.download.computedSha256} != release metadata ${ev.download.expectedSha256}`);
  }
  const failed = ev.sweep.filter((s) => !s.succeeded);
  if (failed.length > 0) {
    die(`command sweep failed: ${failed.map((f) => f.command).join(', ')}`);
  }
  say(`  hash verified ${ev.download.computedSha256}`);
  say(`  sweep clean (${ev.sweep.length} commands)`);
  say(`  live protocol reported by ${TAG} itself: ${ev.protocol.liveProtocol}`);
  return { artifactPath: ev.download.artifactPath, protocol: String(ev.protocol.liveProtocol) };
}

// ---------------------------------------------------------------- phase 3
async function install(artifactPath) {
  say(`phase 3: installing ${TAG} alongside existing versions`);
  // NEVER install from PATH or a package manager: the Homebrew 0.8.2 binary
  // was NOT byte-identical to the GitHub release artifact (450cb7b1... vs
  // 976150a1...). Only the hash-verified download is trusted.
  const dir = path.join(HERDR_HOME, TAG);
  if (DRY) return say(`  would install -> ${path.join(dir, 'herdr')}`);
  await mkdir(dir, { recursive: true });
  await copyFile(artifactPath, path.join(dir, 'herdr'));
  await chmod(path.join(dir, 'herdr'), 0o755);
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
  if (DRY) return say('  would run npm run build + install-services');
  await sh('npm', ['run', 'build'], { cwd: REPO });
  say('phase 7: re-rendering the systemd unit onto the new binary path');
  await sh(path.join(REPO, 'bin', 'throne-cli'), ['install-services'], { cwd: REPO });
  const unit = await sh('systemctl', ['--user', 'cat', 'throne-herdr.service']);
  const exec = unit.stdout.split('\n').find((l) => l.startsWith('ExecStart='));
  if (!exec?.includes(pinnedBinary(TAG))) {
    die(`unit ExecStart does not name ${pinnedBinary(TAG)} after install-services:\n${exec}`);
  }
  say(`  ${exec.trim()}`);
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
function restartScript(identities) {
  const newBin = pinnedBinary(TAG);
  return `#!/usr/bin/env bash
exec >>${JSON.stringify(LOG)} 2>&1
echo "===== herdr-upgrade ${TAG} restart $(date -Is) ====="
systemctl --user restart throne-herdr.service
for i in $(seq 1 30); do
  sleep 2
  ${JSON.stringify(newBin)} --session ${SESSION} status server --json >/dev/null 2>&1 && break
done
echo "--- server after restart ---"
${JSON.stringify(newBin)} --session ${SESSION} status server --json
# throne-backend lives in its OWN cgroup, survives the herdr restart, and
# would keep running the OLD dist in memory -- still believing the previous
# protocol and binary path. It hosts the only cron that resurrects the
# Regent, so leaving it unrestarted means nothing can bring the court back.
systemctl --user restart throne-backend.service
sleep 8
echo "--- identity repair ---"
${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(REPO, 'scripts', 'herdr-repair-identities.mjs'))} ${JSON.stringify(JSON.stringify(identities))} ${JSON.stringify(newBin)}
echo "--- end-to-end ---"
${JSON.stringify(path.join(REPO, 'bin', 'throne-cli'))} agent-statuses | head -20
echo "===== done $(date -Is) ====="
`;
}

async function restartDetached(identities) {
  say('phases 8-10: restart + identity repair, detached');
  const scriptPath = path.join(os.homedir(), 'tmp', `herdr-upgrade-${TAG}.sh`);
  if (DRY) return say(`  would systemd-run ${scriptPath}`);
  await mkdir(path.dirname(scriptPath), { recursive: true });
  await writeFile(scriptPath, restartScript(identities), { mode: 0o755 });
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

// ---------------------------------------------------------------------- go
const previous = await readFile(path.join(REPO, 'src', 'herdr', 'herdr-client.ts'), 'utf8')
  .then((s) => /OWNED_HERDR_CLIENT_RELEASE_TAG = '([^']+)'/.exec(s)?.[1]);
const previousBinary = previous ? pinnedBinary(previous) : 'herdr';
say(`current pin ${previous ?? 'unknown'} -> target ${TAG}`);
const before = await serverStatus(previousBinary);
say(`live throne server: ${before ? `${before.version} protocol ${before.protocol}` : 'unreachable'}`);

await preflight();
const { artifactPath, protocol } = await rehearse();
await install(artifactPath);
await movePins(protocol);
const identities = await snapshotIdentities(previousBinary);
await buildAndRender();
await restartDetached(identities);
say('done issuing; the detached unit owns the rest');
