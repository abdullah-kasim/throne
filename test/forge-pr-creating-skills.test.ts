import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readMarkdownSection } from './skill-contract-test-helpers.ts';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SKILLS_DIRECTORY = path.join(REPO_ROOT, '.claude', 'skills');
const PR_CREATING_SKILLS = ['pr-description', 'execute-todos', 'write-todos'] as const;
const PULL_REQUEST_DELIVERY_HEADING = '#### Pull-request delivery — when the deliverable is a PR, not a merge';
const DELIVERY_TODO_HEADING = '## The delivery todo (`99c_deliver_<topic>.md`)';

const GITHUB_COMMANDS_WITH_THEIR_FORGE_COMMAND = [
  { github: /\bgit\b.*\bpush -u\b/, forge: /^throne forge push-branch\b/m, label: 'push' },
  { github: /\bgh\b.*\bpr create\b/, forge: /^throne forge pr create\b/m, label: 'pr create' },
  { github: /\bgh\b.*\bpr view\b/, forge: /^throne forge pr view\b/m, label: 'pr view' },
  { github: /\bgh\b.*\bpr edit\b/, forge: /^throne forge pr edit\b/m, label: 'pr edit' },
] as const;

interface FencedBlock {
  readonly text: string;
  readonly proseBefore: string;
}

type PrCreatingSkill = (typeof PR_CREATING_SKILLS)[number];

const SKILL_SOURCES: Record<PrCreatingSkill, string> = Object.fromEntries(
  await Promise.all(
    PR_CREATING_SKILLS.map(async (name) => [name, await readFile(path.join(SKILLS_DIRECTORY, name, 'SKILL.md'), 'utf8')] as const),
  ),
) as Record<PrCreatingSkill, string>;
const COMMANDS_DOCUMENT = await readFile(path.join(REPO_ROOT, 'agent_docs', 'commands.md'), 'utf8');

function skillSource(name: PrCreatingSkill): string {
  return SKILL_SOURCES[name];
}

function fencedBlocks(markdown: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  let fence: string | undefined;
  let blockLines: string[] = [];
  let proseLines: string[] = [];
  for (const line of markdown.split('\n')) {
    const fenceMark = /^\s{0,3}(`{3,})/.exec(line)?.[1];
    if (fence === undefined && fenceMark !== undefined) {
      fence = fenceMark;
      blockLines = [];
      continue;
    }
    if (fence !== undefined && fenceMark !== undefined && fenceMark.length >= fence.length && line.trim() === fenceMark) {
      blocks.push({ text: blockLines.join('\n'), proseBefore: proseLines.join('\n') });
      fence = undefined;
      proseLines = [];
      continue;
    }
    if (fence === undefined) proseLines.push(line);
    else blockLines.push(line);
  }
  return blocks;
}

function documentedForgeFlags(): Map<string, Set<string>> {
  const usage = fencedBlocks(readMarkdownSection(COMMANDS_DOCUMENT, '## forge'))[0]?.text ?? '';
  const flagsByOperation = new Map<string, Set<string>>();
  for (const line of usage.split('\n')) {
    const match = /\bforge ((?:pr )?[a-z-]+)(.*)$/.exec(line);
    if (match === null) continue;
    flagsByOperation.set(match[1], new Set(match[2].match(/--[a-z-]+/g) ?? []));
  }
  return flagsByOperation;
}

function forgeCommandsNamedIn(source: string): Array<{ operation: string; flags: string[]; text: string }> {
  const joined = source.replace(/\\\n\s*/g, ' ');
  return [...joined.matchAll(/throne forge ((?:pr )?[a-z][a-z-]*)([^`\n]*)/g)].map((match) => ({
    operation: match[1],
    flags: match[2].match(/--[a-z-]+/g) ?? [],
    text: match[0],
  }));
}

test('a pull request the court creates goes through the forge seam on every path that creates one', () => {
  const prDescription = readMarkdownSection(skillSource('pr-description'), '## Creating the PR');
  const executeTodos = skillSource('execute-todos');
  const pullRequestDelivery = readMarkdownSection(executeTodos, PULL_REQUEST_DELIVERY_HEADING);
  const deliveryTodo = readMarkdownSection(skillSource('write-todos'), DELIVERY_TODO_HEADING);

  for (const [label, section] of [['pr-description', prDescription], ['execute-todos', pullRequestDelivery]] as const) {
    const blocks = fencedBlocks(section);
    assert.ok(blocks.some((block) => /^throne forge push-branch\b/m.test(block.text)), `${label} pushes with forge push-branch`);
    assert.ok(blocks.some((block) => /^throne forge pr create\b/m.test(block.text)), `${label} opens the PR with forge pr create`);
  }
  assert.match(pullRequestDelivery, /^throne forge pr create --repo "\$repo" --draft /m);
  assert.match(pullRequestDelivery, /^throne forge push-branch --repo "\$repo" --branch "\$pr_branch"$/m);
  assert.match(executeTodos, /delivers \(draft PR through `throne forge` when the row\s+carries a PR branch\)/);
  assert.match(executeTodos, /open a DRAFT PR from it through `throne forge`\s+\(so on a Forgejo host it lands in Forgejo\)/);
  assert.match(deliveryTodo, /pushes the human-named PR branch with `throne forge push-branch`/);
  assert.match(deliveryTodo, /opens the\s+draft PR from it with `throne forge pr create --draft`/);

  for (const name of PR_CREATING_SKILLS) {
    const blocks = fencedBlocks(skillSource(name));
    blocks.forEach((block, index) => {
      for (const command of GITHUB_COMMANDS_WITH_THEIR_FORGE_COMMAND) {
        if (!command.github.test(block.text)) continue;
        assert.match(block.proseBefore, /On GitHub|On any other host/, `${name}: a ${command.label} block is introduced as the GitHub branch`);
        assert.match(blocks[index - 1]?.text ?? '', command.forge, `${name}: a ${command.label} block follows its forge command`);
      }
    });
  }
});

test('the PR-creating skills view, edit and render-check a pull request through the forge seam', () => {
  const prDescription = skillSource('pr-description');
  const pullRequestDelivery = readMarkdownSection(skillSource('execute-todos'), PULL_REQUEST_DELIVERY_HEADING);
  assert.match(prDescription, /`throne forge pr view\s+<n> \| jq -r \.body`/);
  assert.match(prDescription, /`throne forge pr edit\s+<n> --body-file` it back/);
  assert.match(prDescription, /`throne forge render-markdown --file <path-to-body\.md>`/);
  assert.match(prDescription, /reused with `throne forge pr edit <n> --body-file`/);
  assert.match(pullRequestDelivery, /^throne forge pr view "\$target_branch" --repo "\$repo"$/m);
  assert.match(pullRequestDelivery, /Paste the `throne forge pr view` JSON\s+into the report; on both forges it carries `url`, `isDraft`, `headRefName` and\s+`baseRefName`/);
});

test('a pull request opened on a Forgejo host reaches GitHub only through pr-promote on the Lord\'s word', () => {
  const pullRequestDelivery = readMarkdownSection(skillSource('execute-todos'), PULL_REQUEST_DELIVERY_HEADING);
  assert.match(pullRequestDelivery, /the draft PR lands in Forgejo/);
  assert.match(pullRequestDelivery, /It reaches GitHub only through `\/pr-promote` on the Lord's word; `99c`\s+never promotes/);
  assert.match(readMarkdownSection(skillSource('pr-description'), '## Creating the PR'), /reaches GitHub only when\s+its owner says so through `\/pr-promote`/);
});

test('the legacy delivery shape opens its pull request through the forge seam on a Forgejo host', () => {
  const pullRequestDelivery = readMarkdownSection(skillSource('execute-todos'), PULL_REQUEST_DELIVERY_HEADING);
  const legacyShape = pullRequestDelivery.slice(pullRequestDelivery.indexOf('**The legacy shape'));
  assert.match(legacyShape, /^\*\*The legacy shape/);
  assert.match(legacyShape, /On both\s+forges the PR then opens through `throne forge pr create` as in the normal\s+shape/);
  assert.match(legacyShape, /the seam\s+takes the Forgejo base from `origin\/<default>`, never from the local default\s+branch that already holds the delivery merge/);
  assert.doesNotMatch(legacyShape, /cannot open a readable PR|would show no changes|Refile under the normal shape\s+there/);
  assert.match(legacyShape, /Never push the default branch in this shape/);
  assert.match(legacyShape, /the local\s+default branch is ahead of `origin` by the delivery merge/);
  assert.match(legacyShape, /Prefer refiling under the\s+normal shape whenever the campaign is young enough/);
});

test('every forge command the PR-creating skills name uses only flags the forge command documents', () => {
  const documented = documentedForgeFlags();
  assert.ok(documented.has('pr create') && documented.has('push-branch'), 'agent_docs/commands.md documents the forge usage');
  for (const name of PR_CREATING_SKILLS) {
    const named = forgeCommandsNamedIn(skillSource(name));
    assert.ok(named.length > 0, `${name} names a forge command`);
    for (const command of named) {
      const flags = documented.get(command.operation);
      assert.ok(flags !== undefined, `${name}: \`${command.text}\` names a documented operation`);
      for (const flag of command.flags) assert.ok(flags.has(flag), `${name}: \`${command.text}\` uses the documented flag ${flag}`);
    }
  }
});

test('the GitHub branch of every PR-creating skill keeps the gh commands it ran before', () => {
  const prDescription = skillSource('pr-description');
  const pullRequestDelivery = readMarkdownSection(skillSource('execute-todos'), PULL_REQUEST_DELIVERY_HEADING);
  assert.match(prDescription, /\(`gh repo view --json\s+defaultBranchRef -q \.defaultBranchRef\.name`\)/);
  assert.match(prDescription, /\(`gh pr list --state merged --limit 5`\)/);
  assert.match(prDescription, /`gh api -X POST \/markdown -f mode=gfm -f text=\.\.\.`/);
  assert.match(prDescription, /`gh pr view\s+<n> --json body -q \.body`/);
  assert.match(prDescription, /\(`gh pr edit --body-file` on GitHub\)/);
  assert.ok(prDescription.includes([
    'git push -u origin <branch>',
    'gh pr create [--draft] --base <default-branch> --head <branch> \\',
    '  --title "<title>" --body-file <path-to-body.md>',
  ].join('\n')));
  assert.ok(pullRequestDelivery.includes([
    'git -C "$repo" push -u origin "$target_branch"',
    'gh -R <owner>/<repo> pr create --draft --base <default branch> --head "$target_branch" \\',
    '   --title "<what changed, as the contributor would say it>" --body-file <body.md>',
    'gh -R <owner>/<repo> pr view "$target_branch" --json url,isDraft,headRefName,baseRefName',
  ].join('\n')));
  assert.match(pullRequestDelivery, /On GitHub the push is `git -C "\$repo" push -u origin "\$pr_branch"`/);
});
