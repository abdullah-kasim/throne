import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const publish = await import('../.claude/skills/pr-media/publish.mjs');

const pullRequestUrl = 'https://github.com/example-bakery/recipes/pull/9';
const stills = ['01-cake-list-before.png', '01-cake-list-after.png'];
const noVideoRefusal = /holds no video[\s\S]*every interaction the PR changes is recorded as a video[\s\S]*--stills-only "<reason>"/;

const scratch: string[] = [];
after(async () => {
  for (const directory of scratch) await rm(directory, { recursive: true, force: true });
});

async function folderWithStubGh(names: string[]) {
  const root = await mkdtemp(path.join(tmpdir(), 'pr-media-video-required-'));
  scratch.push(root);
  const folder = path.join(root, 'pr-media-9');
  await mkdir(folder);
  for (const name of names) await writeFile(path.join(folder, name), 'media');
  const bodyFile = path.join(root, 'live-body.md');
  await writeFile(bodyFile, '## What\n\nAdds a cake filter.\n\n## Testing\n\nOpen the list.');
  const callLog = path.join(root, 'gh-calls.log');
  const ghPath = path.join(root, 'gh');
  await writeFile(ghPath, `#!/bin/sh\necho "$@" >> "${callLog}"\ncase "$1" in\n  --version) echo "gh version 2.99.0" ;;\n  pr) [ "$2" = view ] && cat "${bodyFile}" ;;\nesac\nexit 0\n`);
  await chmod(ghPath, 0o755);
  return { folder, callLog, gh: { path: ghPath, bypassArguments: [] } };
}

async function ghCalls(callLog: string) {
  const log = await readFile(callLog, 'utf8').catch(() => '');
  return log.trim() ? log.trim().split('\n') : [];
}

test('a media folder of stills alone is refused, and the refusal names --stills-only', async () => {
  const { folder, gh } = await folderWithStubGh(stills);
  assert.throws(() => publish.publish(publish.parseArguments([pullRequestUrl, '--folder', folder, '--dry-run']), gh), noVideoRefusal);
});

test('the no-video refusal comes before any upload in publish, --wizard, --collect and --dry-run alike', async () => {
  for (const mode of [[], ['--wizard'], ['--collect'], ['--dry-run']]) {
    const { folder, callLog, gh } = await folderWithStubGh(stills);
    assert.throws(() => publish.publish(publish.parseArguments([pullRequestUrl, '--folder', folder, ...mode]), gh), noVideoRefusal, `mode ${mode.join(' ') || 'publish'}`);
    assert.deepEqual(await ghCalls(callLog), [], `mode ${mode.join(' ') || 'publish'} called gh`);
    await assert.rejects(access(path.join(folder, 'live.md')));
  }
});

test('--stills-only with a reason lets a stills folder publish in dry-run and the summary prints the reason', async () => {
  const { folder, gh } = await folderWithStubGh(stills);
  const result = publish.publish(publish.parseArguments([pullRequestUrl, '--folder', folder, '--dry-run', '--stills-only', 'copy change only']), gh);
  assert.equal(result.dryRun, true);
  assert.deepEqual(publish.anchorNamesIn(result.body), stills);
  assert.match(result.summary, /^stills only: copy change only$/m);
});

test('--stills-only with an empty reason is refused', () => {
  for (const reasonArguments of [[''], ['   '], [], ['--dry-run']]) {
    assert.throws(
      () => publish.parseArguments([pullRequestUrl, '--stills-only', ...reasonArguments]),
      /--stills-only needs a reason/,
      `--stills-only ${JSON.stringify(reasonArguments)}`,
    );
  }
});

test('a media folder with one video publishes without --stills-only', async () => {
  const { folder, gh } = await folderWithStubGh([...stills, '02-cake-filter-click.mp4']);
  const result = publish.publish(publish.parseArguments([pullRequestUrl, '--folder', folder, '--dry-run']), gh);
  assert.equal(result.dryRun, true);
  assert.deepEqual(publish.anchorNamesIn(result.body), [...stills, '02-cake-filter-click.mp4']);
  assert.doesNotMatch(result.summary, /stills only/);
});
