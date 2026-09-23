import assert from 'node:assert/strict';
import { accessSync, constants, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SKILLS_DIRECTORY = path.join(REPO_ROOT, '.claude', 'skills');
const REVIEW_SKILLS = ['pr-description', 'pr-media', 'agent-browser'] as const;

function skillSource(name: string): string {
  return readFileSync(path.join(SKILLS_DIRECTORY, name, 'SKILL.md'), 'utf8');
}

function frontmatterName(source: string): string | undefined {
  const match = /^---\n(?:.*\n)*?name:\s*(\S+)\n(?:.*\n)*?---\n/.exec(source);
  return match?.[1];
}

for (const name of REVIEW_SKILLS) {
  test(`${name} ships in the throne with frontmatter naming itself`, () => {
    assert.equal(frontmatterName(skillSource(name)), name);
  });

  test(`${name} carries no operator-private tracker or host names`, () => {
    const source = skillSource(name);
    const internalHostFragment = ['a', '8', 'c'].join('');
    assert.doesNotMatch(source, new RegExp(`linear\\.app/${internalHostFragment}`));
    assert.doesNotMatch(source, new RegExp(`github\\.${internalHostFragment}\\.com`));
    assert.doesNotMatch(source, /~\/\.claude\/skills/);
  });
}

test('pr-media addresses its capture helpers through THRONE_LIVE_ROOT, the variable every court tab exports', () => {
  const source = skillSource('pr-media');
  assert.match(source, /\$THRONE_LIVE_ROOT\/\.claude\/skills\/pr-media\/cursor-overlay\.js/);
  assert.match(source, /\$THRONE_LIVE_ROOT\/\.claude\/skills\/pr-media\/glide\.sh/);
});

const PR_MEDIA_HELPERS = ['cursor-overlay.js', 'glide.sh', 'media-folder.mjs', 'contact-sheet.mjs', 'publish.mjs'] as const;

test('pr-media ships every helper readable and every script executable', () => {
  for (const helper of PR_MEDIA_HELPERS) {
    assert.doesNotThrow(() => accessSync(path.join(SKILLS_DIRECTORY, 'pr-media', helper), constants.R_OK), helper);
  }
  for (const script of ['glide.sh', 'contact-sheet.mjs', 'publish.mjs']) {
    assert.doesNotThrow(() => accessSync(path.join(SKILLS_DIRECTORY, 'pr-media', script), constants.X_OK), script);
  }
});

test('pr-media documents the publish mode, the contact sheet, both anchor markers, the GHES fallback and the bypass rule', () => {
  const source = skillSource('pr-media');
  assert.match(source, /^## 4\. Publish$/m);
  assert.match(source, /\/pr-media publish <pr-url\|number> \[--folder <dir>\] \[--dry-run\]/);
  assert.match(source, /\$THRONE_LIVE_ROOT\/\.claude\/skills\/pr-media\/publish\.mjs/);
  assert.match(source, /\$THRONE_LIVE_ROOT\/\.claude\/skills\/pr-media\/contact-sheet\.mjs/);
  assert.match(source, /--attach/);
  assert.match(source, /index\.html/);
  assert.match(source, /<!-- pr-media: <name> -->/);
  assert.match(source, /<!-- \/pr-media: <name> -->/);
  assert.match(source, /<!-- drop <name> here -->/);
  assert.match(source, /GitHub Enterprise Server fallback/);
  assert.match(source, /--asset <name>=<url>/);
  assert.match(source, /the upload wizard/);
  assert.match(source, /--wizard/);
  assert.match(source, /--collect/);
  assert.match(source, /Update comment/);
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /"Uploaded and saved"/);
  assert.match(source, /The `--bypass` rule/);
  assert.match(source, /brew upgrade gh/);
  assert.match(source, /gh pr view <n> --json\s+body -q \.body > live\.md/);
  assert.match(source, /drop landing outside the Screenshots spoiler is fine/);
  assert.doesNotMatch(source, /sentinel/i);
});

test('wizardInstructions states that a drop outside the Screenshots spoiler is fine', async () => {
  const { wizardInstructions } = await import(path.join(SKILLS_DIRECTORY, 'pr-media', 'publish.mjs'));
  const instructions = wizardInstructions({ host: 'github.example.test', owner: 'o', repo: 'r', number: '9' }, [
    { name: '01-a-shot.png', kind: 'image' },
  ]);
  assert.match(instructions, /drop landing outside the Screenshots spoiler is fine/);
});

test('publish rewrites anchors in place, converts old placeholders, appends new files and leaves orphans alone', async () => {
  const { rewriteBody, verifyPublishedBody } = await import(
    path.join(SKILLS_DIRECTORY, 'pr-media', 'publish.mjs')
  );
  const files = [
    { name: 'blue-shot.png', kind: 'image' },
    { name: 'click-clip.mp4', kind: 'video' },
    { name: 'red-shot.png', kind: 'image' },
  ];
  const body = [
    '## How',
    '- mechanism',
    '',
    '## Screenshots',
    '',
    'Blue, hovered:',
    '',
    '<!-- pr-media: blue-shot.png -->',
    '![blue shot](https://github.com/user-attachments/assets/old-blue)',
    '<!-- /pr-media: blue-shot.png -->',
    '',
    '<!-- drop click-clip.mp4 here -->',
    '',
    '<!-- pr-media: gone-shot.png -->',
    'https://github.com/user-attachments/assets/gone',
    '<!-- /pr-media: gone-shot.png -->',
    '',
    '## Testing',
    'steps',
  ].join('\n');

  const rewrite = rewriteBody(body, files);
  assert.deepEqual(rewrite.replaced, ['blue-shot.png']);
  assert.deepEqual(rewrite.converted, ['click-clip.mp4']);
  assert.deepEqual(rewrite.appended, ['red-shot.png']);
  assert.deepEqual(rewrite.orphans, ['gone-shot.png']);
  assert.match(rewrite.body, /<!-- pr-media: blue-shot\.png -->\n!\[blue shot\]\(\.\/blue-shot\.png\)\n<!-- \/pr-media: blue-shot\.png -->/);
  assert.match(rewrite.body, /<!-- pr-media: click-clip\.mp4 -->\n!\[click clip\]\(\.\/click-clip\.mp4\)\n<!-- \/pr-media: click-clip\.mp4 -->/);
  assert.doesNotMatch(rewrite.body, /old-blue|drop click-clip/);
  assert.match(rewrite.body, /assets\/gone/);
  assert.match(rewrite.body, /Blue, hovered:/);
  assert.ok(rewrite.body.indexOf('<!-- pr-media: red-shot.png -->') < rewrite.body.indexOf('## Testing'));
  assert.ok(rewrite.body.indexOf('<!-- pr-media: red-shot.png -->') > rewrite.body.indexOf('## Screenshots'));

  const unpublished = verifyPublishedBody(rewrite.body, files);
  assert.equal(unpublished.failures.length, 3);
  const published = rewrite.body
    .replace('(./blue-shot.png)', '(https://github.com/user-attachments/assets/new-blue)')
    .replace('![click clip](./click-clip.mp4)', 'https://github.com/user-attachments/assets/new-clip')
    .replace('(./red-shot.png)', '(https://github.com/user-attachments/assets/new-red)');
  const halfRewritten = published.replace(
    '<!-- /pr-media: red-shot.png -->',
    '![red shot](./red-shot.png)\n<!-- /pr-media: red-shot.png -->',
  );
  assert.deepEqual(verifyPublishedBody(halfRewritten, files).failures, ['red-shot.png: anchor pair still carries the local path']);
  const verified = verifyPublishedBody(published, files);
  assert.deepEqual(verified.failures, []);
  assert.deepEqual([...verified.urls.values()], [
    'https://github.com/user-attachments/assets/new-blue',
    'https://github.com/user-attachments/assets/new-clip',
    'https://github.com/user-attachments/assets/new-red',
  ]);
});

test('collect maps loose GHES uploads to files by image stem and video order, removes them and fills the anchors', async () => {
  const { collectLooseUploads, mapUploadsToFiles, removeLooseUploads, rewriteBody, assetReference, verifyPublishedBody } = await import(
    path.join(SKILLS_DIRECTORY, 'pr-media', 'publish.mjs')
  );
  const files = [
    { name: 'a-shot.png', kind: 'image' },
    { name: 'b-shot.png', kind: 'image' },
    { name: 'clip-one.mp4', kind: 'video' },
    { name: 'clip-two.mp4', kind: 'video' },
  ];
  const body = [
    '## Screenshots',
    '',
    '<!-- drop a-shot.png here -->',
    '',
    '<img width="393" height="852" alt="b-shot" src="https://ghe.example/user-attachments/assets/B" />',
    '',
    'https://ghe.example/user-attachments/assets/V1',
    '',
    '<img width="1" height="1" alt="a-shot" src="https://ghe.example/user-attachments/assets/A" />',
    '',
    'https://ghe.example/user-attachments/assets/V2',
    '',
    '<!-- pr-media: kept.png -->',
    '![kept](https://ghe.example/user-attachments/assets/KEPT)',
    '<!-- /pr-media: kept.png -->',
    '',
    '## Testing',
    'x',
    '',
  ].join('\n');
  const uploads = collectLooseUploads(body);
  assert.deepEqual(uploads.map((upload) => upload.url.split('/').pop()), ['B', 'V1', 'A', 'V2']);
  const mapping = mapUploadsToFiles(uploads, files);
  assert.deepEqual([...mapping.assets], [
    ['b-shot.png', 'https://ghe.example/user-attachments/assets/B'],
    ['a-shot.png', 'https://ghe.example/user-attachments/assets/A'],
    ['clip-one.mp4', 'https://ghe.example/user-attachments/assets/V1'],
    ['clip-two.mp4', 'https://ghe.example/user-attachments/assets/V2'],
  ]);
  assert.deepEqual(mapping.missing, []);
  const rewrite = rewriteBody(removeLooseUploads(body, uploads), files, (file) => assetReference(file, mapping.assets.get(file.name)));
  assert.equal(verifyPublishedBody(rewrite.body, files).failures.length, 0);
  assert.doesNotMatch(rewrite.body, /<img /);
  assert.match(rewrite.body, /<!-- pr-media: a-shot\.png -->\n!\[a shot\]\(https:\/\/ghe\.example\/user-attachments\/assets\/A\)\n<!-- \/pr-media: a-shot\.png -->/);
  assert.match(rewrite.body, /<!-- pr-media: clip-two\.mp4 -->\nhttps:\/\/ghe\.example\/user-attachments\/assets\/V2\n<!-- \/pr-media: clip-two\.mp4 -->/);
  assert.match(rewrite.body, /assets\/KEPT/);
  assert.deepEqual(rewrite.orphans, ['kept.png']);
  const crlfBody = 'a\r\n\r\n<img alt="b-shot" src="https://ghe.example/user-attachments/assets/B" />\r\n\r\n\r\nb\r\n';
  const crlfUploads = collectLooseUploads(crlfBody);
  assert.equal(removeLooseUploads(crlfBody, crlfUploads), 'a\n\nb\r\n');
});

test('publish creates the Screenshots section before Testing when the body has none', async () => {
  const { rewriteBody } = await import(path.join(SKILLS_DIRECTORY, 'pr-media', 'publish.mjs'));
  const rewrite = rewriteBody('## What\nx\n\n## Testing\nsteps\n', [{ name: 'a-shot.png', kind: 'image' }]);
  assert.match(rewrite.body, /## What\nx\n\n## Screenshots\n\n<!-- pr-media: a-shot\.png -->\n!\[a shot\]\(\.\/a-shot\.png\)\n<!-- \/pr-media: a-shot\.png -->\n\n## Testing\nsteps/);
});

test('an anchor appended to a Screenshots section already wrapped in details lands before the closing tag', async () => {
  const { rewriteBody } = await import(path.join(SKILLS_DIRECTORY, 'pr-media', 'publish.mjs'));
  const body = [
    '## How',
    '- mechanism',
    '',
    '## Screenshots',
    '',
    '<details>',
    '<summary>Screenshots</summary>',
    '',
    '<!-- pr-media: blue-shot.png -->',
    '![blue shot](./blue-shot.png)',
    '<!-- /pr-media: blue-shot.png -->',
    '',
    '</details>',
    '',
    '## Testing',
    'steps',
  ].join('\n');

  const rewrite = rewriteBody(body, [
    { name: 'blue-shot.png', kind: 'image' },
    { name: 'red-shot.png', kind: 'image' },
  ]);
  assert.deepEqual(rewrite.appended, ['red-shot.png']);
  const detailsClose = rewrite.body.indexOf('</details>');
  const redAnchor = rewrite.body.indexOf('<!-- pr-media: red-shot.png -->');
  const testingHeading = rewrite.body.indexOf('## Testing');
  assert.ok(redAnchor > 0 && redAnchor < detailsClose, 'red-shot anchor must land before </details>');
  assert.ok(detailsClose < testingHeading, '</details> must stay before ## Testing');
});

test('a legacy Screenshots section with no details wrapper still appends at the end, and publish never adds a wrapper on its own', async () => {
  const { rewriteBody } = await import(path.join(SKILLS_DIRECTORY, 'pr-media', 'publish.mjs'));
  const body = [
    '## Screenshots',
    '',
    '<!-- pr-media: blue-shot.png -->',
    '![blue shot](./blue-shot.png)',
    '<!-- /pr-media: blue-shot.png -->',
    '',
    '## Testing',
    'steps',
  ].join('\n');

  const rewrite = rewriteBody(body, [
    { name: 'blue-shot.png', kind: 'image' },
    { name: 'red-shot.png', kind: 'image' },
  ]);
  assert.deepEqual(rewrite.appended, ['red-shot.png']);
  assert.doesNotMatch(rewrite.body, /<details>|<\/details>/);
  const redAnchor = rewrite.body.indexOf('<!-- pr-media: red-shot.png -->');
  const testingHeading = rewrite.body.indexOf('## Testing');
  assert.ok(redAnchor > 0 && redAnchor < testingHeading);
});

test('publish replaces a Screenshots section from a wrapped draft even when the body has neither a Screenshots nor a Testing heading', async () => {
  const { replaceScreenshotsSection } = await import(path.join(SKILLS_DIRECTORY, 'pr-media', 'publish.mjs'));
  const draft = [
    '## Screenshots',
    '',
    '<details>',
    '<summary>Screenshots</summary>',
    '',
    '<!-- pr-media: blue-shot.png -->',
    '![blue shot](./blue-shot.png)',
    '<!-- /pr-media: blue-shot.png -->',
    '',
    '</details>',
  ].join('\n');
  const body = '## What\nx\n\n## How\n- mechanism\n';
  const result = replaceScreenshotsSection(body, draft);
  assert.match(result, /## Screenshots\n\n<details>\n<summary>Screenshots<\/summary>\n\n<!-- pr-media: blue-shot\.png -->\n!\[blue shot\]\(\.\/blue-shot\.png\)\n<!-- \/pr-media: blue-shot\.png -->\n\n<\/details>/);
});

test('publish refuses a github.com target on a gh older than 2.99 and reads a GHES host from a URL', async () => {
  const { isVersionAtLeast, parsePullRequestTarget, MINIMUM_GH_VERSION_FOR_ATTACH } = await import(
    path.join(SKILLS_DIRECTORY, 'pr-media', 'publish.mjs')
  );
  assert.equal(MINIMUM_GH_VERSION_FOR_ATTACH, '2.99.0');
  assert.equal(isVersionAtLeast('2.100.0', MINIMUM_GH_VERSION_FOR_ATTACH), true);
  assert.equal(isVersionAtLeast('2.98.9', MINIMUM_GH_VERSION_FOR_ATTACH), false);
  assert.deepEqual(parsePullRequestTarget('https://github.example.test/org/repo/pull/12', () => {
    throw new Error('not consulted');
  }), { host: 'github.example.test', owner: 'org', repo: 'repo', number: '12' });
  assert.deepEqual(parsePullRequestTarget('7', () => ({ host: 'github.com', owner: 'o', repo: 'r' })), {
    host: 'github.com', owner: 'o', repo: 'r', number: '7',
  });
});

test('pr-description demands a manual Testing walkthrough and a Not tested alert', () => {
  const source = skillSource('pr-description');
  assert.match(source, /### `## Testing`/);
  assert.match(source, /\*\*Not tested:\*\*/);
  assert.match(source, /\*\*Expect:\*\*/);
});

test('install.sh installs the agent-browser CLI and its browser without a version pin', () => {
  const installer = readFileSync(path.join(REPO_ROOT, 'install.sh'), 'utf8');
  assert.match(installer, /npm install -g agent-browser/);
  assert.doesNotMatch(installer, /agent-browser@\d/);
  assert.match(installer, /agent-browser install/);
  assert.match(installer, /agent-browser doctor/);
});

test('99c composes the PR with pr-description and a UI change carries pr-media captures', () => {
  const executeTodos = readFileSync(path.join(SKILLS_DIRECTORY, 'execute-todos', 'SKILL.md'), 'utf8');
  const writeTodos = readFileSync(path.join(SKILLS_DIRECTORY, 'write-todos', 'SKILL.md'), 'utf8');
  assert.match(executeTodos, /`\/pr-description`/);
  assert.match(executeTodos, /`\/pr-media`/);
  assert.match(writeTodos, /`\/pr-media`/);
});
