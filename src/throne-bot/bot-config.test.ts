import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadBotConfig } from './bot-config.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TRACKED_EXAMPLE_BOT_DIR = join(REPO_ROOT, 'bots.example', 'electronics-expert');

async function writeBotFolder(
  fields: Record<string, unknown>,
  options: { withPersonaFile?: boolean } = {},
): Promise<string> {
  const botDir = await mkdtemp(join(tmpdir(), 'throne-bot-config-test-'));
  await writeFile(join(botDir, 'bot.json'), JSON.stringify(fields), 'utf8');
  if (options.withPersonaFile !== false) {
    await writeFile(join(botDir, 'persona.md'), 'A test persona.', 'utf8');
  }
  return botDir;
}

const VALID_FIELDS = {
  name: 'test-bot',
  displayName: 'Test Bot',
  roomTitle: 'Test bot — a room for testing',
  skills: ['testing'],
  model: 'claude/fable',
};

test('the loader accepts the tracked electronics-expert example bot folder', async () => {
  const config = await loadBotConfig(TRACKED_EXAMPLE_BOT_DIR);
  assert.equal(config.name, 'electronics-expert');
  assert.equal(config.model, 'claude/fable');
  assert.ok(config.skills.length > 0);
  assert.ok(config.personaText.length > 0);
});

test('a bot folder missing a persona file is rejected', async () => {
  const botDir = await writeBotFolder(VALID_FIELDS, { withPersonaFile: false });
  try {
    await assert.rejects(loadBotConfig(botDir), /persona file/);
  } finally {
    await rm(botDir, { recursive: true, force: true });
  }
});

test('a bot folder with a model other than claude/fable is rejected', async () => {
  const botDir = await writeBotFolder({ ...VALID_FIELDS, model: 'gpt-5' });
  try {
    await assert.rejects(loadBotConfig(botDir), /model/);
  } finally {
    await rm(botDir, { recursive: true, force: true });
  }
});

test('a bot folder missing roomTitle is rejected', async () => {
  const { roomTitle: _roomTitle, ...withoutRoomTitle } = VALID_FIELDS;
  const botDir = await writeBotFolder(withoutRoomTitle);
  try {
    await assert.rejects(loadBotConfig(botDir), /roomTitle/);
  } finally {
    await rm(botDir, { recursive: true, force: true });
  }
});

test('a bot folder missing skills is rejected', async () => {
  const { skills: _skills, ...withoutSkills } = VALID_FIELDS;
  const botDir = await writeBotFolder(withoutSkills);
  try {
    await assert.rejects(loadBotConfig(botDir), /skills/);
  } finally {
    await rm(botDir, { recursive: true, force: true });
  }
});

test('a bot folder without bot.json is rejected', async () => {
  const botDir = await mkdtemp(join(tmpdir(), 'throne-bot-config-test-'));
  try {
    await assert.rejects(loadBotConfig(botDir), /bot\.json/);
  } finally {
    await rm(botDir, { recursive: true, force: true });
  }
});
