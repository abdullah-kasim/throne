import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadBotConfig } from '../bot-config.ts';
import { renderBotSystemPrompt } from './bot-system-prompt.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TRACKED_EXAMPLE_BOT_DIR = join(REPO_ROOT, 'bots.example', 'electronics-expert');

const BANNED_PHRASES = ["Lord", 'Shadow Garden', "You're absolutely right", 'Perfect!'];

test('the bot persona never addresses anyone as Lord or invokes Shadow Garden', async () => {
  const config = await loadBotConfig(TRACKED_EXAMPLE_BOT_DIR);
  const rendered = await renderBotSystemPrompt(config);
  for (const phrase of BANNED_PHRASES) {
    assert.equal(
      rendered.includes(phrase),
      false,
      `rendered bot system prompt must not contain "${phrase}"`,
    );
  }
});

test('the rendered bot system prompt states the delivery format, commands, and DONE relay rule', async () => {
  const config = await loadBotConfig(TRACKED_EXAMPLE_BOT_DIR);
  const rendered = await renderBotSystemPrompt(config);
  assert.match(rendered, /<sender> said: <text>/);
  assert.match(rendered, /throne-bot say/);
  assert.match(rendered, /throne-bot send-file/);
  assert.match(rendered, /throne send-agent electronics-expert "DONE <code>: <summary>"/);
  assert.match(rendered, /never spawn an\s+agent/);
});
