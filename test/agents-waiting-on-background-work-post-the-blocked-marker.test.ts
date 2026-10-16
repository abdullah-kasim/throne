import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { composeOpeningPrompt } from '../src/agentdata/identity-data.service.ts';
import { classifyLastMessageTags } from '../src/no-idling/idle-pane-tag-classification.ts';
import {
  missingPhrases,
  readMarkdownSection,
  readSkillSource,
  unwrap,
} from './skill-contract-test-helpers.ts';

const BACKGROUND_WAIT_MARKER = '`{"blocked":true} BLOCKED_BY_own-background-run (<what>)`';
const NEXT_MESSAGE_CLEARS_IT = 'next ordinary message clears';
const REASON = 'Otherwise no-idling pages the Regent every minute';
const REGENT_SEND_LINE =
  "`throne send-agent <agent> 'Publish {\"blocked\":true} BLOCKED_BY_own-background-run (<what>) as your latest message; clear it when you resume.'`";

async function readAgentsFile(): Promise<string> {
  return unwrap(await readFile(resolve(import.meta.dirname, '..', 'AGENTS.md'), 'utf8'));
}

async function readSkillSection(skillName: string, heading: string): Promise<string> {
  const section = readMarkdownSection(await readSkillSource(skillName), heading);
  assert.notEqual(section, '', `${skillName} has the section "${heading}"`);
  return unwrap(section);
}

test('agents are told to end a turn waiting on background work with the blocked marker naming what they wait for', async () => {
  const places: Array<[string, string]> = [
    ['AGENTS.md', await readAgentsFile()],
    [
      'execute-todos Shadow assignment rule',
      await readSkillSection('execute-todos', '### 4. Every worker MUST read the global CLAUDE.md'),
    ],
    [
      'execute-todos terminal suite run',
      await readSkillSection('execute-todos', '#### Three verification layers, and the layers are not interchangeable'),
    ],
    ['write-todos slice template', await readSkillSection('write-todos', '## What goes in a todo file')],
    [
      'write-todos 99a template',
      await readSkillSection('write-todos', '## The conformance todo (`99a_conform_<topic>.md`)'),
    ],
    [
      'write-todos 99b template',
      await readSkillSection('write-todos', '## The verify todo (`99b_verify_<topic>.md`)'),
    ],
  ];
  for (const [place, text] of places) {
    assert.deepEqual(
      missingPhrases(text, [BACKGROUND_WAIT_MARKER, NEXT_MESSAGE_CLEARS_IT, REASON]),
      [],
      `${place} carries the background-wait rule`,
    );
  }
});

test('the regent is told the exact line to send an agent waiting on background work', async () => {
  const agents = await readAgentsFile();
  assert.deepEqual(
    missingPhrases(agents, [
      'When a no-idling notice names an agent "waiting on background work", the Regent sends it exactly',
      REGENT_SEND_LINE,
      'once per agent per wait',
      'the Regent never reaps it and never sends it a generic continue',
    ]),
    [],
  );
});

test('every agent identity prompt covers waiting on background work', () => {
  for (const role of ['Alpha', 'Shadow'] as const) {
    const prompt = composeOpeningPrompt(`${role.toLowerCase()}-test`, {
      supervisor: 'Regent',
      escalation: 'Regent',
      role,
    });
    assert.deepEqual(
      missingPhrases(unwrap(prompt), [
        'When you end a turn to wait on background work you started',
        BACKGROUND_WAIT_MARKER,
        NEXT_MESSAGE_CLEARS_IT,
      ]),
      [],
      `the ${role} prompt carries the background-wait rule`,
    );
    assert.match(prompt, /Otherwise no-idling pages the \S+ every minute/);
  }
});

test('the marker the rule teaches is read as waiting on the agent\'s own background run', () => {
  const tag = classifyLastMessageTags('Both suite runs are queued.\n\n{"blocked":true} BLOCKED_BY_own-background-run (candidate and base suites)');
  assert.deepEqual(tag, { kind: 'blocked', blockedBy: [], waitsOnOwnBackgroundRun: true });
});
