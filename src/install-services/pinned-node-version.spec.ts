import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { REAL_DEPS } from './platform.ts';
import {
  renderUnitSource,
  SYSTEMD_SOURCE_DIR,
} from './service-unit-renderer.service.ts';

const PINNED_VERSION = '24.19.0';

let scratch: string;
let homeBeforeTests: string | undefined;
let pinnedThroneRoot: string;
let unpinnedThroneRoot: string;

async function installFakeNode(home: string, version: string): Promise<string> {
  const binDirectory = path.join(home, '.local', 'share', 'mise', 'installs', 'node', version, 'bin');
  await mkdir(binDirectory, { recursive: true });
  const nodeBin = path.join(binDirectory, 'node');
  await writeFile(nodeBin, '');
  return nodeBin;
}

async function createThroneRoot(name: string, miseConfig: string): Promise<string> {
  const throneRoot = path.join(scratch, name);
  await mkdir(throneRoot, { recursive: true });
  await writeFile(path.join(throneRoot, 'mise.toml'), miseConfig);
  return throneRoot;
}

async function useScratchHome(name: string): Promise<string> {
  const home = path.join(scratch, name);
  await mkdir(home, { recursive: true });
  process.env.HOME = home;
  return home;
}

before(async () => {
  homeBeforeTests = process.env.HOME;
  scratch = await mkdtemp(path.join(os.tmpdir(), 'pinned-node-version-'));
  pinnedThroneRoot = await createThroneRoot('pinned', `[tools]\nnode = "${PINNED_VERSION}"\n`);
  unpinnedThroneRoot = await createThroneRoot('unpinned', '[tools]\npython = "3.12"\n');
});

after(async () => {
  process.env.HOME = homeBeforeTests;
  await rm(scratch, { recursive: true, force: true });
});

test('the services run the node version pinned in mise.toml', async () => {
  const home = await useScratchHome('home-with-pinned-node');
  const pinnedNodeBin = await installFakeNode(home, PINNED_VERSION);
  await installFakeNode(home, 'lts');

  assert.equal(REAL_DEPS.resolveNodeBin(pinnedThroneRoot), pinnedNodeBin);
});

test('the services refuse to render when the pinned node is not installed', async () => {
  await useScratchHome('home-without-node');
  const unitSource = await readFile(
    path.join(SYSTEMD_SOURCE_DIR, 'sweep-tmp-scratch-slash.service'),
    'utf8',
  );

  assert.throws(
    () =>
      renderUnitSource(unitSource, {
        throneRoot: pinnedThroneRoot,
        herdrBin: null,
        nodeBin: REAL_DEPS.resolveNodeBin(pinnedThroneRoot),
      }),
    /unresolved template token \{\{NODE_BIN\}\}/,
  );
});

test('the services never resolve mise\'s lts link', async () => {
  const home = await useScratchHome('home-with-only-lts');
  await installFakeNode(home, 'lts');

  assert.equal(REAL_DEPS.resolveNodeBin(pinnedThroneRoot), null);
});

test('the services resolve no node when mise.toml pins none', async () => {
  const home = await useScratchHome('home-for-unpinned-root');
  await installFakeNode(home, PINNED_VERSION);

  assert.equal(REAL_DEPS.resolveNodeBin(unpinnedThroneRoot), null);
});
