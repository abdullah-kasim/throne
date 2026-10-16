import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  missingPhrases,
  readMarkdownSection,
  readSkill,
  unwrap,
} from './skill-contract-test-helpers.ts';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..');
const SKILLS_DIRECTORY = resolve(REPOSITORY_ROOT, '.claude/skills');
const PAGE_SKILL_DIRECTORY = resolve(SKILLS_DIRECTORY, 'where-i-stand');
const RECORD_STEP_HEADING = "#### `99d` — record the outcome on the Lord's page";
const STEP_HEADINGS = [
  "### 1. Answer with the page's link",
  '### 2. Read, in the background, what the file cannot know',
  '### 3. Put the differences on the page',
  '### 4. Correct the page, one entry at a time',
  '### 5. Keep the tailnet page up',
];
const ENTRY_FORM = [
  '- Links: Forgejo <url or "no Forgejo copy"> · GitHub <url or "not on GitHub yet"> · Ticket <url, id, or "no ticket">',
  '- Kind: <a few words> — <title>',
  '- Where it stands: <short plain summary>',
];
const ENTRY_FORM_FIRST_LINES = ['- Links: ', '- Kind: ', '- Where it stands: '];
const ENTRY_FORM_REFERENCE = "the page's entry form";

async function readSkillSection(skillName: string, heading: string): Promise<string> {
  const source = await readFile(resolve(SKILLS_DIRECTORY, skillName, 'SKILL.md'), 'utf8');
  const section = readMarkdownSection(source, heading);
  assert.notEqual(section, '', `${skillName} has the section "${heading}"`);
  return unwrap(section);
}

test("the where-i-stand skill answers in the terminal with the page's link only", async () => {
  const skill = await readSkill('where-i-stand');
  const stepPositions = STEP_HEADINGS.map((heading) => skill.indexOf(heading));
  assert.ok(!stepPositions.includes(-1), 'all five steps are present');
  assert.deepEqual(
    stepPositions,
    [...stepPositions].sort((first, second) => first - second),
    'the five steps are in order',
  );

  const answerStep = await readSkillSection('where-i-stand', STEP_HEADINGS[0]);
  assert.deepEqual(
    missingPhrases(answerStep, [
      "Run step 5's check, and start the page as step 5 says when it is not up.",
      "your answer in the terminal is the page's link, `$page_url`, on one line and nothing else",
      'Add a second line only when the Lord must act before he opens it: the page could not be served, or a host could not be read.',
      'Do not print the page, do not summarize it, and do not wait for step 2.',
      'throne where-i-stand show > ~/tmp/where-i-stand-page.md',
      '`path: <page path>` and `checksum: <sha256>` on standard error',
      'This copy is for you, not for the Lord',
    ]),
    [],
  );
  assert.ok(!answerStep.includes('leading with `## Needs you`'), 'step 1 no longer prints the page');
  assert.deepEqual(
    missingPhrases(await readSkillSection('where-i-stand', STEP_HEADINGS[1]), [
      "your harness's own background run of a command",
      'Never put a shell `&` on them',
      'where_i_stand.py" --refresh --changes',
      'where_i_stand.py" --cached --json',
      "The `--refresh --changes` run also writes the page's data file, `${XDG_CACHE_HOME:-$HOME/.cache}/where-i-stand/where-i-stand-prs.json`",
      '`--cached` never writes it.',
      'throne render-queue --all',
      'throne agent-statuses',
      'throne forge status <pull request url> --json',
      'CI, reviews, merged, closed',
      'pull requests of the Lord\'s that the page does not list',
      'Hosts and tokens stay in the Lord\'s own configuration',
    ]),
    [],
  );
  assert.deepEqual(
    missingPhrases(await readSkillSection('where-i-stand', STEP_HEADINGS[3]), [
      'throne where-i-stand lock --checksum <checksum from show> --ttl 5m',
      'remove an entry one day after its work merged or was abandoned',
      'trim `## Just happened` to its newest 15 lines',
      'write every entry you add or correct in the entry form "Writing rules for the page" gives',
    ]),
    [],
  );
  assert.deepEqual(
    missingPhrases(await readSkillSection('where-i-stand', '## Any harness can run this'), [
      'Nothing here needs a tool that only one harness has',
    ]),
    [],
  );
  assert.ok(!skill.includes('--html'), 'no step names the removed --html page');
});

test('the where-i-stand skill has an agent edit one entry at a time under a lock it runs in the background', async () => {
  const correctionStep = await readSkillSection('where-i-stand', STEP_HEADINGS[3]);
  assert.deepEqual(
    missingPhrases(correctionStep, [
      'Correct the page itself, at the path `show` printed.',
      'Read the page at that path with your harness\'s own file tool.',
      'Take the lock with your harness\'s own background run, never a shell `&`',
      'when the page changed since your `show`: run `show`, read the page again, and take the lock with the new checksum',
      'while another agent holds the lock, naming the holder',
      'While the lock lasts it is safe to edit.',
      'targeted replacement with your harness\'s edit tool, one entry at a time',
      'Never rewrite the whole file',
      'Stop the background lock with your harness\'s own way to stop a background command, then read its output.',
      'it exits 3 instead of 0',
      'the page is left as it is, so take the lock again and fix those headings',
      'a note is refused while any lock is held',
    ]),
    [],
  );
  assert.ok(
    correctionStep.indexOf('throne where-i-stand lock --checksum') < correctionStep.indexOf('Stop the background lock'),
    'the lock is taken before it is stopped',
  );
});

test("the commands doc names the lock's exit codes and the files it keeps beside the page", async () => {
  const commandsDoc = unwrap(
    readMarkdownSection(await readFile(resolve(REPOSITORY_ROOT, 'agent_docs/commands.md'), 'utf8'), '## where-i-stand'),
  );
  assert.deepEqual(
    missingPhrases(commandsDoc, [
      '3 a lock released with a broken frame',
      '`where-i-stand.edit.lock`',
      '`where-i-stand.journaled.md`',
    ]),
    [],
  );
});

test('the where-i-stand skill says what each harness edit tool does about a stale read', async () => {
  assert.deepEqual(
    missingPhrases(await readSkillSection('where-i-stand', '## Edit tools and stale reads'), [
      'No harness here refuses an edit to a file that changed since it was read.',
      'Claude Code:',
      'Codex: `apply_patch`',
      'OpenCode:',
      'The exact-text replacement limits an edit to the text it is given.',
      'The checksum at `lock` proves the read is current',
      'journaled with the writer `unknown`, and reported to the Regent',
    ]),
    [],
  );
});

test('no doc or skill tells an agent to write the whole page any more', async () => {
  const sources = [
    resolve(REPOSITORY_ROOT, 'AGENTS.md'),
    resolve(REPOSITORY_ROOT, 'agent_docs/commands.md'),
    ...['where-i-stand', 'execute-todos', 'write-todos', 'write-and-execute-todos', 'queue-objective', 'amendment'].map(
      (skillName) => resolve(SKILLS_DIRECTORY, skillName, 'SKILL.md'),
    ),
  ];
  for (const source of sources) {
    const text = unwrap(await readFile(source, 'utf8'));
    assert.ok(!text.includes('--based-on'), `${source} names no --based-on`);
    assert.ok(!text.includes('where-i-stand unlock'), `${source} names no unlock command`);
    assert.ok(!text.includes('where-i-stand write'), `${source} names no where-i-stand write`);
  }
});

test('the where-i-stand skill puts the differences on the page, not in the terminal', async () => {
  const differencesStep = await readSkillSection('where-i-stand', STEP_HEADINGS[2]);
  assert.deepEqual(
    missingPhrases(differencesStep, [
      'The differences go to the page, not the terminal.',
      'The table and its change lines already show what step 2\'s run found new, gone or changed.',
      'put every correction into `where-i-stand.md` through step 4',
      'When step 2 finishes, tell the Lord nothing more unless something now needs him.',
      'Then write at most one line naming it, with the link again.',
    ]),
    [],
  );
  assert.ok(!differencesStep.includes('tell the Lord only what differs'), 'the differences are not told in the terminal');
});

test('the where-i-stand skill serves the page on the tailnet only', async () => {
  const servingStep = await readSkillSection('where-i-stand', STEP_HEADINGS[4]);
  assert.deepEqual(
    missingPhrases(servingStep, [
      'on the tailnet only, never through funnel, at the path `/where-i-stand`',
      'The server does not survive a reboot, so check it on every run and start it when it is not up',
      `curl -s -o /dev/null -w '%{http_code}\\n' "\${page_url}where-i-stand-prs.json"`,
      'or it is an older page served without the pull request table',
      'tailnet-preview.sh stop where-i-stand',
      'tailnet-preview.sh share where-i-stand "$page_source"',
      'ln -s "${THRONE_DATA_HOME:-$HOME/.throne}/where-i-stand.md" "$page_source/where-i-stand.md"',
      'ln -s "${XDG_CACHE_HOME:-$HOME/.cache}/where-i-stand/where-i-stand-prs.json" "$page_source/where-i-stand-prs.json"',
      'Both links must be absolute',
      'When the data file is missing, run the reader once with `--refresh` (step 2), which writes it, before you start the server.',
      'It sits outside every checkout and worktree, so it outlives them',
      'The copy keeps the link as a link.',
      "An older preview that holds the path is replaced through the script's own `stop`",
      'Never take the path over with `tailscale serve` by hand',
    ]),
    [],
  );
  assert.ok(!servingStep.includes('tailscale funnel'), 'no step runs a funnel');
  assert.ok(
    servingStep.indexOf('tailnet-preview.sh stop where-i-stand') < servingStep.indexOf('tailnet-preview.sh share where-i-stand'),
    'stop runs before share',
  );
});

test('every page entry starts with its links, its kind and where it stands', async () => {
  const source = await readFile(resolve(PAGE_SKILL_DIRECTORY, 'SKILL.md'), 'utf8');
  const writingRules = readMarkdownSection(source, '## Writing rules for the page');
  assert.deepEqual(missingPhrases(writingRules, ENTRY_FORM), [], 'the entry form is stated line for line');
  assert.deepEqual(
    missingPhrases(unwrap(writingRules), [
      'Every entry starts with its links, its kind and where it stands: directly under its `### ` heading, before any other line',
      '`no Forgejo copy`, `not on GitHub yet`, `no ticket`',
      '`- Links: no pull request · <commit or link> · Ticket <url, id, or "no ticket">`',
      'The separator is a space, a middle dot and a space (` · `).',
      'The free lines follow: what is and is not verified, who wrote it and when.',
      'Plain words.',
      'One line per fact.',
      'A link for every pull request.',
      'Say what is not verified.',
      'Never copy a report into it.',
      'End each entry with a line naming who wrote it and when.',
      'Never start a line inside an entry with `## `.',
      "An invented entry, for a bakery's order page",
    ]),
    [],
  );

  const exampleLines = writingRules.split('\n');
  const exampleHeading = exampleLines.indexOf('### cakeorders');
  assert.notEqual(exampleHeading, -1, 'the bakery example is present');
  const exampleFirstLines = exampleLines.slice(exampleHeading + 2, exampleHeading + 5);
  assert.deepEqual(
    exampleFirstLines.map((line, index) => line.startsWith(ENTRY_FORM_FIRST_LINES[index])),
    [true, true, true],
    'the bakery example opens with the entry form',
  );

  assert.deepEqual(
    missingPhrases(await readSkillSection('where-i-stand', '## Who writes, and when'), [
      'Every entry this table names is written in the entry form "Writing rules for the page" gives.',
    ]),
    [],
  );

  const law = unwrap(await readFile(resolve(REPOSITORY_ROOT, 'AGENTS.md'), 'utf8'));
  assert.deepEqual(
    missingPhrases(law, [
      "Every entry starts with the three lines of the page's entry form those rules give: its links, its kind and where it stands.",
      "writing the entry in the page's entry form",
      "keeping the page's entry form",
    ]),
    [],
  );
  for (const [skillName, heading] of [
    ['queue-objective', "### 6b. Put the row on the Lord's page"],
    ['amendment', "## Correct the Lord's page when the amendment changes what the row is"],
    ['write-and-execute-todos', "## The Lord's page — when an Alpha writes it"],
  ]) {
    assert.ok(
      (await readSkillSection(skillName, heading)).includes('entry form'),
      `${skillName} "${heading}" points at the entry form`,
    );
  }
});

test('the where-i-stand skill says the check refuses a delivered entry without its links line', async () => {
  const whoWrites = await readSkillSection('where-i-stand', '## Who writes, and when');
  assert.ok(
    whoWrites.includes(
      'until the campaign wrote its entry after its `REPORT.md`, moved it out of `## In flight`, and started it with its links line.',
    ),
    'the sentence on the delivery check names every refusal',
  );
});

test("the record step writes its entry in the page's entry form", async () => {
  const recordStep = await readSkillSection('execute-todos', RECORD_STEP_HEADING);
  assert.deepEqual(
    missingPhrases(recordStep, [
      "Its first lines are the page's entry form, as the where-i-stand skill's \"Writing rules for the page\" gives it: `- Links: …`, `- Kind: …`, `- Where it stands: …`.",
      "Each of these writes starts the entry with the page's entry form, as step 2 does.",
    ]),
    [],
  );
  assert.deepEqual(
    missingPhrases(await readSkillSection('write-todos', '## The record step (`99d_record_<topic>.md`)'), [
      "Start it with the page's entry form from the where-i-stand skill's \"Writing rules for the page\": its `- Links: …`, `- Kind: …` and `- Where it stands: …` lines.",
      'starting with its links, kind and where-it-stands lines',
    ]),
    [],
  );
  assert.ok(
    (await readSkillSection('execute-todos', '## Shadowless mode — Lord-authorized only')).includes(ENTRY_FORM_REFERENCE),
    'the shadowless record step names the entry form',
  );
  assert.ok(
    (await readSkillSection('execute-todos', '## Sliceless mode — Lord-authorized only')).includes(ENTRY_FORM_REFERENCE),
    'the sliceless record step names the entry form',
  );
});

test("AGENTS.md tells the Stager, the Alpha and the Regent when to write the Lord's page", async () => {
  const law = unwrap(await readFile(resolve(REPOSITORY_ROOT, 'AGENTS.md'), 'utf8'));
  assert.deepEqual(
    missingPhrases(law, [
      "**A Stager writes the Lord's page when it files and when it amends.**",
      'adds the row\'s entry, `### <objective code>`, under `## Queued and deferred`',
      'When it records an amendment that changes what the row is, it corrects that entry',
      "**An Alpha keeps its campaign's entry on the Lord's page.**",
      'At launch it moves the entry to `## In flight`',
      'it puts an entry under `## Needs you` with the question in one sentence, and adds a note',
      'When it unblocks it removes that entry and adds a note',
      'At delivery it moves the entry to `## Delivered, not on GitHub` or `## On GitHub`',
      'Only the delivery write is enforced',
      "**The Regent writes the Lord's page when it abandons, defers or releases a row.**",
    ]),
    [],
  );

  assert.deepEqual(
    missingPhrases(await readSkillSection('queue-objective', "### 6b. Put the row on the Lord's page"), [
      'add an entry `### <code>` under `## Queued and deferred`',
      'throne where-i-stand note "filed <code>: <what it is in one line>"',
    ]),
    [],
  );
  assert.deepEqual(
    missingPhrases(
      await readSkillSection('amendment', "## Correct the Lord's page when the amendment changes what the row is"),
      ['correct the entry in the same sitting', 'throne where-i-stand note "amended <code>: <what changed>"'],
    ),
    [],
  );
  assert.deepEqual(
    missingPhrases(
      await readSkillSection('write-and-execute-todos', "## The Lord's page — when an Alpha writes it"),
      [
        '**At launch**, before planning: move the entry to `## In flight`',
        '**When you block on something only the Lord can settle**',
        '**When you unblock**',
        '**At delivery**: the `99d` record step',
      ],
    ),
    [],
  );
});

test("every bundle ends with a step that records the outcome on the Lord's page", async () => {
  const planningSkill = await readSkill('write-todos');
  assert.deepEqual(
    missingPhrases(planningSkill, [
      'Every bundle is bracketed by five auto-included bookends',
      '└── 99d_record_<topic>.md',
      "99d — Record the outcome on the Lord's page",
      '`00`, `99a`, `99b`, `99c`, and `99d` are non-negotiable — every new bundle ships with all five.',
      'Then write `99d_record_<topic>.md` (see "The record step" below) with `deps: [99c]`',
    ]),
    [],
  );
  assert.deepEqual(
    missingPhrases(await readSkillSection('write-todos', '## The record step (`99d_record_<topic>.md`)'), [
      'It is not a gate and no Shadow runs it: the Alpha performs it itself',
      '`99c` stays the last todo a Shadow executes',
      'deps: [99c]',
      '`throne check-where-i-stand --agent <alpha-name>` must pass',
    ]),
    [],
  );

  const recordStep = await readSkillSection('execute-todos', RECORD_STEP_HEADING);
  assert.deepEqual(
    missingPhrases(recordStep, [
      'Every bundle ends with one more todo after `99c`: `99d_record_<topic>.md`',
      '**The Alpha performs this step itself. It is not a gate.**',
      '`99a`, `99b` and `99c` remain real, fresh Shadows',
      'to `## On GitHub` when the work has a pull request on GitHub, otherwise to `## Delivered, not on GitHub`',
      'one honest line on what is and is not verified',
      'Remove any `## Needs you` line this delivery settled',
      'throne where-i-stand note "delivered <objective code>: <one line>"',
      'Run `throne check-where-i-stand --agent <your-name>`. It must pass.',
    ]),
    [],
  );
  const deliveryOrder = [
    '1. `99c` reports `**Delivery outcome:** PASS`.',
    '3. You write `REPORT.md`.',
    '4. You perform this step.',
    '5. You report DONE to your supervisor.',
  ].map((moment) => recordStep.indexOf(moment));
  assert.ok(!deliveryOrder.includes(-1), 'the record step states its place in the delivery order');
  assert.deepEqual(deliveryOrder, [...deliveryOrder].sort((first, second) => first - second));

  assert.deepEqual(
    missingPhrases(await readSkillSection('execute-todos', '## Final report shape'), [
      'Only after that file lands do you perform the `99d` record step',
      'only after its check passes do you send the chat summary to your supervisor',
    ]),
    [],
  );
});

test('shadowless and sliceless campaigns record the outcome without a todo file', async () => {
  assert.deepEqual(
    missingPhrases(await readSkillSection('execute-todos', '## Shadowless mode — Lord-authorized only'), [
      'After the delivery pass and `REPORT.md`, you perform the `99d` record step',
      'The step does not depend on a todo file',
    ]),
    [],
  );
  assert.deepEqual(
    missingPhrases(await readSkillSection('execute-todos', '## Sliceless mode — Lord-authorized only'), [
      "Record the outcome on the Lord's page without a todo file.",
      'there is no `99d_record_` file to read',
      'report DONE only after `throne check-where-i-stand --agent <your-name>` passes',
    ]),
    [],
  );
});

test('the record step corrects every other entry about the same work', async () => {
  assert.deepEqual(
    missingPhrases(await readSkillSection('execute-todos', RECORD_STEP_HEADING), [
      '3. Correct every other entry about the same work.',
      'a Forgejo pull request and its GitHub twin are the same work',
      'when neither has a pull request, the same ticket and the same commit or branch',
      '`throne forge status <pull request url> --json` (its `mergeTarget`) and write both',
      'remove it, when your entry now says everything it said',
      'correct its `Where it stands:` and state lines to the new truth and add one line ``Superseded by `### <objective code>` on <date>``',
      '`throne check-where-i-stand` refuses while such an older entry stands uncorrected, naming the entry and the line to fix.',
    ]),
    [],
  );
  const law = unwrap(await readFile(resolve(REPOSITORY_ROOT, 'AGENTS.md'), 'utf8'));
  assert.deepEqual(
    missingPhrases(law, [
      'removes every other entry about the same work or marks it superseded, and adds a note',
      'and while an older entry about the same work stands uncorrected',
    ]),
    [],
  );
});

test('shadowless and sliceless campaigns correct older entries about the same work too', async () => {
  assert.deepEqual(
    missingPhrases(await readSkillSection('execute-todos', '## Shadowless mode — Lord-authorized only'), [
      'correcting every other entry about the same work as its step 3 says',
    ]),
    [],
  );
  assert.deepEqual(
    missingPhrases(await readSkillSection('execute-todos', '## Sliceless mode — Lord-authorized only'), [
      'correcting every other entry about the same work is part of the record, as step 3 there says',
    ]),
    [],
  );
});

test("every bundle's record step corrects older entries about the same work", async () => {
  assert.deepEqual(
    missingPhrases(await readSkillSection('write-todos', '## The record step (`99d_record_<topic>.md`)'), [
      '2. Correct every other entry about the same work',
      '`throne forge status <pull request url> --json` (its `mergeTarget`) and write both',
      'add one line ``Superseded by `### <objective code>` on <date>``',
      'No other entry about the same work is left uncorrected',
    ]),
    [],
  );
});

test('the where-i-stand skill tells every role to supersede older entries about the same work', async () => {
  assert.deepEqual(
    missingPhrases(await readSkillSection('where-i-stand', '## Writing rules for the page'), [
      'One current entry per piece of work.',
      'Whoever records a newer state of some work, Stager, Regent or Alpha, removes every other entry about the same work',
      'adds one line ``Superseded by `### <code>` on <date>``',
      'a Forgejo pull request and its GitHub twin are one piece of work',
    ]),
    [],
  );
  assert.deepEqual(
    missingPhrases(await readSkillSection('where-i-stand', '## Who writes, and when'), [
      'every other entry about the same work is removed or marked superseded, and a note',
      'It also refuses while another entry about the same work, last written before the campaign\'s entry, is neither removed nor marked `Superseded by`; the refusal names that entry\'s heading and the line to fix.',
    ]),
    [],
  );
  assert.deepEqual(
    missingPhrases(await readSkillSection('where-i-stand', STEP_HEADINGS[3]), [
      'remove or mark superseded every other entry about the same work as an entry you corrected',
    ]),
    [],
  );
});

test("the copied reader's own tests pass", async () => {
  const { stderr } = await promisify(execFile)('python3', ['test_where_i_stand.py'], {
    cwd: PAGE_SKILL_DIRECTORY,
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.match(stderr, /Ran \d+ tests/);
});
