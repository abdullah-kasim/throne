import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  executeHerdrReadOnly,
  OWNED_HERDR_CLIENT_RELEASE_TAG,
  ownedHerdrClientPath,
  THRONE_HERDR_PROTOCOL,
} from './herdr-client.ts';
import { herdrSocketPath } from './herdr-socket.ts';

type Answer = (request: { method: string; params: Record<string, unknown> }, connection: net.Socket) => void;

async function fakeHerdr(answer: Answer) {
  const root = await mkdtemp(path.join(tmpdir(), 'hs-'));
  const env = { HOME: root, XDG_CONFIG_HOME: path.join(root, 'c'), XDG_DATA_HOME: path.join(root, 'd') };
  const herdrPath = ownedHerdrClientPath(env, root);
  const launchLog = path.join(root, 'launches.log');
  await mkdir(path.dirname(herdrPath), { recursive: true });
  await writeFile(herdrPath, `#!/bin/sh\necho "$*" >> '${launchLog}'\necho '{"id":"cli","result":{"from":"command line"}}'\n`);
  await chmod(herdrPath, 0o755);
  const socketPath = herdrSocketPath('fake', env);
  await mkdir(path.dirname(socketPath), { recursive: true });
  const requests: string[] = [];
  const server = net.createServer((connection) => {
    let received = '';
    connection.on('data', (chunk) => {
      received += chunk.toString('utf8');
      if (!received.includes('\n')) return;
      const request = JSON.parse(received.slice(0, received.indexOf('\n')));
      requests.push(request.method);
      if (request.method === 'ping') {
        connection.end(`${JSON.stringify({ id: request.id, result: { type: 'pong', version: OWNED_HERDR_CLIENT_RELEASE_TAG.slice(1), protocol: Number(THRONE_HERDR_PROTOCOL) } })}\n`);
        return;
      }
      answer(request, connection);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const launches = async () => (await readFile(launchLog, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  const run = (args: string[]) => executeHerdrReadOnly(herdrPath, ['--session', 'fake', ...args], { env });
  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  };
  return { run, launches, requests, close };
}

test('a herdr screen read goes over the socket and starts no herdr process', async () => {
  const herdr = await fakeHerdr((request, connection) => {
    connection.end(`${JSON.stringify({ id: 'x', result: { type: 'pane_read', read: { text: `screen of ${request.params.target} ${request.params.source} ${request.params.format}` } } })}\n`);
  });
  try {
    const { stdout } = await herdr.run(['agent', 'read', 'w1:p1', '--source', 'visible', '--format', 'ansi']);
    assert.equal(stdout, 'screen of w1:p1 visible ansi');
    assert.deepEqual(await herdr.launches(), []);
  } finally {
    await herdr.close();
  }
});

test('a call herdr\'s schema lacks still uses the herdr command', async () => {
  const herdr = await fakeHerdr(() => assert.fail('the socket must not be asked'));
  try {
    const { stdout } = await herdr.run(['workspace', 'rename', 'w1', 'court']);
    assert.match(stdout, /command line/);
    assert.deepEqual(await herdr.launches(), ['--session fake workspace rename w1 court']);
  } finally {
    await herdr.close();
  }
});

test('a refused call over the socket is not retried on the command line', async () => {
  const herdr = await fakeHerdr((_request, connection) => {
    connection.end(`${JSON.stringify({ id: 'x', error: { code: 'pane_not_found', message: 'pane not found' } })}\n`);
  });
  try {
    await assert.rejects(herdr.run(['pane', 'send-keys', 'w1:p9', 'Enter']), { code: 'pane_not_found' });
    assert.deepEqual(await herdr.launches(), []);
  } finally {
    await herdr.close();
  }
});

test('a key press whose socket outcome is uncertain is never sent twice', async () => {
  const herdr = await fakeHerdr((_request, connection) => connection.destroy());
  try {
    await assert.rejects(herdr.run(['pane', 'send-keys', 'w1:p1', 'Enter']), { code: 'socket_outcome_unknown' });
    assert.deepEqual(herdr.requests.filter((method) => method === 'pane.send_keys'), ['pane.send_keys']);
    assert.deepEqual(await herdr.launches(), []);
  } finally {
    await herdr.close();
  }
});
