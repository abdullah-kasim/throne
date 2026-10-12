import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, constants, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, test } from 'node:test';
import { provisionPinnedNode } from './pinned-node.support.ts';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const REQUIRED_COREUTILS = ['bash', 'cat', 'dirname', 'mkdir', 'head', 'tr', 'sed', 'awk', 'seq', 'sleep', 'chmod', 'grep', 'sha256sum', 'cp', 'mv', 'rm', 'id'];
const TAILNET_IP = '192.0.2.10';
const MAGICDNS_NAME = 'forge-host.example.invalid';
const IDENTITY_NAME = 'Example Admin';
const IDENTITY_EMAIL = 'Example.Admin+forge@example.invalid';
const EXPECTED_ADMIN_LOGIN = 'example-admin-forge';
const GENERATED_API_TOKEN = 'generated-api-token-0123456789abcdef';
const TEA_VERSION = '0.16.0';
const TEA_ARTIFACT = `tea-${TEA_VERSION}-linux-amd64`;
const TEA_DOWNLOAD_URL = `https://gitea.com/gitea/tea/releases/download/v${TEA_VERSION}/${TEA_ARTIFACT}`;
const PODMAN_CLI_VERSION_REPORT = 'Client:       Podman Engine\nVersion:      6.1.1\n\nServer:       Podman Engine\nVersion:      6.1.1';
const DOCKER_CLI_ON_PODMAN_VERSION_REPORT =
  'Client: Docker Engine - Community\n Version:           29.8.0\n\nServer: linux/arm64/fedora-44\n Podman Engine:\n  Version:          6.1.1\n Engine:\n  Version:          6.1.1';
const LOOPBACK_FRONT_TARGET = 'http://127.0.0.1:8421';
const TAILNET_FRONT_TARGET = `http://${TAILNET_IP}:8420`;
const LOOPBACK_FRONT_CONFIGURATION = `serve --bg --https=8443 ${LOOPBACK_FRONT_TARGET}`;
const HTTPS_FRONT_STATUS = httpsFrontStatusProxyingTo(LOOPBACK_FRONT_TARGET);

function httpsFrontStatusProxyingTo(target: string): string {
  return JSON.stringify({
    TCP: { '8443': { HTTPS: true } },
    Web: { [`${MAGICDNS_NAME}:8443`]: { Handlers: { '/': { Proxy: target } } } },
  });
}

const scratch: string[] = [];
after(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

interface Fixture {
  throneRoot: string;
  fakeBin: string;
  stateDirectory: string;
  runtimeLog: string;
  tailscaleLog: string;
  installServicesLog: string;
  serveStatusFile: string;
  forgejoUsersFile: string;
  acceptedTokensFile: string;
  curlLog: string;
  teaReleaseDirectory: string;
  teaLog: string;
  teaLoginsFile: string;
  teaBinary: string;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function writeFakeExecutable(filePath: string, lines: string[]): Promise<void> {
  await writeFile(filePath, `#!/usr/bin/env bash\nset -e\n${lines.join('\n')}\n`, { mode: 0o755 });
}

async function resolveRealTool(name: string): Promise<string> {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(`required coreutil "${name}" not found on this machine's PATH`);
}

async function writeFakeContainerCli(
  fixture: Fixture,
  { reachable, cli = 'podman', versionReport = PODMAN_CLI_VERSION_REPORT }: { reachable: boolean; cli?: string; versionReport?: string },
): Promise<void> {
  await writeFakeExecutable(path.join(fixture.fakeBin, cli), [
    `printf '%s\\n' "$*" >> "${fixture.runtimeLog}"`,
    `if [ "$1" = version ]; then printf '%s\\n' '${versionReport}'; exit 0; fi`,
    `if [ "$1" = info ]; then exit ${reachable ? 0 : 125}; fi`,
    `if [ "$1" = image ] && [ "$2" = inspect ]; then grep -qx pulled "${fixture.runtimeLog}.pulled" 2>/dev/null; exit $?; fi`,
    `if [ "$1" = pull ]; then echo pulled > "${fixture.runtimeLog}.pulled"; exit 0; fi`,
    'if [ "$1" = exec ] && [ "$5" = user ] && [ "$6" = list ]; then',
    '    printf "ID   Username   Email   IsActive   IsAdmin   2FA\\n"',
    `    cat "${fixture.forgejoUsersFile}" 2>/dev/null || true`,
    '    exit 0',
    'fi',
    'if [ "$1" = exec ] && [ "$5" = user ] && [ "$6" = create ]; then',
    '    shift 6',
    '    while [ $# -gt 0 ]; do',
    `        if [ "$1" = --username ]; then printf '1   %s   x@example.invalid   true   true   false\\n' "$2" >> "${fixture.forgejoUsersFile}"; fi`,
    '        shift',
    '    done',
    'fi',
    'if [ "$1" = exec ] && [ "$5" = user ] && [ "$6" = generate-access-token ]; then',
    `    echo ${GENERATED_API_TOKEN} >> "${fixture.acceptedTokensFile}"`,
    `    echo ${GENERATED_API_TOKEN}`,
    'fi',
    'exit 0',
  ]);
}

async function writeFakeCurl(fixture: Fixture, { forgejoAnswers }: { forgejoAnswers: boolean } = { forgejoAnswers: true }): Promise<void> {
  await writeFakeExecutable(path.join(fixture.fakeBin, 'curl'), [
    'output=/dev/null; header=; url=',
    'while [ $# -gt 0 ]; do',
    '    case "$1" in',
    '        -o) output=$2; shift ;;',
    '        -H) header=$2; shift ;;',
    '        -*) ;;',
    '        *) url=$1 ;;',
    '    esac',
    '    shift',
    'done',
    `printf '%s\\n' "$url" >> "${fixture.curlLog}"`,
    'case "$url" in',
    '    */api/v1/user)',
    `        token=$(sed -n 's/^Authorization: token //p' "\${header#@}")`,
    `        grep -qxF "$token" "${fixture.acceptedTokensFile}" 2>/dev/null || exit 22 ;;`,
    '    https://gitea.com/gitea/tea/releases/download/*)',
    `        cp "${fixture.teaReleaseDirectory}/\${url##*/}" "$output" || exit 22 ;;`,
    ...(forgejoAnswers ? [] : [`    http://${TAILNET_IP}:8420/) exit 7 ;;`]),
    'esac',
    'exit 0',
  ]);
}

function fakeTeaScript(fixture: Fixture, reportedVersion: string): string {
  return [
    '#!/usr/bin/env bash',
    `if [ "$1" = --version ]; then printf 'Version: \\033[1m${reportedVersion}\\033[0m\\tgolang: 1.26.6\\tgo-sdk: v1.2.0\\n'; exit 0; fi`,
    `if [ "$1" = logins ] && [ "$2" = list ]; then cat "${fixture.teaLoginsFile}" 2>/dev/null; exit 0; fi`,
    'if [ "$1" = login ] && [ "$2" = add ]; then',
    `    printf '%s token=%s\\n' "$*" "$GITEA_SERVER_TOKEN" >> "${fixture.teaLog}"`,
    `    printf '%s %s\\n' "$4" "$6" >> "${fixture.teaLoginsFile}"`,
    '    exit 0',
    'fi',
    'exit 1',
    '',
  ].join('\n');
}

async function writeFakeUname(fixture: Fixture, system: 'Linux' | 'Darwin'): Promise<void> {
  await writeFakeExecutable(path.join(fixture.fakeBin, 'uname'), [`if [ "$1" = -m ]; then echo x86_64; else echo ${system}; fi`]);
}

function sha256Of(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function publishTeaRelease(fixture: Fixture, { pinnedContent, servedContent }: { pinnedContent: string; servedContent: string }): Promise<void> {
  await mkdir(fixture.teaReleaseDirectory, { recursive: true });
  await writeFile(path.join(fixture.teaReleaseDirectory, TEA_ARTIFACT), servedContent);
  await writeFile(
    path.join(fixture.throneRoot, 'vendor-pins.json'),
    JSON.stringify({
      tools: {
        forgejo: { image: 'codeberg.org/forgejo/forgejo:16.0.5-rootless' },
        tea: { version: TEA_VERSION, artifacts: { 'linux-amd64': { sha256: sha256Of(pinnedContent) } } },
      },
    }),
  );
}

async function writeFakeTailscale(fixture: Fixture, { serveSucceeds }: { serveSucceeds: boolean }): Promise<void> {
  await writeFakeExecutable(path.join(fixture.fakeBin, 'tailscale'), [
    `printf '%s\\n' "$*" >> "${fixture.tailscaleLog}"`,
    `if [ "$1" = ip ]; then echo ${TAILNET_IP}; exit 0; fi`,
    `if [ "$1" = status ]; then echo '{"Self":{"DNSName":"${MAGICDNS_NAME}."}}'; exit 0; fi`,
    `if [ "$1" = serve ] && [ "$2" = status ]; then cat "${fixture.serveStatusFile}" 2>/dev/null || echo '{}'; exit 0; fi`,
    serveSucceeds
      ? `if [ "$1" = serve ]; then printf '%s' '${HTTPS_FRONT_STATUS}' > "${fixture.serveStatusFile}"; exit 0; fi`
      : 'if [ "$1" = serve ]; then echo "serve is not enabled on this tailnet" >&2; exit 1; fi',
    'exit 0',
  ]);
}

async function buildFixture(): Promise<Fixture> {
  const throneRoot = await mkdtemp(path.join(tmpdir(), 'install-forgejo-'));
  scratch.push(throneRoot);
  const fakeBin = path.join(throneRoot, 'fake-bin');
  const fixture: Fixture = {
    throneRoot,
    fakeBin,
    stateDirectory: path.join(throneRoot, 'state', 'forgejo'),
    runtimeLog: path.join(throneRoot, 'runtime.log'),
    tailscaleLog: path.join(throneRoot, 'tailscale.log'),
    installServicesLog: path.join(throneRoot, 'install-services.log'),
    serveStatusFile: path.join(throneRoot, 'serve-status.json'),
    forgejoUsersFile: path.join(throneRoot, 'forgejo-users.txt'),
    acceptedTokensFile: path.join(throneRoot, 'accepted-tokens.txt'),
    curlLog: path.join(throneRoot, 'curl.log'),
    teaReleaseDirectory: path.join(throneRoot, 'tea-release'),
    teaLog: path.join(throneRoot, 'tea.log'),
    teaLoginsFile: path.join(throneRoot, 'tea-logins.txt'),
    teaBinary: path.join(throneRoot, '.local', 'bin', 'tea'),
  };
  for (const dir of [fakeBin, 'scripts', 'bin', path.join('dist', 'src')]) {
    await mkdir(path.resolve(throneRoot, dir), { recursive: true });
  }
  await writeFile(
    path.join(throneRoot, 'scripts', 'require-agent.sh'),
    await readFile(path.join(REPO_ROOT, 'scripts', 'require-agent.sh'), 'utf8'),
  );
  const teaArtifact = fakeTeaScript(fixture, TEA_VERSION);
  await publishTeaRelease(fixture, { pinnedContent: teaArtifact, servedContent: teaArtifact });
  await writeFile(
    path.join(throneRoot, 'dist', 'src', 'tools.js'),
    `require('node:fs').appendFileSync(${JSON.stringify(fixture.installServicesLog)}, process.argv.slice(2).join(' ') + '\\n');\n`,
  );
  await writeFakeExecutable(path.join(throneRoot, 'bin', 'throne-cli'), [
    `if [ "$1" = git-identity ]; then printf '%s\\t%s\\t%s\\t%s\\n' '${IDENTITY_NAME}' '${IDENTITY_EMAIL}' ABCDEF openpgp; exit 0; fi`,
    'exit 2',
  ]);
  await provisionPinnedNode(throneRoot, throneRoot);
  await writeFakeCurl(fixture);
  await writeFakeUname(fixture, 'Linux');
  await writeFakeExecutable(path.join(fakeBin, 'systemctl'), [
    `printf '%s\\n' "$*" >> "${path.join(throneRoot, 'systemctl.log')}"`,
    'if [ "$2" = is-active ]; then exit 3; fi',
    'exit 0',
  ]);
  await writeFakeContainerCli(fixture, { reachable: true });
  await writeFakeTailscale(fixture, { serveSucceeds: true });
  for (const name of REQUIRED_COREUTILS) {
    await symlink(await resolveRealTool(name), path.join(fakeBin, name));
  }
  return fixture;
}

async function runInstaller(fixture: Fixture): Promise<RunResult> {
  const scriptPath = path.join(fixture.throneRoot, 'install-forgejo.sh');
  await writeFile(scriptPath, await readFile(path.join(REPO_ROOT, 'install-forgejo.sh'), 'utf8'), { mode: 0o755 });
  try {
    const { stdout, stderr } = await execFileAsync(await resolveRealTool('bash'), [scriptPath], {
      cwd: fixture.throneRoot,
      env: {
        PATH: fixture.fakeBin,
        I_AM_AN_AGENT: '1',
        HOME: fixture.throneRoot,
        XDG_STATE_HOME: path.join(fixture.throneRoot, 'state'),
        XDG_CACHE_HOME: path.join(fixture.throneRoot, 'cache'),
        THRONE_FORGEJO_READY_ATTEMPTS: '1',
      },
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', code: failure.code ?? 1 };
  }
}

async function readIfPresent(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function snapshotDirectory(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const filePath = path.join(entry.parentPath, entry.name);
    const { mode, mtimeMs } = await stat(filePath);
    snapshot.set(path.relative(root, filePath), `${mode} ${mtimeMs} ${await readFile(filePath, 'utf8')}`);
  }
  return snapshot;
}

function appIniSection(appIni: string, section: string): string {
  const start = appIni.indexOf(`[${section}]\n`);
  assert.notEqual(start, -1, `app.ini has no [${section}] section`);
  const rest = appIni.slice(start + section.length + 3);
  const end = rest.indexOf('\n[');
  return end === -1 ? rest : rest.slice(0, end);
}

test('The Forgejo installer refuses clearly when no container runtime is reachable or tailscale is missing, and never installs Tailscale.', async () => {
  const withoutRuntime = await buildFixture();
  await rm(path.join(withoutRuntime.fakeBin, 'podman'));
  const noRuntime = await runInstaller(withoutRuntime);
  assert.notEqual(noRuntime.code, 0);
  assert.match(noRuntime.stderr, /no container runtime found/);

  const withUnreachableRuntime = await buildFixture();
  await writeFakeContainerCli(withUnreachableRuntime, { reachable: false });
  const unreachable = await runInstaller(withUnreachableRuntime);
  assert.notEqual(unreachable.code, 0);
  assert.match(unreachable.stderr, /podman is installed but not reachable/);
  assert.doesNotMatch(await readFile(withUnreachableRuntime.runtimeLog, 'utf8'), /^pull /m);

  const withoutTailscale = await buildFixture();
  await rm(path.join(withoutTailscale.fakeBin, 'tailscale'));
  const noTailscale = await runInstaller(withoutTailscale);
  assert.notEqual(noTailscale.code, 0);
  assert.match(noTailscale.stderr, /tailscale is not installed.*https:\/\/tailscale\.com\/download/s);
  assert.doesNotMatch(await readIfPresent(withoutTailscale.runtimeLog), /^pull /m);
  await assert.rejects(stat(withoutTailscale.stateDirectory));
});

test('A first run writes app.ini once with SQLite, the tailnet MagicDNS ROOT_URL, registration off, the attachment types and 500 MB limit, and actions, packages, wiki and issues off by default.', async () => {
  const fixture = await buildFixture();
  const result = await runInstaller(fixture);
  assert.equal(result.code, 0, result.stderr);

  const appIniPath = path.join(fixture.stateDirectory, 'config', 'app.ini');
  const appIni = await readFile(appIniPath, 'utf8');
  assert.equal((await stat(appIniPath)).mode & 0o777, 0o600);
  assert.match(appIni, /^WORK_PATH = \/var\/lib\/gitea$/m);
  assert.match(appIniSection(appIni, 'database'), /^DB_TYPE = sqlite3$/m);
  const server = appIniSection(appIni, 'server');
  assert.match(server, new RegExp(`^DOMAIN = ${MAGICDNS_NAME}$`, 'm'));
  assert.match(server, new RegExp(`^ROOT_URL = https://${MAGICDNS_NAME}:8443/$`, 'm'));
  assert.match(server, /^HTTP_PORT = 3000$/m);
  assert.match(server, /^DISABLE_SSH = true$/m);
  const security = appIniSection(appIni, 'security');
  assert.match(security, /^INSTALL_LOCK = true$/m);
  assert.match(security, /^SECRET_KEY = [A-Za-z0-9_-]{43}$/m);
  assert.match(security, /^INTERNAL_TOKEN = [A-Za-z0-9_-]{43}$/m);
  assert.match(appIniSection(appIni, 'oauth2'), /^JWT_SECRET = [A-Za-z0-9_-]{43}$/m);
  assert.match(appIniSection(appIni, 'service'), /^DISABLE_REGISTRATION = true$/m);
  assert.match(appIniSection(appIni, 'repository'), /^DEFAULT_REPO_UNITS = repo\.code,repo\.releases,repo\.pulls$/m);
  const attachment = appIniSection(appIni, 'attachment');
  assert.match(attachment, /^ENABLED = true$/m);
  const allowedTypes = /^ALLOWED_TYPES = (.*)$/m.exec(attachment)?.[1]?.split(',') ?? [];
  for (const extension of ['.png', '.jpg', '.gif', '.svg', '.webp', '.mp4', '.webm', '.mov']) {
    assert.ok(allowedTypes.includes(extension), `ALLOWED_TYPES lacks ${extension}`);
  }
  assert.match(attachment, /^MAX_SIZE = 500$/m);
  assert.match(appIniSection(appIni, 'actions'), /^ENABLED = false$/m);
  assert.match(appIniSection(appIni, 'packages'), /^ENABLED = false$/m);
  assert.doesNotMatch(appIni, /RUN_USER/);

  assert.ok((await stat(path.join(fixture.stateDirectory, 'enabled'))).isFile());
  assert.match(await readFile(fixture.runtimeLog, 'utf8'), /^pull codeberg\.org\/forgejo\/forgejo:16\.0\.5-rootless$/m);
});

test('The admin user is created from the configured identity with a one-time printed password stored mode 0600 next to the data.', async () => {
  const fixture = await buildFixture();
  const result = await runInstaller(fixture);
  assert.equal(result.code, 0, result.stderr);

  const passwordFile = path.join(fixture.stateDirectory, 'admin-password');
  assert.equal((await stat(passwordFile)).mode & 0o777, 0o600);
  const password = (await readFile(passwordFile, 'utf8')).trim();
  assert.ok(password.length >= 32);
  assert.equal(result.stdout.split(password).length - 1, 1);

  const creates = (await readFile(fixture.runtimeLog, 'utf8')).split('\n').filter((line) => / admin user create /.test(line));
  assert.equal(creates.length, 1);
  assert.equal(
    creates[0],
    `exec throne-forgejo forgejo admin user create --admin --username ${EXPECTED_ADMIN_LOGIN} --fullname ${IDENTITY_NAME} --email ${IDENTITY_EMAIL} --password ${password} --must-change-password=false`,
  );
  assert.match(result.stdout, new RegExp(`Admin login: +${EXPECTED_ADMIN_LOGIN}`));
});

test('Re-running the installer changes nothing and never overwrites app.ini or data.', async () => {
  const fixture = await buildFixture();
  const firstRun = await runInstaller(fixture);
  assert.equal(firstRun.code, 0, firstRun.stderr);
  const password = (await readFile(path.join(fixture.stateDirectory, 'admin-password'), 'utf8')).trim();
  await writeFile(path.join(fixture.stateDirectory, 'data', 'forgejo.db'), 'repositories and pull requests');
  const before = await snapshotDirectory(fixture.stateDirectory);

  const secondRun = await runInstaller(fixture);
  assert.equal(secondRun.code, 0, secondRun.stderr);

  assert.deepEqual(await snapshotDirectory(fixture.stateDirectory), before);
  assert.doesNotMatch(secondRun.stdout, new RegExp(password));
  assert.match(secondRun.stdout, /kept existing .*app\.ini/);
  assert.match(secondRun.stdout, new RegExp(`admin ${EXPECTED_ADMIN_LOGIN} already exists`));
  const runtimeCalls = (await readFile(fixture.runtimeLog, 'utf8')).split('\n');
  assert.equal(runtimeCalls.filter((line) => / admin user create /.test(line)).length, 1);
  assert.equal(runtimeCalls.filter((line) => line.startsWith('pull ')).length, 1);
  assert.equal((await readServeConfigurations(fixture)).length, 1);
});

async function readServeConfigurations(fixture: Fixture): Promise<string[]> {
  return (await readFile(fixture.tailscaleLog, 'utf8')).split('\n').filter((line) => line.startsWith('serve --bg'));
}

async function installAndReadServeConfigurations(fixture: Fixture): Promise<{ run: RunResult; serveConfigurations: string[] }> {
  const run = await runInstaller(fixture);
  assert.equal(run.code, 0, run.stderr);
  return { run, serveConfigurations: await readServeConfigurations(fixture) };
}

test('The installer points the https front at Forgejo on loopback, because tailscaled on macOS cannot reach its own tailnet address', async () => {
  const { serveConfigurations } = await installAndReadServeConfigurations(await buildFixture());

  assert.deepEqual(serveConfigurations, [LOOPBACK_FRONT_CONFIGURATION]);
});

test('The installer replaces an https front that still proxies to the old tailnet target', async () => {
  const fixture = await buildFixture();
  await writeFile(fixture.serveStatusFile, httpsFrontStatusProxyingTo(TAILNET_FRONT_TARGET));

  const { run, serveConfigurations } = await installAndReadServeConfigurations(fixture);

  assert.deepEqual(serveConfigurations, [LOOPBACK_FRONT_CONFIGURATION]);
  assert.match(run.stdout, new RegExp(`tailscale serve proxies https port 8443 to ${LOOPBACK_FRONT_TARGET}`));
});

test('The installer registers the unit only through install-services and prints the URL (https when the tailscale serve front is configured).', async () => {
  const fronted = await buildFixture();
  const frontedRun = await runInstaller(fronted);
  assert.equal(frontedRun.code, 0, frontedRun.stderr);
  assert.match(frontedRun.stdout, new RegExp(`https://${MAGICDNS_NAME}:8443/`));
  assert.match(frontedRun.stdout, new RegExp(`http://${TAILNET_IP}:8420/`));
  assert.equal(await readFile(fronted.installServicesLog, 'utf8'), 'install-services\n');
  assert.match(await readFile(path.join(fronted.throneRoot, 'systemctl.log'), 'utf8'), /^--user start forgejo\.service$/m);
  await assert.rejects(stat(path.join(fronted.throneRoot, '.config', 'systemd')));

  const unfronted = await buildFixture();
  await writeFakeTailscale(unfronted, { serveSucceeds: false });
  const unfrontedRun = await runInstaller(unfronted);
  assert.equal(unfrontedRun.code, 0, unfrontedRun.stderr);
  assert.doesNotMatch(unfrontedRun.stdout, /https:\/\//);
  assert.match(unfrontedRun.stdout, /tailscale serve could not front Forgejo with HTTPS/);
  const appIni = await readFile(path.join(unfronted.stateDirectory, 'config', 'app.ini'), 'utf8');
  assert.match(appIni, new RegExp(`^ROOT_URL = http://${MAGICDNS_NAME}:8420/$`, 'm'));
});

function linesOf(text: string): string[] {
  return text.split('\n').filter((line) => line !== '');
}

test('installing Forgejo stores an API token readable only by the user', async () => {
  const fixture = await buildFixture();
  const result = await runInstaller(fixture);
  assert.equal(result.code, 0, result.stderr);

  const tokenFile = path.join(fixture.stateDirectory, 'api-token');
  assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
  assert.equal((await readFile(tokenFile, 'utf8')).trim(), GENERATED_API_TOKEN);
  const tokenRequests = linesOf(await readFile(fixture.runtimeLog, 'utf8')).filter((line) => / generate-access-token /.test(line));
  assert.deepEqual(tokenRequests, [
    `exec throne-forgejo forgejo admin user generate-access-token --username ${EXPECTED_ADMIN_LOGIN} --token-name throne-forge --scopes all --raw`,
  ]);
  assert.ok(linesOf(await readFile(fixture.curlLog, 'utf8')).includes(`http://${TAILNET_IP}:8420/api/v1/user`));
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(GENERATED_API_TOKEN));
});

test('re-running the installer keeps the existing token', async () => {
  const fixture = await buildFixture();
  const firstRun = await runInstaller(fixture);
  assert.equal(firstRun.code, 0, firstRun.stderr);
  const tokenFile = path.join(fixture.stateDirectory, 'api-token');
  const before = await stat(tokenFile);

  const secondRun = await runInstaller(fixture);
  assert.equal(secondRun.code, 0, secondRun.stderr);

  const after = await stat(tokenFile);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal((await readFile(tokenFile, 'utf8')).trim(), GENERATED_API_TOKEN);
  assert.equal(linesOf(await readFile(fixture.runtimeLog, 'utf8')).filter((line) => / generate-access-token /.test(line)).length, 1);
  assert.equal(linesOf(await readFile(fixture.curlLog, 'utf8')).filter((url) => url.endsWith('/api/v1/user')).length, 2);
  assert.match(secondRun.stdout, /kept existing .*api-token/);
});

test('a token Forgejo no longer accepts is reported loudly and left in place', async () => {
  const fixture = await buildFixture();
  const firstRun = await runInstaller(fixture);
  assert.equal(firstRun.code, 0, firstRun.stderr);
  await writeFile(fixture.acceptedTokensFile, '');

  const secondRun = await runInstaller(fixture);

  assert.notEqual(secondRun.code, 0);
  assert.match(secondRun.stderr, /Forgejo does not accept the token in .*api-token/);
  assert.equal((await readFile(path.join(fixture.stateDirectory, 'api-token'), 'utf8')).trim(), GENERATED_API_TOKEN);
  assert.equal(linesOf(await readFile(fixture.runtimeLog, 'utf8')).filter((line) => / generate-access-token /.test(line)).length, 1);
  assert.doesNotMatch(secondRun.stdout + secondRun.stderr, new RegExp(GENERATED_API_TOKEN));
});

test('the installer installs the pinned tea only after its checksum matches', async () => {
  const fixture = await buildFixture();
  const result = await runInstaller(fixture);
  assert.equal(result.code, 0, result.stderr);

  const published = await readFile(path.join(fixture.teaReleaseDirectory, TEA_ARTIFACT), 'utf8');
  assert.equal(await readFile(fixture.teaBinary, 'utf8'), published);
  assert.equal((await stat(fixture.teaBinary)).mode & 0o777, 0o755);
  assert.deepEqual(linesOf(await readFile(fixture.curlLog, 'utf8')).filter((url) => url.includes('/releases/download/')), [TEA_DOWNLOAD_URL]);
  assert.match(result.stdout, new RegExp(`installed tea ${TEA_VERSION} at ${fixture.teaBinary}`));

  await rm(fixture.teaBinary);
  await rm(fixture.teaReleaseDirectory, { recursive: true });
  const fromCache = await runInstaller(fixture);
  assert.equal(fromCache.code, 0, fromCache.stderr);
  assert.equal(await readFile(fixture.teaBinary, 'utf8'), published);
  assert.equal(linesOf(await readFile(fixture.curlLog, 'utf8')).filter((url) => url.includes('/releases/download/')).length, 1);
  assert.match(fromCache.stdout, /reusing the verified download/);
});

test('a tea download with the wrong checksum is refused', async () => {
  const fixture = await buildFixture();
  const pinned = fakeTeaScript(fixture, TEA_VERSION);
  await publishTeaRelease(fixture, { pinnedContent: pinned, servedContent: `${pinned}echo tampered\n` });

  const result = await runInstaller(fixture);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, new RegExp(`the downloaded ${TEA_ARTIFACT} has sha256 [0-9a-f]{64}, but vendor-pins\\.json pins ${sha256Of(pinned)}; refusing to install it`));
  await assert.rejects(stat(fixture.teaBinary));
  await assert.rejects(stat(path.join(fixture.throneRoot, 'cache', 'throne', 'tea', TEA_VERSION, TEA_ARTIFACT)));
  await assert.rejects(stat(path.join(fixture.throneRoot, 'cache', 'throne', 'tea', TEA_VERSION, `${TEA_ARTIFACT}.partial`)));
  assert.equal(await readIfPresent(fixture.teaLog), '');
});

test('re-running the installer adds no second tea login', async () => {
  const fixture = await buildFixture();
  const firstRun = await runInstaller(fixture);
  assert.equal(firstRun.code, 0, firstRun.stderr);
  const secondRun = await runInstaller(fixture);
  assert.equal(secondRun.code, 0, secondRun.stderr);

  assert.deepEqual(linesOf(await readFile(fixture.teaLog, 'utf8')), [
    `login add --name forgejo --url https://${MAGICDNS_NAME}:8443/ token=${GENERATED_API_TOKEN}`,
  ]);
  assert.deepEqual(linesOf(await readFile(fixture.teaLoginsFile, 'utf8')), [`forgejo https://${MAGICDNS_NAME}:8443/`]);
  assert.match(secondRun.stdout, /tea login forgejo already exists/);
  assert.match(secondRun.stdout, new RegExp(`tea ${TEA_VERSION} already installed`));
  assert.equal(linesOf(await readFile(fixture.curlLog, 'utf8')).filter((url) => url.includes('/releases/download/')).length, 1);
});

test('on a Mac, a Forgejo that never answers makes the installer name its launchd job and log file, not systemctl', async () => {
  const fixture = await buildFixture();
  await writeFakeUname(fixture, 'Darwin');
  await writeFakeCurl(fixture, { forgejoAnswers: false });

  const result = await runInstaller(fixture);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Forgejo did not answer/);
  assert.ok(result.stderr.includes(`launchctl print gui/${process.getuid?.()}/com.throne.forgejo`), result.stderr);
  assert.ok(result.stderr.includes(path.join(fixture.throneRoot, 'Library', 'Logs', 'throne', 'forgejo.log')), result.stderr);
  assert.doesNotMatch(result.stderr, /systemctl/);
});

test('on Linux, a Forgejo that never answers makes the installer name systemctl --user status forgejo.service', async () => {
  const fixture = await buildFixture();
  await writeFakeCurl(fixture, { forgejoAnswers: false });

  const result = await runInstaller(fixture);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Forgejo did not answer .*inspect: systemctl --user status forgejo\.service/);
  assert.doesNotMatch(result.stderr, /launchctl/);
});

test('the installer pulls through the docker CLI and names the engine behind it, not the CLI', async () => {
  const fixture = await buildFixture();
  await rm(path.join(fixture.fakeBin, 'podman'));
  await writeFakeContainerCli(fixture, { reachable: true, cli: 'docker', versionReport: DOCKER_CLI_ON_PODMAN_VERSION_REPORT });

  const result = await runInstaller(fixture);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /container engine: Podman Engine \(through docker\)/);
  assert.match(result.stdout, /pulled codeberg\.org\/forgejo\/forgejo:16\.0\.5-rootless into Podman Engine/);
  assert.doesNotMatch(result.stdout, /with docker/);
  assert.match(await readFile(fixture.runtimeLog, 'utf8'), /^exec throne-forgejo forgejo admin user create /m);
});
