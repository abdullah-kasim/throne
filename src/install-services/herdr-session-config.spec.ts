import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeScratchDirectory } from '../scratch-directory.test-support.ts';
import { ensureHerdrResumeDisabled, herdrConfigPath } from './herdr-session-config.ts';

const RESUME_DISABLED_SESSION_TABLE = '[session]\nresume_agents_on_restore = false\n';

const LORDS_CURRENT_HERDR_CONFIG = [
  'onboarding = false',
  '[ui]',
  'agent_panel_sort = "spaces"',
  '',
  '[theme]',
  'name = "terminal"',
  'auto_switch = false',
  '',
  '[ui.sound]',
  'enabled = false',
  '',
].join('\n');

async function herdrConfigFile(initialText: string | null): Promise<string> {
  const directory = await makeScratchDirectory('herdr-session-config-');
  const configPath = path.join(directory, 'herdr', 'config.toml');
  if (initialText !== null) {
    await mkdir(path.dirname(configPath));
    await writeFile(configPath, initialText);
  }
  return configPath;
}

async function switchResumeOff(initialText: string | null): Promise<{ outcome: string; text: string }> {
  const configPath = await herdrConfigFile(initialText);
  const outcome = await ensureHerdrResumeDisabled(configPath);
  return { outcome, text: await readFile(configPath, 'utf8') };
}

test('an empty herdr config gains a session table that disables resume on restore', async () => {
  assert.deepEqual(await switchResumeOff(''), { outcome: 'changed', text: RESUME_DISABLED_SESSION_TABLE });
});

test("the Lord's current herdr config keeps every existing line and gains resume disabled", async () => {
  assert.deepEqual(await switchResumeOff(LORDS_CURRENT_HERDR_CONFIG), {
    outcome: 'changed',
    text: `${LORDS_CURRENT_HERDR_CONFIG}\n${RESUME_DISABLED_SESSION_TABLE}`,
  });
});

test('a session table that turns resume on is switched off without touching its other lines', async () => {
  const sessionTurningResumeOn = [
    '[ui]',
    'agent_panel_sort = "spaces"',
    '',
    '[session]',
    '# resume_agents_on_restore = true',
    'resume_agents_on_restore = true  # set by hand',
    'restore_layout = true',
    '',
    '[session.extra]',
    'resume_agents_on_restore = true',
    '',
  ].join('\n');

  assert.deepEqual(await switchResumeOff(sessionTurningResumeOn), {
    outcome: 'changed',
    text: sessionTurningResumeOn.replace(
      'resume_agents_on_restore = true  # set by hand',
      'resume_agents_on_restore = false  # set by hand',
    ),
  });
});

test('a session table without the resume setting gains it inside that table', async () => {
  const sessionWithoutResumeSetting = [
    '[session]',
    '# resume_agents_on_restore = true',
    '',
    '[remote]',
    'manage_ssh_config = true',
    '',
    '[session.extra]',
    'resume_agents_on_restore = true',
  ].join('\n');

  assert.deepEqual(await switchResumeOff(sessionWithoutResumeSetting), {
    outcome: 'changed',
    text: [
      '[session]',
      '# resume_agents_on_restore = true',
      'resume_agents_on_restore = false',
      '',
      '[remote]',
      'manage_ssh_config = true',
      '',
      '[session.extra]',
      'resume_agents_on_restore = true',
    ].join('\n'),
  });
});

test('running the resume switch twice changes the file only once', async () => {
  const configPath = await herdrConfigFile(LORDS_CURRENT_HERDR_CONFIG);
  assert.equal(await ensureHerdrResumeDisabled(configPath), 'changed');
  const textAfterFirstRun = await readFile(configPath, 'utf8');
  const modifiedAfterFirstRun = (await stat(configPath)).mtimeMs;

  assert.equal(await ensureHerdrResumeDisabled(configPath), 'unchanged');
  assert.equal(await readFile(configPath, 'utf8'), textAfterFirstRun);
  assert.equal((await stat(configPath)).mtimeMs, modifiedAfterFirstRun);
});

test('a missing herdr config file is created with resume disabled', async () => {
  assert.deepEqual(await switchResumeOff(null), { outcome: 'changed', text: RESUME_DISABLED_SESSION_TABLE });
});

test('the herdr config path follows HERDR_CONFIG_PATH, then XDG_CONFIG_HOME, then the home config directory', () => {
  assert.equal(
    herdrConfigPath({ HERDR_CONFIG_PATH: '/srv/herdr.toml', XDG_CONFIG_HOME: '/srv/xdg' }, '/home/lord'),
    '/srv/herdr.toml',
  );
  assert.equal(herdrConfigPath({ XDG_CONFIG_HOME: '/srv/xdg' }, '/home/lord'), '/srv/xdg/herdr/config.toml');
  assert.equal(herdrConfigPath({}, '/home/lord'), '/home/lord/.config/herdr/config.toml');
});
