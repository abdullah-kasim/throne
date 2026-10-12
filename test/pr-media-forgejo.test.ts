import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const publish = await import('../.claude/skills/pr-media/publish.mjs');

const forgejoPullRequestUrl = 'https://forge.example.test/court-admin/recipes/pulls/12';
const githubPullRequestUrl = 'https://github.com/example-bakery/recipes/pull/7';
const enterprisePullRequestUrl = 'https://github.bakery.test/example-bakery/recipes/pull/7';
const mediaFiles = ['01-cake-list-before.png', '01-cake-list-after.png', '02-cake-filter-click.mp4'];
const liveBody = '## What\n\nAdds a cake filter.\n\n## Testing\n\nOpen the list.';

const scratch: string[] = [];
after(async () => {
  for (const directory of scratch) await rm(directory, { recursive: true, force: true });
});

const fakeForgeSource = String.raw`#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const state = process.env.FAKE_FORGE_STATE;
const args = process.argv.slice(2);
appendFileSync(path.join(state, 'forge-calls.log'), JSON.stringify(args) + '\n');
const [, operation, ...rest] = args;
const valueOf = (name) => rest[rest.indexOf(name) + 1];
const assetsFile = path.join(state, 'assets.json');
const readAssets = () => (existsSync(assetsFile) ? JSON.parse(readFileSync(assetsFile, 'utf8')) : []);
if (operation === 'status') {
  console.log(readFileSync(path.join(state, 'status.json'), 'utf8'));
} else if (operation === 'pr' && rest[0] === 'view') {
  const body = readFileSync(path.join(state, 'body.md'), 'utf8');
  console.log(JSON.stringify({ number: 12, url: rest[1], title: 'Add a cake filter', body, state: 'OPEN', isDraft: true, headRefName: 'add/cake-filter', baseRefName: 'main' }));
} else if (operation === 'pr' && rest[0] === 'edit') {
  writeFileSync(path.join(state, 'body.md'), readFileSync(valueOf('--body-file'), 'utf8'));
  console.log(rest[1]);
} else if (operation === 'attach') {
  const counterFile = path.join(state, 'attachments.log');
  const file = valueOf('--file');
  appendFileSync(counterFile, path.basename(file) + '\n');
  const url = 'https://forge.example.test/attachments/uuid-' + readFileSync(counterFile, 'utf8').trim().split('\n').length;
  const name = path.basename(file, path.extname(file));
  const markdown = path.extname(file) === '.mp4' ? '<video src="' + url + '" title="' + name + '" controls></video>' : '![' + name + '](' + url + ')';
  writeFileSync(assetsFile, JSON.stringify([...readAssets(), { name: path.basename(file), url }]));
  console.log(JSON.stringify({ url, markdown }));
} else if (operation === 'detach') {
  const assets = readAssets();
  const kept = assets.filter((asset) => asset.url !== valueOf('--url'));
  writeFileSync(assetsFile, JSON.stringify(kept));
  console.log(JSON.stringify({ detached: kept.length < assets.length }));
} else {
  process.exit(2);
}
`;

function forgejoSide(url: string) {
  return { url, number: 12, state: 'OPEN', draft: true, base: 'main', head: 'add/cake-filter', headSha: 'c4ce0f1' };
}

function githubSide(url: string) {
  return { ...forgejoSide(url), number: 7, mergedAt: null, mergeCommit: null };
}

function pullRequestStatus(publishTo: 'forgejo' | 'github', forgejoTwinUrl: string | null = null) {
  const forgejoUrl = publishTo === 'forgejo' ? forgejoPullRequestUrl : forgejoTwinUrl;
  const github = publishTo === 'github' ? githubSide(githubPullRequestUrl) : null;
  const forgejo = forgejoUrl === null ? null : forgejoSide(forgejoUrl);
  return {
    target: { asked: 'fake', kind: `${publishTo}-url`, resolvedOn: publishTo, how: 'fake' },
    hostForge: 'forgejo',
    stage: github === null ? 'forgejo-only' : forgejo === null ? 'github-only' : 'promoted',
    forgejo,
    github,
    inSync: forgejo !== null && github !== null ? true : null,
    publishTo,
    mergeTarget: github === null ? null : { url: github.url, program: 'gh', forgejoUrl },
    mergeTargetRefusal: github === null ? 'not on GitHub yet' : null,
  };
}

async function writeExecutable(file: string, source: string) {
  await writeFile(file, source);
  await chmod(file, 0o755);
}

async function forgeWithMediaFolder(publishTo: 'forgejo' | 'github', names = mediaFiles) {
  const root = await mkdtemp(path.join(tmpdir(), 'pr-media-forgejo-'));
  scratch.push(root);
  const folder = path.join(root, 'pr-media-12');
  await mkdir(folder);
  for (const name of names) await writeFile(path.join(folder, name), 'media');
  await writeFile(path.join(root, 'body.md'), liveBody);
  await writeFile(path.join(root, 'status.json'), JSON.stringify(pullRequestStatus(publishTo)));
  const forgePath = path.join(root, 'throne');
  await writeExecutable(forgePath, fakeForgeSource);
  const ghPath = path.join(root, 'gh');
  await writeExecutable(
    ghPath,
    `#!/bin/sh\necho "$@" >> "${root}/gh-calls.log"\ncase "$1" in\n  --version) echo "gh version 2.99.0" ;;\n  repo) echo '{"nameWithOwner":"example-bakery/recipes","url":"https://github.com/example-bakery/recipes"}' ;;\n  pr) case "$2" in view) cat "${root}/body.md" ;; edit) sed -E 's#\\./([^)# ]+)#https://github.com/user-attachments/assets/\\1#g' "$7" > "${root}/body.md" ;; esac ;;\nesac\nexit 0\n`,
  );
  const browserPath = path.join(root, 'agent-browser');
  await writeExecutable(browserPath, `#!/bin/sh\necho "$@" >> "${root}/browser-calls.log"\nexit 1\n`);
  process.env.FAKE_FORGE_STATE = root;
  process.env.AGENT_BROWSER = browserPath;
  return {
    root,
    folder,
    forge: { path: forgePath },
    gh: { path: ghPath, bypassArguments: [] },
    calls: async (name: 'forge' | 'gh' | 'browser') => {
      const log = await readFile(path.join(root, `${name}-calls.log`), 'utf8').catch(() => '');
      return log.trim() ? log.trim().split('\n') : [];
    },
    body: () => readFile(path.join(root, 'body.md'), 'utf8'),
    assets: async (): Promise<Array<{ name: string; url: string }>> => JSON.parse(await readFile(path.join(root, 'assets.json'), 'utf8')),
  };
}

function anchor(name: string, reference: string) {
  return `<!-- pr-media: ${name} -->\n${reference}\n<!-- /pr-media: ${name} -->`;
}

test('publishing media to a Forgejo pull request uploads every image and video as attachments and rewrites the body', async () => {
  const fixture = await forgeWithMediaFolder('forgejo');
  const result = publish.publish(publish.parseArguments([forgejoPullRequestUrl, '--folder', fixture.folder]), fixture.gh, fixture.forge);
  const forgeCalls = (await fixture.calls('forge')).map((line) => JSON.parse(line));
  const attached = forgeCalls.filter((args) => args[1] === 'attach');
  assert.deepEqual(
    attached,
    ['01-cake-list-before.png', '01-cake-list-after.png', '02-cake-filter-click.mp4'].map((name) => [
      'forge', 'attach', forgejoPullRequestUrl, '--file', path.join(fixture.folder, name),
    ]),
  );
  assert.deepEqual(forgeCalls.filter((args) => args[1] === 'pr').map((args) => args.slice(0, 3)), [
    ['forge', 'pr', 'view'],
    ['forge', 'pr', 'edit'],
    ['forge', 'pr', 'view'],
  ]);
  const published = await fixture.body();
  assert.ok(published.startsWith('## What\n\nAdds a cake filter.\n\n## Screenshots\n\n'));
  assert.ok(published.includes(anchor('01-cake-list-before.png', '![01-cake-list-before](https://forge.example.test/attachments/uuid-1)')));
  assert.ok(published.includes(anchor('01-cake-list-after.png', '![01-cake-list-after](https://forge.example.test/attachments/uuid-2)')));
  assert.ok(
    published.includes(
      anchor('02-cake-filter-click.mp4', '<video src="https://forge.example.test/attachments/uuid-3" title="02-cake-filter-click" controls></video>'),
    ),
  );
  assert.ok(published.trimEnd().endsWith('## Testing\n\nOpen the list.'));
  assert.deepEqual([...result.urls.values()], [1, 2, 3].map((number) => `https://forge.example.test/attachments/uuid-${number}`));
  await assert.rejects(readFile(path.join(fixture.folder, 'live.md')));
});

test('publishing to a Forgejo pull request never opens a browser or calls gh', async () => {
  const fixture = await forgeWithMediaFolder('forgejo');
  publish.publish(publish.parseArguments([forgejoPullRequestUrl, '--folder', fixture.folder]), fixture.gh, fixture.forge);
  publish.publish(publish.parseArguments(['12', '--folder', fixture.folder, '--replace-all']), fixture.gh, fixture.forge);
  const dryRun = publish.publish(publish.parseArguments([forgejoPullRequestUrl, '--folder', fixture.folder, '--dry-run']), fixture.gh, fixture.forge);
  assert.match(dryRun.summary, /^3 file\(s\) would be uploaded as Forgejo attachments before the edit$/m);
  assert.match(dryRun.commandLine, /^throne forge pr edit https:\/\/forge\.example\.test\/court-admin\/recipes\/pulls\/12 --body-file /);
  for (const manualUpload of [['--wizard'], ['--collect'], ['--asset', '01-cake-list-before.png=https://forge.example.test/attachments/x']]) {
    assert.throws(
      () => publish.publish(publish.parseArguments([forgejoPullRequestUrl, '--folder', fixture.folder, ...manualUpload]), fixture.gh, fixture.forge),
      /is a Forgejo pull request, where publish uploads every file through the Forgejo attachment API/,
    );
  }
  assert.deepEqual(await fixture.calls('gh'), []);
  assert.deepEqual(await fixture.calls('browser'), []);
  assert.equal((await fixture.calls('forge')).filter((line) => line.includes('"attach"')).length, 6);
});

test('publishing the same media to a Forgejo pull request twice leaves each file attached once', async () => {
  const fixture = await forgeWithMediaFolder('forgejo');
  const pastedDiagram = { name: 'oven-diagram.png', url: 'https://forge.example.test/attachments/uuid-pasted' };
  const neverEmbedded = { name: 'notes.pdf', url: 'https://forge.example.test/attachments/uuid-loose' };
  await writeFile(path.join(fixture.root, 'assets.json'), JSON.stringify([pastedDiagram, neverEmbedded]));
  await writeFile(path.join(fixture.root, 'body.md'), `${liveBody}\n\n![oven-diagram](${pastedDiagram.url})`);
  publish.publish(publish.parseArguments([forgejoPullRequestUrl, '--folder', fixture.folder]), fixture.gh, fixture.forge);
  const second = publish.publish(publish.parseArguments([forgejoPullRequestUrl, '--folder', fixture.folder]), fixture.gh, fixture.forge);
  const published = await fixture.body();
  assert.deepEqual(publish.anchorNamesIn(published), mediaFiles);
  assert.equal(published.match(/attachments\/uuid-\d/g)?.length, 3);
  assert.ok(published.includes('attachments/uuid-4') && published.includes('attachments/uuid-6'));
  assert.doesNotMatch(published, /uuid-[123]\b/);
  assert.match(second.summary, /^replacing: 01-cake-list-before\.png, 01-cake-list-after\.png, 02-cake-filter-click\.mp4$/m);
  assert.deepEqual(
    (await fixture.assets()).map((asset) => asset.name).sort(),
    [...mediaFiles, pastedDiagram.name, neverEmbedded.name].sort(),
  );
  assert.deepEqual((await fixture.assets()).filter((asset) => mediaFiles.includes(asset.name)).map((asset) => asset.url), [4, 5, 6].map((number) => `https://forge.example.test/attachments/uuid-${number}`));
  assert.ok(published.includes(pastedDiagram.url));
});

test('publishing to a GitHub pull request is unchanged', async () => {
  const fixture = await forgeWithMediaFolder('github');
  const result = publish.publish(publish.parseArguments([githubPullRequestUrl, '--folder', fixture.folder]), fixture.gh, fixture.forge);
  assert.deepEqual(await fixture.calls('forge'), []);
  assert.deepEqual(await fixture.calls('gh'), [
    'pr view 7 -R github.com/example-bakery/recipes --json body -q .body',
    '--version',
    'pr edit 7 -R github.com/example-bakery/recipes --body-file live.md --attach ./01-cake-list-before.png#cake list before --attach ./01-cake-list-after.png#cake list after --attach ./02-cake-filter-click.mp4',
    'pr view 7 -R github.com/example-bakery/recipes --json body -q .body',
  ]);
  assert.match(result.summary, /^adding to ## Screenshots: 01-cake-list-before\.png, 01-cake-list-after\.png, 02-cake-filter-click\.mp4$/m);

  const byNumber = await forgeWithMediaFolder('github');
  const dryRun = publish.publish(publish.parseArguments(['7', '--folder', byNumber.folder, '--dry-run']), byNumber.gh, byNumber.forge);
  assert.deepEqual(await byNumber.calls('forge'), [JSON.stringify(['forge', 'status', '7', '--json'])]);
  assert.deepEqual(await byNumber.calls('gh'), [
    'repo view --json nameWithOwner,url',
    'pr view 7 -R github.com/example-bakery/recipes --json body -q .body',
    '--version',
  ]);
  assert.equal(
    dryRun.commandLine,
    "gh pr edit 7 -R github.com/example-bakery/recipes --body-file live.md --attach './01-cake-list-before.png#cake list before' --attach './01-cake-list-after.png#cake list after' --attach ./02-cake-filter-click.mp4",
  );
  assert.deepEqual(await byNumber.calls('browser'), []);
});

test('pr-media publishes a GitHub pull request that has a Forgejo twin to GitHub (the PR 218 case)', async () => {
  const fixture = await forgeWithMediaFolder('github');
  await writeFile(path.join(fixture.root, 'status.json'), JSON.stringify(pullRequestStatus('github', forgejoPullRequestUrl)));
  const dryRun = publish.publish(publish.parseArguments([enterprisePullRequestUrl, '--folder', fixture.folder, '--dry-run']), fixture.gh, fixture.forge);
  assert.match(dryRun.summary, /^3 file\(s\) would be uploaded through the signed-in browser before the edit$/m);
  assert.match(dryRun.commandLine, /^gh pr edit 7 -R github\.bakery\.test\/example-bakery\/recipes --body-file live\.md$/);
  assert.throws(() => publish.publish(publish.parseArguments([enterprisePullRequestUrl, '--folder', fixture.folder]), fixture.gh, fixture.forge));
  assert.ok((await fixture.calls('browser')).length > 0);
  assert.deepEqual((await fixture.calls('forge')).map((line) => JSON.parse(line)[1]), ['status', 'status']);
  assert.deepEqual(await fixture.calls('gh'), [
    'pr view 7 -R github.bakery.test/example-bakery/recipes --json body -q .body',
    'pr view 7 -R github.bakery.test/example-bakery/recipes --json body -q .body',
  ]);
  assert.equal(await fixture.body(), liveBody);
});
