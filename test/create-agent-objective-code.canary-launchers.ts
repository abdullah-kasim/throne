import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { THRONE_HERDR_PROTOCOL } from '../src/herdr/herdr-client.ts';
import { ownedHerdrExecutablePath } from '../src/install-services/herdr-release.service.ts';

export async function writeCanaryExecutables(
  binDir: string,
  hookPath: string,
  homeDirectory: string,
): Promise<void> {
  const hook = String.raw`import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
register('ts-node/esm/transpile-only', pathToFileURL(process.cwd() + '/'));
import { appendFileSync } from 'node:fs';

const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) =>
  realSetTimeout(callback, Math.min(Number(delay) || 0, 1), ...args);
const realNow = Date.now.bind(Date);
let clockAdvance = 0;
Date.now = () => realNow() + (clockAdvance += 2_000);
globalThis.fetch = async (input) => {
  const target =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  appendFileSync(process.env.CANARY_NETWORK_LOG, String(target) + '\n');
  throw new Error('objective-code canary blocked unexpected network request: ' + target);
};
`;
  await writeFile(hookPath, hook, 'utf8');

  const herdr = String.raw`#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error('missing ' + name);
  return value;
}

function log(file, value) {
  appendFileSync(file, JSON.stringify(value) + '\n');
}

function emit(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

const expectedSession = required('CANARY_HERDR_SESSION');
const invocationArgs = process.argv.slice(2);
if (invocationArgs[0] !== '--session' || invocationArgs[1] !== expectedSession) {
  process.stderr.write('expected --session ' + expectedSession + ': ' + invocationArgs.join(' '));
  process.exit(96);
}
const args = invocationArgs.slice(2);
const statePath = required('CANARY_HERDR_STATE');
const readonlyLog = required('CANARY_HERDR_READONLY_LOG');
const mutationLog = required('CANARY_HERDR_MUTATION_LOG');
const version = required('CANARY_HERDR_VERSION');
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const save = () => writeFileSync(statePath, JSON.stringify(state) + '\n');
// A tab's root pane is a plain shell, not an agent: it really executes the
// line submitted to it, so a readiness probe is proved by execution.
state.shells = state.shells || {};
const shellPane = (target) => {
  if (state.agents.some((agent) => agent.pane_id === target)) return undefined;
  if (!state.tabs.some((tab) => tab.root_pane_id === target)) return undefined;
  state.shells[target] = state.shells[target] || { composer: '', output: '' };
  return state.shells[target];
};
const findPane = (target) => {
  const found = state.agents.find(
    (candidate) => candidate.pane_id === target || candidate.name === target,
  );
  if (!found) {
    process.stderr.write('unknown pane target: ' + target);
    process.exit(95);
  }
  return found;
};
const ESC = String.fromCharCode(27);
const BOLD = ESC + '[1m';
const NORMAL = ESC + '[22m';
const DIM = ESC + '[2m';
const indent = (text) => text.replace(/\n/g, '\n  ');
const renderPane = (pane) => {
  const marker = pane.agent === 'claude' ? '❯' : '›';
  const transcript = (pane.submitted || [])
    .map((entry) => marker + ' ' + indent(entry) + '\nassistant response\n')
    .join('');
  const composer = pane.composer || '';
  if (pane.agent === 'claude') {
    return transcript + '❯ ' + indent(composer) + '\n' + '─'.repeat(40);
  }
  const body =
    composer.length === 0
      ? DIM + 'Improve documentation in @filename'
      : indent(composer);
  return (
    transcript + BOLD + '›' + NORMAL + ' ' + body + NORMAL + '\n\n' +
    '  ' + DIM + '100% context left · ? for shortcuts' + NORMAL
  );
};

if (args[0] === '--version') {
  log(readonlyLog, invocationArgs);
  process.stdout.write('herdr ' + version + '\n');
} else if (args[0] === 'status' && args[1] === 'server') {
  log(readonlyLog, invocationArgs);
  process.stdout.write(
    'status: running\nversion: ' + version +
    '\nprotocol: ${THRONE_HERDR_PROTOCOL}\ncompatible: yes\n' +
    'socket: /hermetic/.config/herdr/sessions/' + expectedSession + '/herdr.sock\n',
  );
} else if (args[0] === 'agent' && args[1] === 'list') {
  log(readonlyLog, invocationArgs);
  emit({ result: { agents: state.agents } });
} else if (args[0] === 'tab' && args[1] === 'list') {
  log(readonlyLog, invocationArgs);
  emit({
    result: {
      tabs: state.tabs.map((tab) => ({
        tab_id: tab.tab_id,
        label: tab.label,
        pane_count: tab.pane_count,
        workspace_id: 'canary',
      })),
    },
  });
} else if (args[0] === 'pane' && args[1] === 'list') {
  log(readonlyLog, invocationArgs);
  emit({ result: { panes: state.agents.map((agent) => ({
    pane_id: agent.pane_id,
    tab_id: agent.tab_id,
    terminal_id: agent.terminal_id,
    label: state.tabs.find((tab) => tab.tab_id === agent.tab_id)?.label,
    cwd: agent.cwd,
  })) } });
} else if (args[0] === 'agent' && args[1] === 'read') {
  log(readonlyLog, invocationArgs);
  emit({ result: { read: { text: renderPane(findPane(args[2])) } } });
} else if (args[0] === 'agent' && args[1] === 'prompt') {
  log(mutationLog, invocationArgs);
  const target = args[2];
  const text = args[3];
  const pane = state.agents.find((candidate) => candidate.name === target);
  if (!pane) {
    process.stderr.write('agent not found: ' + target);
    process.exit(93);
  }
  pane.submitted = [...(pane.submitted || []), text];
  save();
  emit({ result: { agent: { agent_status: pane.agent_status } } });
} else if (args[0] === 'pane' && args[1] === 'process-info') {
  log(readonlyLog, invocationArgs);
  const pane = findPane(args[args.indexOf('--pane') + 1]);
  emit({
    result: {
      process_info: {
        pane_id: pane.pane_id,
        foreground_processes: [{ name: pane.agent, argv: [pane.agent === 'codex' ? 'claude' : pane.agent] }],
      },
    },
  });
} else {
  log(mutationLog, invocationArgs);
  if (args[0] === 'tab' && args[1] === 'create') {
    const sequence = ++state.next;
    const label = args[args.indexOf('--label') + 1];
    const cwdIndex = args.indexOf('--cwd');
    const tab = {
      tab_id: 'canary-tab-' + sequence,
      label,
      pane_count: 1,
      cwd: cwdIndex === -1 ? '' : args[cwdIndex + 1],
      root_pane_id: 'canary-root-' + sequence,
    };
    state.tabs.push(tab);
    save();
    emit({
      result: {
        tab: { tab_id: tab.tab_id },
        root_pane: { pane_id: tab.root_pane_id },
      },
    });
  } else if (args[0] === 'pane' && args[1] === 'run') {
    const targetPane = args[2];
    const targetTab = state.tabs.find((tab) => tab.root_pane_id === targetPane);
    const cwd = targetTab?.cwd || process.cwd();
    const scriptPath = args[4];
    const scriptText = readFileSync(scriptPath, 'utf8');
    const kind = scriptText.includes('/codexy') ? 'codex' : 'claude';
    const launched = spawnSync(args[3], [scriptPath], {
      cwd,
      env: process.env,
      encoding: 'utf8',
    });
    if (launched.error || launched.status !== 0) {
      process.stderr.write(
        launched.error?.message || launched.stderr || 'fake launcher failed',
      );
      process.exit(98);
    }
    state.agents.push({
      agent: kind,
      name: targetTab?.label,
      composer: '',
      submitted: [],
      agent_status: 'idle',
      cwd: cwd.replace(/^\/var\/home\//, '/home/'),
      focused: false,
      pane_id: targetPane,
      tab_id: targetTab?.tab_id,
      terminal_id: 'terminal-' + state.next,
    });
    save();
    emit({ result: {} });
  } else if (args[0] === 'agent' && args[1] === 'rename') {
    const pane = findPane(args[2]);
    pane.name = args[3];
    save();
    emit({ result: {} });
  } else if (args[0] === 'pane' && args[1] === 'read') {
    const shell = shellPane(args[2]);
    const text = shell ? shell.output : renderPane(findPane(args[2]));
    emit({ result: { read: { text } } });
  } else if (args[0] === 'pane' && args[1] === 'wait-output') {
    const shell = shellPane(args[2]);
    const match = args[args.indexOf('--match') + 1];
    if (!shell || !shell.output.includes(match)) {
      process.stderr.write('no match');
      process.exit(1);
    }
    emit({ result: { output_matched: true } });
  } else if (args[0] === 'pane' && args[1] === 'send-text') {
    const shell = shellPane(args[2]);
    if (shell) {
      shell.composer += args[3];
      save();
      emit({ result: {} });
      process.exit(0);
    }
    const pane = findPane(args[2]);
    pane.composer = (pane.composer || '') + args[3];
    save();
    emit({ result: {} });
  } else if (args[0] === 'pane' && args[1] === 'send-keys') {
    const shell = shellPane(args[2]);
    if (shell) {
      if (args[3] === 'Enter' && shell.composer.length > 0) {
        // Execute the submitted printf exactly as a real shell would.
        const printf = /^printf '%s%s\\n' (\S+) (\S+)$/.exec(shell.composer.trim());
        if (printf) shell.output += printf[1] + printf[2] + '\n';
        shell.composer = '';
      }
      save();
      emit({ result: {} });
      process.exit(0);
    }
    const pane = findPane(args[2]);
    if (args[3] === 'Enter' && (pane.composer || '').length > 0) {
      pane.submitted = [...(pane.submitted || []), pane.composer];
      pane.composer = '';
      save();
    }
    emit({ result: {} });
  } else if (args[0] === 'pane' && args[1] === 'close') {
    emit({ result: {} });
  } else if (args[0] === 'tab' && args[1] === 'close') {
    const tabId = args[2];
    state.tabs = state.tabs.filter((tab) => tab.tab_id !== tabId);
    state.agents = state.agents.filter((agent) => agent.tab_id !== tabId);
    save();
    emit({ result: {} });
  } else {
    process.stderr.write('unexpected hermetic herdr invocation: ' + args.join(' '));
    process.exit(97);
  }
}
`;
  const herdrPath = ownedHerdrExecutablePath({}, homeDirectory);
  await mkdir(path.dirname(herdrPath), { recursive: true });
  await writeFile(herdrPath, herdr, 'utf8');
  await chmod(herdrPath, 0o755);

  const launcher = String.raw`#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import path from 'node:path';

appendFileSync(
  process.env.CANARY_LAUNCHER_LOG,
  JSON.stringify({
    launcher: path.basename(process.argv[1]),
    args: process.argv.slice(2),
    cwd: process.cwd(),
  }) + '\n',
);
`;
  for (const name of ['codexy', 'claude', 'claudey', 'claudey-all']) {
    const launcherPath = path.join(binDir, name);
    await writeFile(launcherPath, launcher, 'utf8');
    await chmod(launcherPath, 0o755);
  }
}
