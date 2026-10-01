import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseMemoryFrontmatter,
  splitFrontmatterFromBody,
  withAskLine,
} from './memory-frontmatter.ts';

test('a memory without a frontmatter block is all body', () => {
  const text = '# A lesson\n\n- do the thing\n---\nnot a fence\n';
  assert.deepEqual(splitFrontmatterFromBody(text), { frontmatterLines: [], body: text });
});

test('an unclosed frontmatter fence is treated as body', () => {
  const text = '---\nask: never closed\n# A lesson\n';
  assert.deepEqual(splitFrontmatterFromBody(text), { frontmatterLines: [], body: text });
});

test('the new keys are read and the body keeps its text exactly', () => {
  const split = splitFrontmatterFromBody(
    [
      '---',
      'ask: "Does the task edit a GitHub pull request description: title or body?"',
      'scope: global',
      'kind: trap',
      'learned: 2026-09-17',
      'status: superseded',
      'superseded_by: NEWER_LESSON.md',
      'cost_if_missed: high',
      '---',
      '# The lesson',
      '',
      '---',
      'a horizontal rule above stays in the body',
    ].join('\n'),
  );
  assert.deepEqual(parseMemoryFrontmatter(split.frontmatterLines), {
    ask: 'Does the task edit a GitHub pull request description: title or body?',
    scope: 'global',
    kind: 'trap',
    learned: '2026-09-17',
    status: 'superseded',
    superseded_by: 'NEWER_LESSON.md',
    cost_if_missed: 'high',
  });
  assert.equal(split.body, '# The lesson\n\n---\na horizontal rule above stays in the body');
});

test('the older name, description and nested metadata type keys are read too', () => {
  const split = splitFrontmatterFromBody(
    '---\nname: set-viewport-blanks-the-page\ndescription: resizing after open blanks the page\nmetadata:\n  type: project\n---\nbody\n',
  );
  assert.deepEqual(parseMemoryFrontmatter(split.frontmatterLines), {
    name: 'set-viewport-blanks-the-page',
    description: 'resizing after open blanks the page',
    type: 'project',
  });
});

test('a value outside the allowed set is ignored rather than trusted', () => {
  assert.deepEqual(
    parseMemoryFrontmatter(['kind: rumour', 'status: deleted', 'cost_if_missed: enormous', 'ask: ""']),
    {},
  );
});

test('a file saved with Windows line endings still has its keys read', () => {
  const split = splitFrontmatterFromBody('---\r\nstatus: superseded\r\ncost_if_missed: high\r\n---\r\nbody\r\n');
  assert.deepEqual(parseMemoryFrontmatter(split.frontmatterLines), {
    status: 'superseded',
    cost_if_missed: 'high',
  });
});

test('a body that opens with a horizontal rule and has another later loses no text', () => {
  const text = '---\nSome prose under a rule, not a key list.\n---\nmore prose\n';
  assert.deepEqual(splitFrontmatterFromBody(text), { frontmatterLines: [], body: text });
});

test('a nested key other than type is not mistaken for a top-level key', () => {
  assert.deepEqual(parseMemoryFrontmatter(['metadata:', '  status: superseded', '  type: project']), {
    type: 'project',
  });
});

function askOf(fileText: string): string | undefined {
  return parseMemoryFrontmatter(splitFrontmatterFromBody(fileText).frontmatterLines).ask;
}

test('a rewritten ask reads back exactly and nothing else in the memory changes, quotes, backslashes and carriage returns included', () => {
  const ask = 'Does the task touch the "C:\\invented\\path" share in any way?';
  const original = '---\r\nask: Does the task open it?\r\nkind: trap\r\n---\r\n# A lesson\r\n';
  const rewritten = withAskLine(original, ask);
  assert.equal(askOf(rewritten), ask);
  assert.equal(
    rewritten,
    original.replace('ask: Does the task open it?', 'ask: "Does the task touch the \\"C:\\\\invented\\\\path\\" share in any way?"'),
  );
});

test('a memory with frontmatter but no ask gains one ask line after the opening fence and nothing else changes', () => {
  const original = '---\nkind: trap\n---\n# A lesson\n';
  const rewritten = withAskLine(original, 'Does the task touch the invented bakery till in any way?');
  assert.equal(rewritten, '---\nask: "Does the task touch the invented bakery till in any way?"\nkind: trap\n---\n# A lesson\n');
  assert.equal(askOf(rewritten), 'Does the task touch the invented bakery till in any way?');
});

test('a memory without frontmatter gains a frontmatter block holding only the ask, above the untouched text', () => {
  const original = '# A lesson\n\n- do the thing\n';
  const rewritten = withAskLine(original, 'Does the task touch the invented bakery till in any way?');
  assert.equal(rewritten, `---\nask: "Does the task touch the invented bakery till in any way?"\n---\n${original}`);
  assert.equal(askOf(rewritten), 'Does the task touch the invented bakery till in any way?');
});

test('an ask key nested under another key is left alone and the top-level ask is added beside it', () => {
  const original = '---\nmetadata:\n  ask: an invented nested value\n---\n# A lesson\n';
  const rewritten = withAskLine(original, 'Does the task touch the invented bakery till in any way?');
  assert.equal(
    rewritten,
    '---\nask: "Does the task touch the invented bakery till in any way?"\nmetadata:\n  ask: an invented nested value\n---\n# A lesson\n',
  );
});
