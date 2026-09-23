import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';

import {
  HERDR_OPERATOR_SKILL_RELATIVE_PATH,
  installHerdrOperatorSkill,
  isHerdrOperatorRole,
  renderHerdrOperatorSkill,
  type HerdrOperatorSkillDependencies,
} from './herdr-operator-skill.ts';

const OFFICIAL =
  '---\nname: herdr\ndescription: "Control Herdr."\n---\n\n# Herdr\n\nBody line.\n';
const PINNED = '/home/op/.local/share/throne/herdr/v0.8.2/herdr';

function harness(official: string | Error = OFFICIAL) {
  const written: Array<{ filePath: string; content: string }> = [];
  const deps: HerdrOperatorSkillDependencies = {
    readOfficialSkill: async () => {
      if (official instanceof Error) throw official;
      return official;
    },
    pinnedHerdrPath: () => PINNED,
    writeSkillFile: async (filePath, content) => {
      written.push({ filePath, content });
    },
  };
  return { deps, written };
}

test('only the Stager and the Regent are operator roles', () => {
  assert.equal(isHerdrOperatorRole('Stager'), true);
  assert.equal(isHerdrOperatorRole('Regent'), true);
  assert.equal(isHerdrOperatorRole(' Regent '), true);
  for (const role of ['Alpha', 'Shadow', 'alpha', 'shadow', 'Agent', '']) {
    assert.equal(isHerdrOperatorRole(role), false, role);
  }
});

test('the rendered skill keeps the official frontmatter and puts the court rules before the official body', () => {
  const rendered = renderHerdrOperatorSkill(OFFICIAL, PINNED);
  assert.ok(rendered.startsWith('---\nname: herdr\ndescription: "Control Herdr."\n---\n'));
  const rules = rendered.indexOf('## Throne court rules');
  const body = rendered.indexOf('# Herdr\n\nBody line.');
  assert.ok(rules > 0 && body > rules, 'rules must sit between frontmatter and body');
  assert.match(rendered, /throne send-agent <name> <message>/);
  assert.match(rendered, /never `pane send-text`/);
  assert.match(rendered, new RegExp(PINNED.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  assert.match(rendered, /Stager and the Regent only/);
});

test('output without a frontmatter block is refused rather than written as a broken skill', () => {
  assert.throws(() => renderHerdrOperatorSkill('# no frontmatter\n', PINNED), /frontmatter/);
});

test('an Alpha or Shadow gets nothing written and the official skill is never even read', async () => {
  for (const role of ['Alpha', 'Shadow']) {
    let reads = 0;
    const h = harness();
    h.deps.readOfficialSkill = async () => {
      reads += 1;
      return OFFICIAL;
    };
    const outcome = await installHerdrOperatorSkill(role, '/wt/alpha-x', h.deps);
    assert.deepEqual(outcome, { kind: 'not-an-operator-role', role });
    assert.equal(reads, 0);
    assert.deepEqual(h.written, []);
  }
});

test('a Stager gets the generated skill under its own cwd', async () => {
  const h = harness();
  const outcome = await installHerdrOperatorSkill('Stager', '/wt/stager-seventh', h.deps);
  const expected = path.join('/wt/stager-seventh', HERDR_OPERATOR_SKILL_RELATIVE_PATH);
  assert.deepEqual(outcome, { kind: 'installed', filePath: expected });
  assert.equal(h.written.length, 1);
  assert.equal(h.written[0]?.filePath, expected);
  assert.match(h.written[0]?.content ?? '', /Throne court rules/);
});

test('the Regent gets it under the throne root', async () => {
  const h = harness();
  const outcome = await installHerdrOperatorSkill('Regent', '/home/op/throne', h.deps);
  assert.equal(outcome.kind, 'installed');
  assert.equal(h.written[0]?.filePath, '/home/op/throne/.claude/skills/herdr/SKILL.md');
});

test('a failing herdr --skill is reported, never thrown, and writes nothing', async () => {
  const h = harness(new Error('spawn herdr ENOENT'));
  const outcome = await installHerdrOperatorSkill('Stager', '/wt/stager-x', h.deps);
  assert.equal(outcome.kind, 'failed');
  assert.match(outcome.kind === 'failed' ? outcome.message : '', /ENOENT/);
  assert.deepEqual(h.written, []);
});
