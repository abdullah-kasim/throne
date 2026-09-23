import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const media = await import('../.claude/skills/pr-media/media-folder.mjs');
const scratch: string[] = [];
after(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

test('alt text drops the two-digit order prefix and reads the rest as words', () => {
  assert.equal(media.altTextFor('03-path-cell-click.mp4'), 'path cell click');
  assert.equal(media.altTextFor('12-table-path-link-phone.png'), 'table path link phone');
  assert.equal(media.altTextFor('table-path-link.png'), 'table path link');
});

test('numbered files list in body order regardless of what they show', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'pr-media-order-'));
  scratch.push(folder);
  for (const name of ['02-zebra.png', '10-apple.mp4', '01-yak.png', 'notes.txt']) {
    await writeFile(path.join(folder, name), 'x');
  }
  const files = media.listMediaFiles(folder);
  assert.deepEqual(files.map((file: { name: string }) => file.name), ['01-yak.png', '02-zebra.png', '10-apple.mp4']);
});

test('files without the prefix are named so publish can warn about them', () => {
  const files = [{ name: '01-a.png' }, { name: 'b.png' }, { name: '7-c.mp4' }];
  assert.deepEqual(media.namesWithoutOrderPrefix(files), ['b.png', '7-c.mp4']);
});

test('a numbered file claims the anchor its unnumbered name left in the body', async () => {
  const publish = await import('../.claude/skills/pr-media/publish.mjs');
  const body = ['## Screenshots', '', 'Phone:', '', '<!-- pr-media: phone.png -->', '![phone](./phone.png)', '<!-- /pr-media: phone.png -->', '', '<!-- drop desktop.png here -->', '', '## Testing'].join('\n');
  const files = [{ name: '01-phone.png', kind: 'image' }, { name: '02-desktop.png', kind: 'image' }];
  const result = publish.rewriteBody(body, files);
  assert.deepEqual(result.renumbered, ['phone.png -> 01-phone.png', 'desktop.png -> 02-desktop.png']);
  assert.deepEqual(result.orphans, []);
  assert.match(result.body, /<!-- pr-media: 01-phone\.png -->\n!\[phone\]\(\.\/01-phone\.png\)\n<!-- \/pr-media: 01-phone\.png -->/);
  assert.match(result.body, /<!-- pr-media: 02-desktop\.png -->/);
  assert.doesNotMatch(result.body, /pr-media: phone\.png|drop desktop/);
});
