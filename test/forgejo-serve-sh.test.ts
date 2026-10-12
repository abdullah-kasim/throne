import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, test } from 'node:test';

import { renderUnitSource, SYSTEMD_SOURCE_DIR, SYSTEMD_UNIT_NAMES } from '../src/install-services/service-unit-renderer.service.ts';
import { findOnPath, linkRealCommands, writeFakeExecutable } from './support/fake-command-host.support.ts';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const REAL_COMMANDS = ['chmod', 'date', 'dirname', 'flock', 'grep', 'head', 'id', 'mkdir', 'perl', 'sleep'];
const SERVE_SCRIPTS = ['forgejo-serve', 'container-runtime-ensure'];
const TAILNET_IP = '192.0.2.10';
const LOOPBACK_PUBLISH = '127.0.0.1:8421:3000';
const PINNED_FORGEJO_IMAGE = 'codeberg.org/forgejo/forgejo:0.0.0-rootless';
const PINNED_NTFY_IMAGE = 'docker.io/binwiederhier/ntfy:v0.0.0';
const PODMAN_CLI_VERSION_REPORT = 'Client:       Podman Engine\nVersion:      6.1.1\n\nServer:       Podman Engine\nVersion:      6.1.1';
const DOCKER_CLI_ON_PODMAN_VERSION_REPORT =
  'Client: Docker Engine - Community\n Version:           29.8.0\n\nServer: linux/arm64/fedora-44\n Podman Engine:\n  Version:          6.1.1\n Engine:\n  Version:          6.1.1';
const DOCKER_CLI_ON_DOCKER_ENGINE_VERSION_REPORT =
  'Client: Docker Engine - Community\n Version:           29.8.0\n\nServer: Docker Engine - Community\n Engine:\n  Version:          29.0.0';
const UNKNOWN_ENGINE_VERSION_REPORT = 'Client:\n Version:           29.8.0\n\nServer: Example Runtime 1.0\n Example Daemon:\n  Version:          1.0';
const KEEP_ID_MAPPING = '--userns=keep-id:uid=1000,gid=1000';
const INVOKING_USER_MAPPING = `--user=${process.getuid?.()}:${process.getgid?.()}`;

const scratch: string[] = [];
after(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

type Platform = 'Linux' | 'Darwin';
type Runtime = 'docker' | 'podman';
type Reachability = 'reachable' | 'down';

interface Host {
  throneRoot: string;
  fakeBin: string;
  stateHome: string;
  tailscaleAppCli: string;
}

interface ServeResult {
  code: number;
  stderr: string;
}

function forgejoStateDirectory(host: Host): string {
  return path.join(host.stateHome, 'forgejo');
}

function runtimeRunLog(host: Host, runtime: Runtime): string {
  return path.join(host.throneRoot, `${runtime}-run.log`);
}

async function buildHost(): Promise<Host> {
  const throneRoot = await mkdtemp(path.join(tmpdir(), 'forgejo-serve-'));
  scratch.push(throneRoot);
  const fakeBin = path.join(throneRoot, 'fake-bin');
  const stateHome = path.join(throneRoot, 'state');
  const tailscaleAppCli = path.join(throneRoot, 'Tailscale.app', 'Contents', 'MacOS', 'Tailscale');
  await mkdir(fakeBin, { recursive: true });
  await mkdir(path.join(throneRoot, 'systemd'), { recursive: true });
  await mkdir(path.dirname(tailscaleAppCli), { recursive: true });
  for (const script of SERVE_SCRIPTS) {
    await writeFile(
      path.join(throneRoot, 'systemd', script),
      await readFile(path.join(REPO_ROOT, 'systemd', script), 'utf8'),
      { mode: 0o755 },
    );
  }
  await writeFile(
    path.join(throneRoot, 'vendor-pins.json'),
    JSON.stringify(
      { tools: { ntfy: { image: PINNED_NTFY_IMAGE }, forgejo: { image: PINNED_FORGEJO_IMAGE } } },
      null,
      2,
    ),
  );
  await linkRealCommands(fakeBin, REAL_COMMANDS);
  const host = { throneRoot, fakeBin, stateHome, tailscaleAppCli };
  await installRuntime(host, 'podman', PODMAN_CLI_VERSION_REPORT);
  await installPlatform(host, 'Linux');
  await writeFakeExecutable(path.join(fakeBin, 'tailscale'), `echo ${TAILNET_IP}`);
  return host;
}

async function installRuntime(
  host: Host,
  runtime: Runtime,
  versionReport: string,
  reachability: Reachability = 'reachable',
): Promise<void> {
  await writeFakeExecutable(
    path.join(host.fakeBin, runtime),
    [
      `if [ "$1" = info ] && [ ${reachability} = down ]; then exit 1; fi`,
      `if [ "$1" = version ]; then printf '%s\\n' '${versionReport}'; fi`,
      `if [ "$1" = run ]; then printf '%s\\n' "$@" > "${runtimeRunLog(host, runtime)}"; fi`,
      'exit 0',
    ].join('\n'),
  );
}

async function installPlatform(host: Host, platform: Platform): Promise<void> {
  await writeFakeExecutable(path.join(host.fakeBin, 'uname'), `echo ${platform}`);
  if (platform === 'Darwin') {
    await rm(path.join(host.fakeBin, 'ip'), { force: true });
    await writeFakeExecutable(
      path.join(host.fakeBin, 'ifconfig'),
      `echo "utun4: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1280"\necho "\tinet ${TAILNET_IP} --> ${TAILNET_IP} netmask 0xffffffff"`,
    );
  } else {
    await writeFakeExecutable(
      path.join(host.fakeBin, 'ip'),
      `echo "5: tailscale0    inet ${TAILNET_IP}/32 scope global tailscale0"`,
    );
  }
}

async function configureForge(host: Host): Promise<void> {
  const configDirectory = path.join(forgejoStateDirectory(host), 'config');
  await mkdir(configDirectory, { recursive: true });
  await writeFile(path.join(configDirectory, 'app.ini'), '[security]\nINSTALL_LOCK = true\n');
}

async function runForgejoServe(host: Host, extraEnv: NodeJS.ProcessEnv = {}): Promise<ServeResult> {
  try {
    const { stderr } = await execFileAsync(
      await findOnPath('sh'),
      [path.join(host.throneRoot, 'systemd', 'forgejo-serve')],
      {
        env: {
          PATH: host.fakeBin,
          HOME: host.throneRoot,
          XDG_STATE_HOME: host.stateHome,
          FORGEJO_TAILSCALE_APP_CLI: host.tailscaleAppCli,
          FORGEJO_TAILNET_WAIT_SECONDS: '0',
          FORGEJO_NODE_BIN: process.execPath,
          ...extraEnv,
        },
      },
    );
    return { code: 0, stderr };
  } catch (error) {
    const failure = error as { stderr?: string; code?: number };
    return { code: failure.code ?? 1, stderr: failure.stderr ?? '' };
  }
}

async function containerRunArguments(host: Host, runtime: Runtime): Promise<string[]> {
  return (await readFile(runtimeRunLog(host, runtime), 'utf8')).trimEnd().split('\n');
}

async function runtimeWasStarted(host: Host, runtime: Runtime): Promise<boolean> {
  try {
    await access(runtimeRunLog(host, runtime));
    return true;
  } catch {
    return false;
  }
}

function valuesOfOption(argumentsList: string[], option: string): string[] {
  return argumentsList.flatMap((argument, index) => (argument === option ? [argumentsList[index + 1]] : []));
}

test('forgejo-serve on a Mac finds the tailnet address through ifconfig and the Tailscale.app CLI', async () => {
  const host = await buildHost();
  await configureForge(host);
  await installPlatform(host, 'Darwin');
  await rm(path.join(host.fakeBin, 'tailscale'));
  await writeFakeExecutable(host.tailscaleAppCli, `echo ${TAILNET_IP}`);

  const result = await runForgejoServe(host);

  assert.equal(result.code, 0, result.stderr);
  const argumentsList = await containerRunArguments(host, 'podman');
  assert.deepEqual(valuesOfOption(argumentsList, '-p'), [`${TAILNET_IP}:8420:3000`, LOOPBACK_PUBLISH]);
});

test('forgejo-serve publishes Forgejo on the tailnet address and loopback only, never on 0.0.0.0', async () => {
  const host = await buildHost();
  await configureForge(host);

  const result = await runForgejoServe(host);

  assert.equal(result.code, 0, result.stderr);
  const argumentsList = await containerRunArguments(host, 'podman');
  assert.deepEqual(valuesOfOption(argumentsList, '-p'), [`${TAILNET_IP}:8420:3000`, LOOPBACK_PUBLISH]);
  assert.equal(argumentsList.some((argument) => argument.includes('0.0.0.0')), false);
  assert.equal(
    argumentsList.some((argument) => /^(-P|--publish|--publish-all|--network|--net)(=|$)/.test(argument)),
    false,
  );
});

test('forgejo-serve serves the Forgejo image pinned in vendor-pins.json under the runtime THRONE_CONTAINER_RUNTIME names', async () => {
  const host = await buildHost();
  await configureForge(host);
  await installRuntime(host, 'docker', DOCKER_CLI_ON_DOCKER_ENGINE_VERSION_REPORT);

  const result = await runForgejoServe(host, { THRONE_CONTAINER_RUNTIME: 'podman' });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(await runtimeWasStarted(host, 'docker'), false);
  const argumentsList = await containerRunArguments(host, 'podman');
  assert.equal(argumentsList.at(-1), PINNED_FORGEJO_IMAGE);
  assert.equal(valuesOfOption(argumentsList, '--name')[0], 'throne-forgejo');
});

test('forgejo starts under the runtime that can actually run when another is installed but down', async () => {
  const host = await buildHost();
  await configureForge(host);
  await installRuntime(host, 'docker', DOCKER_CLI_ON_DOCKER_ENGINE_VERSION_REPORT, 'down');

  const result = await runForgejoServe(host);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(await runtimeWasStarted(host, 'docker'), false);
  assert.equal(await runtimeWasStarted(host, 'podman'), true);
});

test('forgejo does not start its container when no container runtime can be reached', async () => {
  const host = await buildHost();
  await configureForge(host);
  await installRuntime(host, 'podman', PODMAN_CLI_VERSION_REPORT, 'down');

  const result = await runForgejoServe(host, { THRONE_CONTAINER_RUNTIME_WAIT_SECONDS: '0' });

  assert.notEqual(result.code, 0);
  assert.equal(result.stderr, 'container-runtime-ensure: podman did not become reachable within 0 seconds\n');
  assert.equal(await runtimeWasStarted(host, 'podman'), false);
});

test('forgejo-serve refuses to start a forge the installer has not configured', async () => {
  const host = await buildHost();

  const result = await runForgejoServe(host);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /app\.ini does not exist/);
  assert.equal(await runtimeWasStarted(host, 'podman'), false);
});

test('forgejo-serve refuses instead of running the node on PATH when no pinned node is given', async () => {
  const host = await buildHost();
  await configureForge(host);
  const decoyNodeRanMarker = path.join(host.throneRoot, 'decoy-node-ran');
  await writeFakeExecutable(path.join(host.fakeBin, 'node'), `touch "${decoyNodeRanMarker}"`);

  const result = await runForgejoServe(host, { FORGEJO_NODE_BIN: undefined });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /FORGEJO_NODE_BIN is not set/);
  await assert.rejects(access(decoyNodeRanMarker));
  assert.equal(await runtimeWasStarted(host, 'podman'), false);
});

test('forgejo-serve exits non-zero when no tailnet address appears', async () => {
  const host = await buildHost();
  await configureForge(host);
  await writeFakeExecutable(path.join(host.fakeBin, 'tailscale'), 'exit 1');

  const result = await runForgejoServe(host);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /no Tailscale IPv4 address after 0 seconds/);
  assert.equal(await runtimeWasStarted(host, 'podman'), false);
});

test("forgejo-serve keeps Forgejo's data and config in its state directory and runs the container as the user who runs it", async () => {
  const podmanHost = await buildHost();
  await configureForge(podmanHost);
  const dockerHost = await buildHost();
  await configureForge(dockerHost);
  await rm(path.join(dockerHost.fakeBin, 'podman'));
  await installRuntime(dockerHost, 'docker', DOCKER_CLI_ON_DOCKER_ENGINE_VERSION_REPORT);

  assert.equal((await runForgejoServe(podmanHost)).code, 0);
  assert.equal((await runForgejoServe(dockerHost)).code, 0);

  const stateDirectory = forgejoStateDirectory(podmanHost);
  const podmanArguments = await containerRunArguments(podmanHost, 'podman');
  assert.deepEqual(valuesOfOption(podmanArguments, '-v'), [
    `${path.join(stateDirectory, 'data')}:/var/lib/gitea`,
    `${path.join(stateDirectory, 'config')}:/etc/gitea`,
  ]);
  assert.ok(podmanArguments.includes('GITEA_APP_INI=/etc/gitea/app.ini'));
  assert.ok((await stat(path.join(stateDirectory, 'data'))).isDirectory());
  assert.ok(podmanArguments.includes(KEEP_ID_MAPPING));
  const dockerArguments = await containerRunArguments(dockerHost, 'docker');
  assert.ok(dockerArguments.includes(INVOKING_USER_MAPPING));
});

async function serveThroughDocker(versionReport: string): Promise<{ result: ServeResult; argumentsList: string[] }> {
  const host = await buildHost();
  await configureForge(host);
  await rm(path.join(host.fakeBin, 'podman'));
  await installRuntime(host, 'docker', versionReport);
  const result = await runForgejoServe(host);
  assert.equal(result.code, 0, result.stderr);
  return { result, argumentsList: await containerRunArguments(host, 'docker') };
}

const KNOWN_ENGINES_BEHIND_THE_DOCKER_CLI = [
  {
    name: 'forgejo-serve runs the container as the invoking user when the docker CLI reaches Docker Engine',
    versionReport: DOCKER_CLI_ON_DOCKER_ENGINE_VERSION_REPORT,
  },
  {
    name: "forgejo-serve runs the container as the invoking user when the docker CLI reaches podman's API, because the docker CLI refuses keep-id",
    versionReport: DOCKER_CLI_ON_PODMAN_VERSION_REPORT,
  },
];

for (const { name, versionReport } of KNOWN_ENGINES_BEHIND_THE_DOCKER_CLI) {
  test(name, async () => {
    const { result, argumentsList } = await serveThroughDocker(versionReport);

    assert.ok(argumentsList.includes(INVOKING_USER_MAPPING));
    assert.equal(argumentsList.some((argument) => argument.startsWith('--userns')), false);
    assert.doesNotMatch(result.stderr, /no container engine this script knows/);
  });
}

test('forgejo-serve gives an unknown engine the Docker user mapping and says what the engine reported', async () => {
  const { result, argumentsList } = await serveThroughDocker(UNKNOWN_ENGINE_VERSION_REPORT);

  assert.ok(argumentsList.includes(INVOKING_USER_MAPPING));
  assert.match(result.stderr, /docker reports no container engine this script knows \( Example Runtime 1\.0\)/);
});

test('forgejo-serve decides the user mapping from what the CLI reports, not from its name', async () => {
  const host = await buildHost();
  await configureForge(host);
  await rm(path.join(host.fakeBin, 'podman'));
  await installRuntime(host, 'docker', PODMAN_CLI_VERSION_REPORT);

  const result = await runForgejoServe(host);

  assert.equal(result.code, 0, result.stderr);
  assert.ok((await containerRunArguments(host, 'docker')).includes(KEEP_ID_MAPPING));
});

async function forgejoImagePinLine(): Promise<string> {
  const script = await readFile(path.join(REPO_ROOT, 'systemd', 'forgejo-serve'), 'utf8');
  const pinLine = script.split('\n').find((line) => line.startsWith('forgejo_image='));
  assert.ok(pinLine, 'systemd/forgejo-serve has no forgejo_image= line');
  return pinLine;
}

test('forgejo-serve reads the Forgejo image pin from the real vendor-pins.json', async () => {
  const pinsFile = path.join(REPO_ROOT, 'vendor-pins.json');
  const pinnedImage = JSON.parse(await readFile(pinsFile, 'utf8')).tools.forgejo.image;

  const { stdout } = await execFileAsync(
    await findOnPath('sh'),
    ['-c', `${await forgejoImagePinLine()}\nprintf '%s' "$forgejo_image"`],
    { env: { PATH: process.env.PATH, node_binary: process.execPath, pins_file: pinsFile } },
  );

  assert.equal(stdout, pinnedImage);
});

function environmentOfUnit(renderedUnit: string): NodeJS.ProcessEnv {
  return Object.fromEntries(
    [...renderedUnit.matchAll(/^Environment=([^=\n]+)=(.*)$/gm)].map(([, name, value]) => [name, value]),
  );
}

test("forgejo-serve finds node under the rendered forgejo.service's own environment", async () => {
  const source = await readFile(path.join(SYSTEMD_SOURCE_DIR, SYSTEMD_UNIT_NAMES.FORGEJO), 'utf8');
  const unitEnvironment = environmentOfUnit(
    renderUnitSource(source, { throneRoot: REPO_ROOT, herdrBin: '/unused/herdr', nodeBin: process.execPath }),
  );
  const stateHome = await mkdtemp(path.join(tmpdir(), 'forgejo-serve-unit-'));
  scratch.push(stateHome);

  const failure = await execFileAsync(path.join(REPO_ROOT, 'systemd', 'forgejo-serve'), [], {
    env: { ...unitEnvironment, HOME: stateHome, XDG_STATE_HOME: stateHome },
  }).then(
    () => assert.fail('forgejo-serve started without app.ini'),
    (error: { stderr?: string }) => error.stderr ?? '',
  );

  assert.equal(unitEnvironment.FORGEJO_NODE_BIN, process.execPath);
  assert.doesNotMatch(failure, /required command is unavailable/);
  assert.match(failure, /app\.ini does not exist/);
});
