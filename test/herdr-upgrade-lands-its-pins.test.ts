import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  HERDR_PIN_PATHS,
  dirtyPathsOutsideHerdrPins,
  herdrPinCommitMessage,
  rewrittenHerdrPins,
  writeHerdrPins,
  type HerdrPinTarget,
} from '../src/herdr-update/herdr-upgrade-pins.ts';
import { OWNED_HERDR_CLIENT_RELEASE_TAG, THRONE_HERDR_PROTOCOL } from '../src/herdr/herdr-client.ts';
import { HERDR_RELEASE } from '../src/install-services/herdr-release.service.ts';
import { landPinCommit } from '../scripts/land-pin-commit.mjs';
import { turnOffCommitSigningThatTheEnvironmentTurnedOn } from './git-repo-test-fixture.ts';

turnOffCommitSigningThatTheEnvironmentTurnedOn();

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..');
const NEW_DIGEST = 'b'.repeat(64);

function git(repository: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
}

async function repositoryHoldingThePins(): Promise<string> {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'herdr-upgrade-pins-'));
  git(repository, 'init', '-q', '-b', 'main');
  git(repository, 'config', 'user.name', 'Pin Test');
  git(repository, 'config', 'user.email', 'pin-test@example.invalid');
  git(repository, 'config', 'commit.gpgsign', 'false');
  for (const pinPath of HERDR_PIN_PATHS) {
    await mkdir(path.dirname(path.join(repository, pinPath)), { recursive: true });
    await copyFile(path.join(REPOSITORY_ROOT, pinPath), path.join(repository, pinPath));
  }
  await writeFile(path.join(repository, 'unrelated.txt'), 'first\n');
  git(repository, 'add', '.');
  git(repository, 'commit', '-q', '-m', 'Start');
  return repository;
}

function currentPinTarget(): HerdrPinTarget {
  return {
    tag: OWNED_HERDR_CLIENT_RELEASE_TAG,
    protocol: THRONE_HERDR_PROTOCOL,
    repositorySlug: HERDR_RELEASE.repository,
    metadata: {
      assets: Object.values(HERDR_RELEASE.artifacts).map((artifact) => ({
        name: artifact.filename,
        digest: `sha256:${artifact.sha256}`,
      })),
    },
  };
}

function newPinTarget(): HerdrPinTarget {
  const current = currentPinTarget();
  return {
    ...current,
    tag: 'v0.9.6',
    protocol: '23',
    metadata: { assets: current.metadata.assets.map((asset) => ({ ...asset, digest: `sha256:${NEW_DIGEST}` })) },
  };
}

function landPins(repository: string, tag: string) {
  return landPinCommit({ repository, paths: HERDR_PIN_PATHS, message: herdrPinCommitMessage(tag) });
}

test('an apply of a new tag lands its pins as one commit', async () => {
  const repository = await repositoryHoldingThePins();
  try {
    await writeFile(path.join(repository, 'unrelated.txt'), 'second\n');
    await writeHerdrPins(repository, await rewrittenHerdrPins(repository, newPinTarget()));
    const landed = landPins(repository, 'v0.9.6');
    assert.equal(landed.committed, true);
    assert.equal(git(repository, 'rev-list', '--count', 'HEAD'), '2');
    assert.equal(git(repository, 'log', '-1', '--format=%s'), 'Pin herdr to v0.9.6');
    assert.deepEqual(git(repository, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), [...HERDR_PIN_PATHS].sort());
    const client = await readFile(path.join(repository, HERDR_PIN_PATHS[0]!), 'utf8');
    assert.match(client, /OWNED_HERDR_CLIENT_RELEASE_TAG = 'v0\.9\.6'/);
    assert.match(client, /THRONE_HERDR_PROTOCOL = '23'/);
    const release = await readFile(path.join(repository, HERDR_PIN_PATHS[1]!), 'utf8');
    assert.equal(release.split(NEW_DIGEST).length - 1, 4);
    assert.match(git(repository, 'status', '--porcelain'), /unrelated\.txt/);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('an apply of the current tag makes no pin commit', async () => {
  const repository = await repositoryHoldingThePins();
  try {
    await writeHerdrPins(repository, await rewrittenHerdrPins(repository, currentPinTarget()));
    const landed = landPins(repository, OWNED_HERDR_CLIENT_RELEASE_TAG);
    assert.equal(landed.committed, false);
    assert.equal(git(repository, 'rev-list', '--count', 'HEAD'), '1');
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('a run that stopped before its pin commit is not refused and lands the commit on the next run', async () => {
  const repository = await repositoryHoldingThePins();
  try {
    await writeHerdrPins(repository, await rewrittenHerdrPins(repository, newPinTarget()));
    assert.equal(await dirtyPathsOutsideHerdrPins(repository), '');
    await writeHerdrPins(repository, await rewrittenHerdrPins(repository, newPinTarget()));
    assert.equal(landPins(repository, 'v0.9.6').committed, true);
    assert.equal(git(repository, 'status', '--porcelain'), '');
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('a tree dirty outside the pins is still refused', async () => {
  const repository = await repositoryHoldingThePins();
  try {
    await writeFile(path.join(repository, 'unrelated.txt'), 'second\n');
    assert.match(await dirtyPathsOutsideHerdrPins(repository), /unrelated\.txt/);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('release metadata missing a digest is refused before any pin moves', async () => {
  const repository = await repositoryHoldingThePins();
  try {
    await assert.rejects(
      rewrittenHerdrPins(repository, { ...currentPinTarget(), metadata: { assets: [] } }),
      /no sha256 digest in release metadata/,
    );
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});
