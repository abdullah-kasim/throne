import assert from 'node:assert/strict';
import { test } from 'node:test';

const media = await import('../.claude/skills/pr-media/media-folder.mjs');
const publish = await import('../.claude/skills/pr-media/publish.mjs');
const contactSheet = await import('../.claude/skills/pr-media/contact-sheet.mjs');
const looseUploads = await import('../.claude/skills/pr-media/loose-uploads.mjs');

type MediaFile = { name: string; kind: 'image' | 'video' };

function image(name: string): MediaFile {
  return { name, kind: 'image' };
}

function video(name: string): MediaFile {
  return { name, kind: 'video' };
}

const folderInNameOrder: MediaFile[] = [
  image('01-tiles-after.png'),
  image('01-tiles-before.png'),
  image('02-chart-after.png'),
  image('02-chart-before.png'),
  video('03-drill-after.mp4'),
  video('03-drill-before.mp4'),
  image('04-tiles-phone-after.png'),
  image('04-tiles-phone-before.png'),
  image('05-legend.png'),
];

const bodyOrder = [
  '01-tiles-before.png',
  '01-tiles-after.png',
  '02-chart-before.png',
  '02-chart-after.png',
  '03-drill-before.mp4',
  '03-drill-after.mp4',
  '04-tiles-phone-before.png',
  '04-tiles-phone-after.png',
  '05-legend.png',
];

test('pairs group by their shared stem with the before first, and a file without a side stays a single', () => {
  const groups = media.groupIntoPairsAndSingles(folderInNameOrder);
  assert.deepEqual(
    groups.map((group: { pair?: { stem: string }; single?: MediaFile }) => group.pair?.stem ?? group.single?.name),
    ['01-tiles', '02-chart', '03-drill', '04-tiles-phone', '05-legend.png'],
  );
  assert.equal(groups[0].pair.before.name, '01-tiles-before.png');
  assert.equal(groups[0].pair.after.name, '01-tiles-after.png');
  assert.deepEqual(media.filesInBodyOrder(groups).map((file: MediaFile) => file.name), bodyOrder);
  assert.deepEqual(media.namesMissingTheirPartner(groups), []);
});

test('a before screenshot pairs with an after video when the base has no equivalent interaction', () => {
  const groups = media.groupIntoPairsAndSingles([video('06-peak-click-after.mp4'), image('06-peak-click-before.png')]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].pair.before.kind, 'image');
  assert.equal(groups[0].pair.after.kind, 'video');
});

test('a side without its partner is shown alone and named, and two files on one side are refused', () => {
  const groups = media.groupIntoPairsAndSingles([image('07-empty-after.png'), image('08-other.png')]);
  assert.deepEqual(groups.map((group: { single?: MediaFile }) => group.single?.name), ['07-empty-after.png', '08-other.png']);
  assert.deepEqual(media.namesMissingTheirPartner(groups), ['07-empty-after.png']);
  assert.throws(
    () => media.groupIntoPairsAndSingles([image('09-x-before.png'), video('09-x-before.mp4')]),
    /09-x-before\.png and 09-x-before\.mp4 are both the before side of 09-x/,
  );
});

test('an anchor pair inside a Markdown table row is written on one line, and elsewhere on three', () => {
  const body = [
    '## Screenshots',
    '',
    '| Before | After |',
    '| --- | --- |',
    '| <!-- pr-media: 01-tiles-before.png --> ![old](https://github.com/user-attachments/assets/OLD) <!-- /pr-media: 01-tiles-before.png --> | <!-- drop 01-tiles-after.png here --> |',
    '',
    '<!-- pr-media: 05-legend.png -->',
    '![legend](./05-legend.png)',
    '<!-- /pr-media: 05-legend.png -->',
    '',
    '## Testing',
  ].join('\n');
  const files = [image('01-tiles-before.png'), image('01-tiles-after.png'), image('05-legend.png')];
  const rewrite = publish.rewriteBody(body, files);
  const lines = rewrite.body.split('\n');
  assert.equal(
    lines[4],
    '| <!-- pr-media: 01-tiles-before.png --> ![tiles before](./01-tiles-before.png) <!-- /pr-media: 01-tiles-before.png --> | <!-- pr-media: 01-tiles-after.png --> ![tiles after](./01-tiles-after.png) <!-- /pr-media: 01-tiles-after.png --> |',
  );
  assert.match(rewrite.body, /<!-- pr-media: 05-legend\.png -->\n!\[legend\]\(\.\/05-legend\.png\)\n<!-- \/pr-media: 05-legend\.png -->/);
  assert.deepEqual(rewrite.replaced, ['01-tiles-before.png', '05-legend.png']);
  assert.deepEqual(rewrite.converted, ['01-tiles-after.png']);
});

test('a video anchor in an HTML table cell keeps the three-line layout that plays on both hosts', () => {
  const body = [
    '<table>',
    '<tr><th>Before</th><th>After</th></tr>',
    '<tr>',
    '<td>',
    '',
    '<!-- pr-media: 03-drill-before.mp4 -->',
    '![drill before](./03-drill-before.mp4)',
    '<!-- /pr-media: 03-drill-before.mp4 -->',
    '',
    '</td>',
    '</tr>',
    '</table>',
  ].join('\n');
  const file = video('03-drill-before.mp4');
  const rewrite = publish.rewriteBody(body, [file], (candidate: MediaFile) =>
    publish.assetReference(candidate, 'https://github.com/user-attachments/assets/V1'),
  );
  assert.match(rewrite.body, /<td>\n\n<!-- pr-media: 03-drill-before\.mp4 -->\nhttps:\/\/github\.com\/user-attachments\/assets\/V1\n<!-- \/pr-media: 03-drill-before\.mp4 -->\n\n<\/td>/);
});

test('verification refuses a table-row anchor pair that publishing spread over several lines', () => {
  const files = [image('01-tiles-before.png')];
  const oneLine = '| <!-- pr-media: 01-tiles-before.png --> ![tiles before](https://github.com/user-attachments/assets/A) <!-- /pr-media: 01-tiles-before.png --> | x |';
  assert.deepEqual(publish.verifyPublishedBody(oneLine, files).failures, []);
  const broken = '| <!-- pr-media: 01-tiles-before.png -->\n![tiles before](https://github.com/user-attachments/assets/A)\n<!-- /pr-media: 01-tiles-before.png --> | x |';
  assert.deepEqual(publish.verifyPublishedBody(broken, files).failures, [
    '01-tiles-before.png: anchor pair in a table row spans several lines, which breaks the row',
  ]);
});

test('collect maps before and after images by stem and videos by body order, keeping table rows on one line', () => {
  const files = media.filesInBodyOrder(media.groupIntoPairsAndSingles([
    image('01-tiles-after.png'),
    image('01-tiles-before.png'),
    video('03-drill-after.mp4'),
    video('03-drill-before.mp4'),
  ]));
  const body = [
    '## Screenshots',
    '',
    '| Before | After |',
    '| --- | --- |',
    '| <!-- pr-media: 01-tiles-before.png --> ![tiles before](./01-tiles-before.png) <!-- /pr-media: 01-tiles-before.png --> | <!-- pr-media: 01-tiles-after.png --> ![tiles after](./01-tiles-after.png) <!-- /pr-media: 01-tiles-after.png --> |',
    '',
    '<img width="10" height="10" alt="01-tiles-after" src="https://ghe.example/user-attachments/assets/AFTER" />',
    '',
    'https://ghe.example/user-attachments/assets/VBEFORE',
    '',
    '<img width="10" height="10" alt="01-tiles-before" src="https://ghe.example/user-attachments/assets/BEFORE" />',
    '',
    'https://ghe.example/user-attachments/assets/VAFTER',
    '',
    '<!-- pr-media: 03-drill-before.mp4 -->',
    '![drill before](./03-drill-before.mp4)',
    '<!-- /pr-media: 03-drill-before.mp4 -->',
    '',
    '<!-- pr-media: 03-drill-after.mp4 -->',
    '![drill after](./03-drill-after.mp4)',
    '<!-- /pr-media: 03-drill-after.mp4 -->',
  ].join('\n');
  const uploads = looseUploads.collectLooseUploads(body);
  const mapping = looseUploads.mapUploadsToFiles(uploads, files);
  assert.equal(mapping.assets.get('01-tiles-before.png'), 'https://ghe.example/user-attachments/assets/BEFORE');
  assert.equal(mapping.assets.get('01-tiles-after.png'), 'https://ghe.example/user-attachments/assets/AFTER');
  assert.equal(mapping.assets.get('03-drill-before.mp4'), 'https://ghe.example/user-attachments/assets/VBEFORE');
  assert.equal(mapping.assets.get('03-drill-after.mp4'), 'https://ghe.example/user-attachments/assets/VAFTER');
  const rewrite = publish.rewriteBody(publish.removeLooseUploads(body, uploads), files, (file: MediaFile) =>
    publish.assetReference(file, mapping.assets.get(file.name)),
  );
  assert.deepEqual(publish.verifyPublishedBody(rewrite.body, files).failures, []);
  const row = rewrite.body.split('\n').find((line: string) => line.startsWith('| <!-- pr-media'));
  assert.equal(
    row,
    '| <!-- pr-media: 01-tiles-before.png --> ![tiles before](https://ghe.example/user-attachments/assets/BEFORE) <!-- /pr-media: 01-tiles-before.png --> | <!-- pr-media: 01-tiles-after.png --> ![tiles after](https://ghe.example/user-attachments/assets/AFTER) <!-- /pr-media: 01-tiles-after.png --> |',
  );
});

test('the wizard drop list names every file in body order, each before ahead of its after', () => {
  const files = media.filesInBodyOrder(media.groupIntoPairsAndSingles(folderInNameOrder));
  const instructions = publish.wizardInstructions({ host: 'github.example.test', owner: 'o', repo: 'r', number: '9' }, files);
  const listed = [...instructions.matchAll(/^ {5}\d+\. (\S+)/gm)].map((match) => match[1]);
  assert.deepEqual(listed, bodyOrder);
  assert.match(instructions, /3\. 02-chart-before\.png\n/);
  assert.match(instructions, /5\. 03-drill-before\.mp4 \(video\)\n {5}6\. 03-drill-after\.mp4 \(video\)/);
});

test('the contact sheet shows a pair as a Before/After table with the before cell first, and a single as before', () => {
  const html = contactSheet.contactSheetHtml('/tmp/pr-media-9', folderInNameOrder);
  assert.equal((html.match(/<section class="pair">/g) ?? []).length, 4);
  assert.equal((html.match(/<thead><tr><th>Before<\/th><th>After<\/th><\/tr><\/thead>/g) ?? []).length, 4);
  const drill = html.slice(html.indexOf('<h2>03-drill</h2>'));
  assert.ok(drill.indexOf('src="03-drill-before.mp4"') < drill.indexOf('src="03-drill-after.mp4"'));
  assert.match(html, /<td data-side="Before">\n<video controls playsinline preload="metadata" src="03-drill-before\.mp4"><\/video>/);
  assert.match(html, /<section>\n<h2>05-legend\.png<\/h2>\n<img src="05-legend\.png" alt="legend">\n<p>legend<\/p>\n<\/section>/);
  assert.match(html, /9 files, 4 before\/after pairs: 01-tiles-before\.png, 01-tiles-after\.png, 02-chart-before\.png/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /@media \(max-width: 600px\)/);
  assert.doesNotMatch(html, /https?:\/\//);
});
