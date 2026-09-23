import assert from 'node:assert/strict';
import { test } from 'node:test';

const publish = await import('../.claude/skills/pr-media/publish.mjs');
const draft = '## Screenshots\n\nThe header, hovered:\n\n<!-- pr-media: 01-header.png -->\n![header](./01-header.png)\n<!-- /pr-media: 01-header.png -->';

test('an existing Screenshots section is replaced wholesale by the draft, neighbours untouched', () => {
  const body = '## What\n\nwords\n\n## Screenshots\n\nold text\n\n<!-- drop old.png here -->\n\n## Testing\n\nsteps\n';
  const result = publish.replaceScreenshotsSection(body, draft);
  assert.equal(result, `## What\n\nwords\n\n${draft}\n\n## Testing\n\nsteps\n`);
  assert.equal(result.includes('old.png'), false);
});

test('a body without a Screenshots section gets the draft before Testing', () => {
  const body = '## How\n\nhow\n\n## Testing\n\nsteps\n';
  assert.equal(publish.replaceScreenshotsSection(body, draft), `## How\n\nhow\n\n${draft}\n\n## Testing\n\nsteps\n`);
});

test('a draft without the heading gets one, and a body with no Testing gets the section appended', () => {
  const body = '## How\n\nhow\n';
  const result = publish.replaceScreenshotsSection(body, 'context\n\n<!-- pr-media: 01-a.png -->\n![a](./01-a.png)\n<!-- /pr-media: 01-a.png -->');
  assert.equal(result.startsWith('## How\n\nhow\n\n## Screenshots\n\ncontext'), true);
});

test('the draft file name is the one the skill documents', () => {
  assert.equal(publish.SCREENSHOTS_DRAFT_FILE, 'screenshots.md');
});
