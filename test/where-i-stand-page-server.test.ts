import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { connect, createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { missingPhrases, readMarkdownSection, unwrap } from './skill-contract-test-helpers.ts';

const PAGE_FOLDER = resolve(import.meta.dirname, '..', '.claude/skills/where-i-stand/page');
const PAGE_SERVER_SCRIPT = join(PAGE_FOLDER, 'page_server.py');
const SKILL_FILE = resolve(PAGE_FOLDER, '..', 'SKILL.md');
const SERVING_STEP_HEADING = '### 5. Keep the tailnet page up';
const SERVER_START_ATTEMPTS = 50;
const SERVER_START_INTERVAL_MILLISECONDS = 100;
const ENTRY_THAT_IS_GONE = 'gone';
const TAILNET_NAME_THAT_NEVER_ANSWERS = '127.0.0.1:1.';

let scratchRoot = '';
let pageFile = '';
let recordsFile = '';
let saveCommandInput = '';
let saveCommandArguments = '';
let serverAddress = '';
let serverPort = 0;
let server: ChildProcess | undefined;

function freeLocalPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolvePort(typeof address === 'object' && address !== null ? address.port : 0));
    });
  });
}

async function writeSaveCommandStub(binFolder: string): Promise<void> {
  const stub = join(binFolder, 'throne');
  await writeFile(
    stub,
    [
      '#!/bin/sh',
      'input="$(cat)"',
      `printf '%s' "$*" > '${saveCommandArguments}'`,
      `printf '%s' "$input" > '${saveCommandInput}'`,
      `case "$input" in *${ENTRY_THAT_IS_GONE}*) echo '{"outcome":"entry-changed","message":"That entry changed since you loaded the page."}'; exit 1;; esac`,
      `echo '{"outcome":"saved","message":"Saved."}'`,
      '',
    ].join('\n'),
  );
  await chmod(stub, 0o755);
}

async function waitUntilTheServerAnswers(): Promise<void> {
  for (let attempt = 0; attempt < SERVER_START_ATTEMPTS; attempt += 1) {
    try {
      await fetch(`${serverAddress}/`);
      return;
    } catch {
      await new Promise((wait) => setTimeout(wait, SERVER_START_INTERVAL_MILLISECONDS));
    }
  }
  throw new Error(`the page server never answered on ${serverAddress}`);
}

function outsideAddressOfThisMachine(): string | undefined {
  return Object.values(networkInterfaces())
    .flat()
    .find((address) => address !== undefined && address.family === 'IPv4' && !address.internal)?.address;
}

function connectionIsAccepted(host: string, port: number): Promise<boolean> {
  return new Promise((answer) => {
    const socket = connect({ host, port });
    socket.once('connect', () => {
      socket.destroy();
      answer(true);
    });
    socket.once('error', () => answer(false));
  });
}

function statusOfRawRequest(path: string): Promise<number | undefined> {
  return new Promise((answer, refuse) => {
    get({ host: '127.0.0.1', port: serverPort, path }, (response) => {
      response.resume();
      answer(response.statusCode);
    }).once('error', refuse);
  });
}

async function readSkillSection(heading: string): Promise<string> {
  const section = readMarkdownSection(await readFile(SKILL_FILE, 'utf8'), heading);
  assert.notEqual(section, '', `the where-i-stand skill has the section "${heading}"`);
  return unwrap(section);
}

async function postSave(body: object): Promise<{ status: number; answer: unknown }> {
  const response = await fetch(`${serverAddress}/save`, { method: 'POST', body: JSON.stringify(body) });
  return { status: response.status, answer: await response.json() };
}

before(async () => {
  scratchRoot = await mkdtemp(join(tmpdir(), 'where-i-stand-page-server-'));
  const dataHome = join(scratchRoot, 'data');
  const cacheHome = join(scratchRoot, 'cache');
  const binFolder = join(scratchRoot, 'bin');
  await mkdir(dataHome);
  await mkdir(join(cacheHome, 'where-i-stand'), { recursive: true });
  await mkdir(binFolder);
  pageFile = join(dataHome, 'where-i-stand.md');
  recordsFile = join(cacheHome, 'where-i-stand', 'where-i-stand-prs.json');
  saveCommandInput = join(scratchRoot, 'save-command-input');
  saveCommandArguments = join(scratchRoot, 'save-command-arguments');
  await writeFile(pageFile, '## Just happened\n\n- filed cakeorders\n');
  await writeFile(recordsFile, '{"pullRequests":[]}\n');
  await writeSaveCommandStub(binFolder);
  serverPort = await freeLocalPort();
  serverAddress = `http://127.0.0.1:${serverPort}`;
  server = spawn('python3', [PAGE_SERVER_SCRIPT, 'serve', String(serverPort)], {
    env: {
      ...process.env,
      THRONE_DATA_HOME: dataHome,
      XDG_CACHE_HOME: cacheHome,
      PATH: `${binFolder}:${process.env.PATH ?? ''}`,
      PYTHONDONTWRITEBYTECODE: '1',
    },
    stdio: 'ignore',
  });
  await waitUntilTheServerAnswers();
});

after(async () => {
  server?.kill();
  await rm(scratchRoot, { recursive: true, force: true });
});

test('the page server serves the page, its Markdown file and its records live from their real paths', async () => {
  const indexPage = await readFile(join(PAGE_FOLDER, 'index.html'), 'utf8');
  for (const address of ['/', '/index.html']) {
    const response = await fetch(`${serverAddress}${address}`);
    assert.equal(response.status, 200, address);
    assert.equal(await response.text(), indexPage, address);
  }

  const markdownResponse = await fetch(`${serverAddress}/where-i-stand.md`);
  assert.equal(await markdownResponse.text(), await readFile(pageFile, 'utf8'));
  assert.equal(markdownResponse.headers.get('Cache-Control'), 'no-store');
  assert.equal(markdownResponse.headers.get('Last-Modified'), new Date((await stat(pageFile)).mtimeMs).toUTCString());

  const recordsResponse = await fetch(`${serverAddress}/where-i-stand-prs.json`);
  assert.equal(await recordsResponse.text(), await readFile(recordsFile, 'utf8'));
  assert.equal(recordsResponse.headers.get('Cache-Control'), 'no-store');

  await writeFile(pageFile, '## Just happened\n\n- delivered cakeorders\n');
  assert.equal(await (await fetch(`${serverAddress}/where-i-stand.md`)).text(), '## Just happened\n\n- delivered cakeorders\n');

  assert.equal(await statusOfRawRequest('/../SKILL.md'), 404);
  assert.equal((await fetch(`${serverAddress}/no-such-file.js`)).status, 404);
});

test('the page server answers a save by running the save command and relays its outcome', async () => {
  const save = { loaded: '- filed cakeorders', edited: '- filed cakeorders for Friday' };
  assert.deepEqual(await postSave(save), { status: 200, answer: { outcome: 'saved', message: 'Saved.' } });
  assert.equal(await readFile(saveCommandArguments, 'utf8'), 'where-i-stand save');
  assert.deepEqual(JSON.parse(await readFile(saveCommandInput, 'utf8')), save);

  assert.deepEqual(await postSave({ loaded: `- ${ENTRY_THAT_IS_GONE}`, edited: '- anything' }), {
    status: 409,
    answer: { outcome: 'entry-changed', message: 'That entry changed since you loaded the page.' },
  });
});

test('the page server listens on 127.0.0.1 only', async () => {
  const outsideAddress = outsideAddressOfThisMachine();
  assert.ok(outsideAddress, 'this machine has an address other than loopback to try');
  assert.equal(await connectionIsAccepted('127.0.0.1', serverPort), true);
  assert.equal(await connectionIsAccepted(outsideAddress, serverPort), false);
});

test('the where-i-stand skill serves the page on the tailnet only, from the page server that answers its saves', async () => {
  const servingStep = await readSkillSection(SERVING_STEP_HEADING);
  const serverStop = 'page_server.py" stop';
  const serverStart = 'page_server.py" start';
  assert.deepEqual(
    missingPhrases(servingStep, [
      'on the tailnet only, never through funnel, at the path `/where-i-stand`',
      'The server does not survive a reboot, so check it on every run and start it when it is not up',
      `curl -s -o /dev/null -w '%{http_code}\\n' "\${page_url}where-i-stand-prs.json"`,
      'or it is an older page served without the pull request table',
      'tailnet-preview.sh stop where-i-stand',
      'python3 "$THRONE_LIVE_ROOT/.claude/skills/where-i-stand/page/page_server.py" stop',
      'python3 "$THRONE_LIVE_ROOT/.claude/skills/where-i-stand/page/page_server.py" start',
      'The server listens on 127.0.0.1 only',
      'so the served page always shows the live files. Nothing is copied.',
      'Only the page server runs `throne where-i-stand save`; an agent never does.',
      'journals the edit with the writer `Lord`',
      'When the data file is missing, run the reader once with `--refresh` (step 2), which writes it, before you start the server.',
      'Never take the path over with `tailscale serve` by hand',
    ]),
    [],
  );
  assert.ok(!servingStep.includes('tailscale funnel'), 'no step runs a funnel');
  assert.ok(!servingStep.includes('tailnet-preview.sh share'), 'the static share is gone');
  assert.ok(
    servingStep.indexOf('tailnet-preview.sh stop where-i-stand') < servingStep.indexOf(serverStart) &&
      servingStep.indexOf(serverStop) < servingStep.indexOf(serverStart),
    'both stops run before start',
  );
});

test('the where-i-stand skill says the Lord writes the page too, through the page', async () => {
  const skill = unwrap(await readFile(SKILL_FILE, 'utf8'));
  assert.ok(!skill.includes('only agents write'), 'no sentence says only agents write the page');
  assert.deepEqual(
    missingPhrases(await readSkillSection('## Who writes, and when'), [
      '| Lord | edits or removes an entry or a `## Just happened` line on the page |',
      'journaled with the writer `Lord`; a save whose entry changed since he loaded the page is refused',
    ]),
    [],
  );
});

async function writeTailscaleThatNeverServesThePage(binFolder: string, callLog: string): Promise<void> {
  const tailscale = join(binFolder, 'tailscale');
  await writeFile(
    tailscale,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${callLog}'`,
      `case "$*" in 'status --self --json') echo '{"Self":{"DNSName":"${TAILNET_NAME_THAT_NEVER_ANSWERS}"}}';; 'serve status --json') echo '{}';; esac`,
      '',
    ].join('\n'),
  );
  await writeFile(join(binFolder, 'lsof'), '#!/bin/sh\n');
  await chmod(tailscale, 0o755);
  await chmod(join(binFolder, 'lsof'), 0o755);
}

test('a page server start whose page never answers through the tailnet stops what it started', async () => {
  const startRoot = await mkdtemp(join(tmpdir(), 'where-i-stand-page-server-start-'));
  const binFolder = join(startRoot, 'bin');
  const cacheHome = join(startRoot, 'cache');
  const callLog = join(startRoot, 'tailscale-calls');
  await mkdir(binFolder);
  await writeTailscaleThatNeverServesThePage(binFolder, callLog);
  const environment = { ...process.env, THRONE_DATA_HOME: join(startRoot, 'data'), XDG_CACHE_HOME: cacheHome, PATH: `${binFolder}:${process.env.PATH ?? ''}`, PYTHONDONTWRITEBYTECODE: '1' };
  try {
    const failure = await promisify(execFile)('python3', [PAGE_SERVER_SCRIPT, 'start'], { env: environment }).then(
      () => assert.fail('start reported success for a page that never answered'),
      (error: { code?: number; stderr?: string }) => error,
    );
    assert.equal(failure.code, 1);
    assert.match(failure.stderr ?? '', /did not answer 200/);
    const calls = (await readFile(callLog, 'utf8')).trim().split('\n');
    const localPort = Number(/--set-path \/where-i-stand http:\/\/127\.0\.0\.1:(\d+)$/m.exec(calls.join('\n'))?.[1]);
    assert.ok(localPort > 0, 'start published a local server');
    assert.equal(await connectionIsAccepted('127.0.0.1', localPort), false, 'the local server is stopped');
    assert.equal(calls.at(-1), 'serve --bg --set-path /where-i-stand off');
    await assert.rejects(stat(join(cacheHome, 'where-i-stand', 'page-server.port')));
  } finally {
    await rm(startRoot, { recursive: true, force: true });
  }
});
