import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { claudeProjectDirectory } from '../session/runtime-model-acceptance.ts';
import {
  readClaudeSessionSettings,
  type ClaudeSessionSettings,
} from './claude-session-settings.ts';

const FIXTURES_DIRECTORY = path.join(import.meta.dirname, 'fixtures');
const WORKING_DIRECTORY = '/home/baker/recipe-app';
const SESSION_ID = '5d2c1f0e-7a4b-4c3d-9e8f-0a1b2c3d4e5f';
const GENERATED_TITLE = 'Scale a sourdough recipe';
const HERDR_CLIENT_PATH_VARIABLE = 'THRONE_HERDR_CLIENT_PATH';

async function withScratchDirectory<Result>(
  work: (scratchDirectory: string) => Promise<Result>,
): Promise<Result> {
  const scratchDirectory = await mkdtemp(path.join(tmpdir(), 'claude-session-settings-'));
  try {
    return await work(scratchDirectory);
  } finally {
    await rm(scratchDirectory, { recursive: true, force: true });
  }
}

async function placeRecordedTranscript(
  fixtureName: string,
  claudeProjectsDirectory: string,
): Promise<void> {
  const projectDirectory = claudeProjectDirectory(WORKING_DIRECTORY, claudeProjectsDirectory);
  await mkdir(projectDirectory, { recursive: true });
  await copyFile(
    path.join(FIXTURES_DIRECTORY, `${fixtureName}.jsonl`),
    path.join(projectDirectory, `${SESSION_ID}.jsonl`),
  );
}

function settingsReadFromRecordedSession(fixtureName: string): Promise<ClaudeSessionSettings> {
  return withScratchDirectory(async (claudeProjectsDirectory) => {
    await placeRecordedTranscript(fixtureName, claudeProjectsDirectory);
    return readClaudeSessionSettings(WORKING_DIRECTORY, SESSION_ID, claudeProjectsDirectory);
  });
}

async function installHerdrClientThatRecordsItsCalls(scratchDirectory: string): Promise<string> {
  const recordedCallsPath = path.join(scratchDirectory, 'herdr-calls.log');
  const clientPath = path.join(scratchDirectory, 'herdr');
  await writeFile(clientPath, `#!/bin/sh\necho "$*" >> "${recordedCallsPath}"\n`);
  await chmod(clientPath, 0o755);
  process.env[HERDR_CLIENT_PATH_VARIABLE] = clientPath;
  return recordedCallsPath;
}

async function recordedHerdrCalls(recordedCallsPath: string): Promise<string> {
  try {
    return await readFile(recordedCallsPath, 'utf8');
  } catch {
    return '';
  }
}

test('the colour an agent shows is the newest colour recorded in its transcript', async () => {
  const settings = await settingsReadFromRecordedSession('recoloured-and-renamed-session');

  assert.equal(settings.colour, 'blue');
});

test('the session name is the newest name the rename command recorded in its transcript', async () => {
  const settings = await settingsReadFromRecordedSession('recoloured-and-renamed-session');

  assert.equal(settings.sessionName, 'night-baker');
});

test('the title the harness generates for itself is not taken for the session name', async () => {
  const renamed = await settingsReadFromRecordedSession('never-coloured-session');
  const neverRenamed = await settingsReadFromRecordedSession('never-renamed-session');

  assert.notEqual(renamed.sessionName, GENERATED_TITLE);
  assert.notEqual(neverRenamed.sessionName, GENERATED_TITLE);
});

test('a session that was never coloured reads as an unknown colour', async () => {
  const settings = await settingsReadFromRecordedSession('never-coloured-session');

  assert.deepEqual(settings, { colour: undefined, sessionName: 'night-baker' });
});

test('a session that was never renamed reads as an unknown name', async () => {
  const settings = await settingsReadFromRecordedSession('never-renamed-session');

  assert.deepEqual(settings, { colour: 'green', sessionName: undefined });
});

test('an agent with no transcript reads as unknown colour and unknown name', async () => {
  const settings = await withScratchDirectory((emptyClaudeProjectsDirectory) =>
    readClaudeSessionSettings(WORKING_DIRECTORY, SESSION_ID, emptyClaudeProjectsDirectory),
  );

  assert.deepEqual(settings, { colour: undefined, sessionName: undefined });
});

test('a transcript line that is not valid JSON does not stop the read', async () => {
  const settings = await settingsReadFromRecordedSession('session-with-a-line-cut-short');

  assert.deepEqual(settings, { colour: 'purple', sessionName: 'night-baker' });
});

test("reading an agent's colour and name types nothing into its pane", async (context) => {
  const herdrClientPathBeforeTest = process.env[HERDR_CLIENT_PATH_VARIABLE];
  context.after(() => {
    if (herdrClientPathBeforeTest === undefined) delete process.env[HERDR_CLIENT_PATH_VARIABLE];
    else process.env[HERDR_CLIENT_PATH_VARIABLE] = herdrClientPathBeforeTest;
  });

  await withScratchDirectory(async (scratchDirectory) => {
    const recordedCallsPath = await installHerdrClientThatRecordsItsCalls(scratchDirectory);
    await placeRecordedTranscript('recoloured-and-renamed-session', scratchDirectory);

    const settings = await readClaudeSessionSettings(
      WORKING_DIRECTORY,
      SESSION_ID,
      scratchDirectory,
    );

    assert.deepEqual(settings, { colour: 'blue', sessionName: 'night-baker' });
    assert.equal(await recordedHerdrCalls(recordedCallsPath), '');
  });
});
