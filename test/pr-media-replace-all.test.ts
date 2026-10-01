import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const publish = await import('../.claude/skills/pr-media/publish.mjs');

const pullRequestUrl = 'https://github.com/example-bakery/recipes/pull/7';
const newFiles = ['01-cake-list-before.png', '01-cake-list-after.png'];

const scratch: string[] = [];
after(async () => {
  for (const directory of scratch) await rm(directory, { recursive: true, force: true });
});

function anchor(name: string, reference: string) {
  return `<!-- pr-media: ${name} -->\n${reference}\n<!-- /pr-media: ${name} -->`;
}

const oldHowAnchor = anchor('01-old-view-after.png', '![old view after](https://github.com/user-attachments/assets/OLD-HOW)');
const oldScreenshotsAnchor = anchor('02-old-basket-after.png', '![old basket after](https://github.com/user-attachments/assets/OLD-BASKET)');

async function refreshFolderWithStubGh(liveBody: string, { withDraft }: { withDraft: boolean }) {
  const root = await mkdtemp(path.join(tmpdir(), 'pr-media-replace-all-'));
  scratch.push(root);
  const folder = path.join(root, 'pr-media-7-v2');
  await mkdir(folder);
  for (const name of newFiles) await writeFile(path.join(folder, name), 'png');
  if (withDraft) {
    const draft = ['## Screenshots', '', 'The cake list, filtered:', '', ...newFiles.map((name) => anchor(name, `![x](./${name})`))].join('\n');
    await writeFile(path.join(folder, 'screenshots.md'), draft);
  }
  const bodyFile = path.join(root, 'live-body.md');
  await writeFile(bodyFile, liveBody);
  const ghPath = path.join(root, 'gh');
  await writeFile(ghPath, `#!/bin/sh\ncase "$1" in\n  --version) echo "gh version 2.99.0" ;;\n  pr) [ "$2" = view ] && cat "${bodyFile}" ;;\nesac\nexit 0\n`);
  await chmod(ghPath, 0o755);
  return { folder, gh: { path: ghPath, bypassArguments: [] } };
}

function publishOptions(folder: string, overrides: Record<string, unknown> = {}) {
  return { ...publish.parseArguments([pullRequestUrl, '--folder', folder, '--dry-run']), ...overrides };
}

const bodyWithOldCaptures = [
  '## What',
  '',
  'Adds a cake filter to the recipe list.',
  '',
  '## How',
  '',
  'The filter reads the recipe tag.',
  '',
  oldHowAnchor,
  '',
  '## Screenshots',
  '',
  oldScreenshotsAnchor,
  '',
  '<!-- drop 03-old-oven.png here -->',
  '',
  '## Testing',
  '',
  'Open the recipe list.',
].join('\n');

test('a refresh publish removes an earlier capture\'s anchor that the new folder does not carry, and names it', async () => {
  const { folder, gh } = await refreshFolderWithStubGh(bodyWithOldCaptures, { withDraft: false });
  const result = publish.publish(publishOptions(folder, { replaceAll: true }), gh);
  assert.deepEqual(publish.anchorNamesIn(result.body), newFiles);
  assert.doesNotMatch(result.body, /old-view|old-basket|old-oven|OLD-/);
  assert.match(result.summary, /^removed, not in the folder: 01-old-view-after\.png, 02-old-basket-after\.png, 03-old-oven\.png$/m);
  assert.doesNotMatch(result.summary, /left untouched/);
  assert.doesNotMatch(result.body, /\n\n\n/);
});

test('a refresh publish removes an earlier anchor that sits outside the Screenshots section', async () => {
  const { folder, gh } = await refreshFolderWithStubGh(bodyWithOldCaptures, { withDraft: true });
  const result = publish.publish(publishOptions(folder, { replaceAll: true }), gh);
  assert.match(result.body, /## How\n\nThe filter reads the recipe tag\.\n\n## Screenshots\n\nThe cake list, filtered:/);
  assert.deepEqual(publish.anchorNamesIn(result.body), newFiles);
  assert.match(result.summary, /^removed, not in the folder: 01-old-view-after\.png$/m);
});

test('without --replace-all an earlier capture\'s anchor is left in place and reported, as before', async () => {
  const { folder, gh } = await refreshFolderWithStubGh(bodyWithOldCaptures, { withDraft: true });
  const result = publish.publish(publishOptions(folder), gh);
  assert.ok(result.body.includes(`The filter reads the recipe tag.\n\n${oldHowAnchor}\n\n## Screenshots`));
  assert.match(result.summary, /^left untouched, no such file in the folder: 01-old-view-after\.png$/m);
  assert.doesNotMatch(result.summary, /removed, not in the folder/);
});

test('after a refresh publish, verification fails when an anchor outside the folder survived in the live body', async () => {
  const publishedBody = [
    '## How',
    '',
    oldHowAnchor,
    '',
    '## Screenshots',
    '',
    ...newFiles.map((name) => anchor(name, `![x](https://github.com/user-attachments/assets/${name})`)),
  ].join('\n');
  const { folder, gh } = await refreshFolderWithStubGh(publishedBody, { withDraft: false });
  const files = newFiles.map((name) => ({ name, kind: 'image' }));
  assert.deepEqual(publish.verifyPublishedBody(publishedBody, files).failures, []);
  assert.throws(
    () => publish.publish(publishOptions(folder, { dryRun: false, replaceAll: true }), gh),
    /published body failed verification:\n01-old-view-after\.png: anchor outside the folder survived in the published body$/,
  );
});
