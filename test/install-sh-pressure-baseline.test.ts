import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const COMPILE_STEP = 'step "Compile"';
const COMPILED_ENTRYPOINT_CHECK = '[ -f dist/src/tools.js ] || die';
const PRESSURE_BASELINE_STEP = 'step "Pressure baseline"';
const HARNESSES_STEP = 'step "Harnesses (claude, codex)"';
const FORM_BASELINE_COMMAND = 'node ./dist/src/tools.js resource-pressure --form-baseline';
const WARNING_MARKER = '\u001b[33m!\u001b[0m';
const INSTALL_CONTINUED = 'install continued';

const scratch: string[] = [];
after(async () => {
  for (const directory of scratch) await rm(directory, { recursive: true, force: true });
});

async function installScript(): Promise<string> {
  return readFile(path.join(REPO_ROOT, 'install.sh'), 'utf8');
}

function positionOf(source: string, text: string): number {
  const position = source.indexOf(text);
  assert.notEqual(position, -1, `install.sh is missing ${text}`);
  return position;
}

function pressureBaselineStep(source: string): string {
  return source.slice(positionOf(source, PRESSURE_BASELINE_STEP), positionOf(source, HARNESSES_STEP));
}

function printingHelpers(source: string): string {
  return source
    .split('\n')
    .filter((line) => /^(step|warn)\(\)/.test(line))
    .join('\n');
}

async function folderWithRefusingNode(): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), 'install-pressure-baseline-'));
  scratch.push(folder);
  const fakeNode = path.join(folder, 'node');
  await writeFile(fakeNode, '#!/bin/sh\necho "disk busy 60% — the machine is not quiet"\nexit 1\n');
  await chmod(fakeNode, 0o755);
  return folder;
}

test('the install runs the pressure baseline step after compiling and before the court starts', async () => {
  const source = await installScript();
  const compile = positionOf(source, COMPILE_STEP);
  const compiledEntrypointCheck = positionOf(source, COMPILED_ENTRYPOINT_CHECK);
  const pressureBaseline = positionOf(source, PRESSURE_BASELINE_STEP);
  const harnesses = positionOf(source, HARNESSES_STEP);

  assert.ok(compile < compiledEntrypointCheck);
  assert.ok(compiledEntrypointCheck < pressureBaseline);
  assert.ok(pressureBaseline < harnesses);
  assert.ok(pressureBaselineStep(source).includes(FORM_BASELINE_COMMAND));
  assert.doesNotMatch(pressureBaselineStep(source), /\bdie\b/);
});

test('a refused pressure baseline prints one warning and does not fail the install', async () => {
  const source = await installScript();
  const fakeBin = await folderWithRefusingNode();
  const script = [
    'set -euo pipefail',
    printingHelpers(source),
    pressureBaselineStep(source),
    `echo "${INSTALL_CONTINUED}"`,
  ].join('\n');

  const { stdout } = await execFileAsync('bash', ['-c', script], {
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
  });

  const warnings = stdout.split('\n').filter((line) => line.includes(WARNING_MARKER));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /form on its own from quiet moments/);
  assert.ok(stdout.includes(INSTALL_CONTINUED));
});
