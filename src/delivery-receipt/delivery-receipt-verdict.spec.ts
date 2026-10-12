import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { deliveredTexts, deliveryReceiptVerdict } from './delivery-receipt-verdict.ts';

const FIXTURES_DIRECTORY = path.join(import.meta.dirname, 'fixtures');

function fixtureTranscript(name: string): Promise<string> {
  return readFile(path.join(FIXTURES_DIRECTORY, `${name}.jsonl`), 'utf8');
}

const TYPED_TEXTS = JSON.parse(
  await readFile(path.join(FIXTURES_DIRECTORY, 'typed-texts.json'), 'utf8'),
) as Record<string, string>;

function typedText(messageId: number): string {
  const text = TYPED_TEXTS[String(messageId)];
  assert.ok(text, `no typed text recorded for message ${messageId}`);
  return text;
}

function verdictFor(messageId: number, transcript: string) {
  return deliveryReceiptVerdict(typedText(messageId), messageId, transcript);
}

function userRecord(content: unknown, extra: object = {}): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content }, ...extra })}\n`;
}

const WHOLE_MULTI_CHIP_PASTE = 10982;
const CUT_MID_TURN_RESEND = 10983;
const SCRATCH_LONG_PASTE = 990001;
const SCRATCH_MID_TURN = 990003;
const SCRATCH_QUEUED_DURING_A_TOOL_CALL = [990005, 990006] as const;
const SCRATCH_QUEUED_DURING_A_REPLY = [990008, 990009] as const;
const SCRATCH_ID_PRINTED_BY_A_TOOL = 990010;
const SCRATCH_MESSAGE_ASKING_FOR_THE_PRINT = 990011;

test('a multi-chip paste that submitted whole is judged intact', async () => {
  const transcript = await fixtureTranscript('multi-chip-paste-submitted-whole');
  assert.match(transcript, /it hap\\n<\/pasted_content id=\\"4d45\\">\\n\\n\\n<pasted_content id=\\"4d45\\">\\npens, one/);
  assert.equal(verdictFor(WHOLE_MULTI_CHIP_PASTE, transcript), 'intact');
});

test('a message cut while delivered mid-turn is judged truncated', async () => {
  const transcript = await fixtureTranscript('message-cut-while-delivered-mid-turn');
  assert.deepEqual(
    deliveredTexts(transcript).length,
    1,
    'only the queued_command attachment is read, never the two queue-operation records',
  );
  assert.equal(verdictFor(CUT_MID_TURN_RESEND, transcript), 'truncated');
});

test('a transcript holding neither message judges it absent', async () => {
  const transcript = await fixtureTranscript('scratch-pane-message-delivered-mid-turn');
  assert.equal(verdictFor(WHOLE_MULTI_CHIP_PASTE, transcript), 'absent');
  assert.equal(verdictFor(CUT_MID_TURN_RESEND, transcript), 'absent');
  assert.equal(verdictFor(WHOLE_MULTI_CHIP_PASTE, ''), 'absent');
});

test('a long pasted message that was submitted whole is judged intact from the scratch-pane transcript', async () => {
  const transcript = await fixtureTranscript('scratch-pane-long-paste-submitted-whole');
  assert.equal(transcript.split('<pasted_content id=').length - 1, 3);
  assert.match(transcript, /the ledge\\n<\/pasted_content id=\\"f2bf\\">\\n\\n\\n<pasted_content id=\\"f2bf\\">\\nr with a steady hand/);
  assert.equal(verdictFor(SCRATCH_LONG_PASTE, transcript), 'intact');
});

test('a message delivered while the agent was mid-turn is judged intact from the scratch-pane transcript', async () => {
  const transcript = await fixtureTranscript('scratch-pane-message-delivered-mid-turn');
  const recordsCarryingTheMessage = transcript
    .split('\n')
    .filter((line) => line.includes(`[message ${SCRATCH_MID_TURN}]`))
    .map((line) => (JSON.parse(line) as { type: string }).type);
  assert.deepEqual(recordsCarryingTheMessage, ['queue-operation', 'queue-operation', 'attachment']);
  assert.equal(verdictFor(SCRATCH_MID_TURN, transcript), 'intact');
});

test('two messages queued together are each judged intact even when they share one transcript record', async () => {
  const queuedDuringAToolCall = await fixtureTranscript('scratch-pane-two-messages-queued-during-a-tool-call');
  for (const messageId of SCRATCH_QUEUED_DURING_A_TOOL_CALL) {
    assert.equal(verdictFor(messageId, queuedDuringAToolCall), 'intact');
  }
  const queuedDuringAReply = await fixtureTranscript('scratch-pane-two-messages-queued-during-a-reply');
  for (const messageId of SCRATCH_QUEUED_DURING_A_REPLY) {
    assert.equal(verdictFor(messageId, queuedDuringAReply), 'intact');
  }
  const sharingOneRecord = userRecord(SCRATCH_QUEUED_DURING_A_REPLY.map(typedText).join('\n'));
  for (const messageId of SCRATCH_QUEUED_DURING_A_REPLY) {
    assert.equal(verdictFor(messageId, sharingOneRecord), 'intact');
  }
});

test("a message id quoted in the agent's own tool output is not counted as a delivery", async () => {
  const transcript = await fixtureTranscript('scratch-pane-tool-output-quoting-a-message-id');
  assert.match(transcript, /"type":"tool_result","content":"\[message 990010\]"/);
  assert.equal(
    deliveryReceiptVerdict('anything typed', SCRATCH_ID_PRINTED_BY_A_TOOL, transcript),
    'absent',
  );
  assert.equal(verdictFor(SCRATCH_MESSAGE_ASKING_FOR_THE_PRINT, transcript), 'intact');
});

test('a message id that is the prefix of another id is not mistaken for it', async () => {
  const transcript = await fixtureTranscript('scratch-pane-long-paste-submitted-whole');
  const prefixOfTheDeliveredId = Math.floor(SCRATCH_LONG_PASTE / 10);
  assert.equal(
    deliveryReceiptVerdict(typedText(SCRATCH_LONG_PASTE), prefixOfTheDeliveredId, transcript),
    'absent',
  );
  assert.equal(
    deliveryReceiptVerdict('a note [message 12]', 12, userRecord('a note [message 123]')),
    'absent',
  );
});

test('only real user turns and queued-command attachments are read, as plain strings or text blocks', () => {
  const transcript =
    `${JSON.stringify({ type: 'last-prompt' })}\n` +
    `${JSON.stringify({ type: 'attachment', attachment: { type: 'hook_success', prompt: 'hook output' } })}\n` +
    userRecord('Caveat: generated by the harness', { isMeta: true }) +
    userRecord([
      { type: 'text', text: 'first ' },
      { type: 'tool_result', content: 'tool output' },
      { type: 'text', text: 'second' },
    ]) +
    'not json\n' +
    `${JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'queued' } })}\n` +
    userRecord('plain string');
  assert.deepEqual(deliveredTexts(transcript), ['first second', 'queued', 'plain string']);
});
