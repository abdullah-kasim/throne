import assert from 'node:assert/strict';
import { test } from 'node:test';
import { submittedPayload } from '../herdr/herdr-send.helpers.ts';
import { OTHER_PROMPT, RELAYED_PROMPT, promptKindOf } from '../memory-recall/prompt-kind.ts';
import { lastMessageBlock } from '../no-idling/idle-pane-tag-classification.ts';
import { deliveryReceiptVerdict } from './delivery-receipt-verdict.ts';

const MESSAGE_ID = 12;
const TYPED_TEXT = submittedPayload('alpha-example', 'line one\nline two', { messageId: MESSAGE_ID });

function transcriptOf(...texts: string[]): string {
  return texts
    .map((content) => JSON.stringify({ type: 'user', message: { role: 'user', content } }))
    .join('\n');
}

function chipFolded(text: string): string {
  return `\n\n<pasted_content id="4936">\n${text}\n</pasted_content id="4936">`;
}

test('a whole tagged message is reported intact', () => {
  assert.equal(deliveryReceiptVerdict(TYPED_TEXT, MESSAGE_ID, transcriptOf(TYPED_TEXT)), 'intact');
});

test('a whole tagged message folded into a pasted chip is reported intact', () => {
  assert.equal(
    deliveryReceiptVerdict(TYPED_TEXT, MESSAGE_ID, transcriptOf(chipFolded(TYPED_TEXT))),
    'intact',
  );
});

test('a message with only its opening tag is reported truncated', () => {
  const headOnly = '<message12>\nalpha-example said: line one';
  assert.equal(deliveryReceiptVerdict(TYPED_TEXT, MESSAGE_ID, transcriptOf(headOnly)), 'truncated');
});

test('a message with only its closing tag is reported truncated', () => {
  const tailOnly = 'line two\n</message12>';
  assert.equal(deliveryReceiptVerdict(TYPED_TEXT, MESSAGE_ID, transcriptOf(tailOnly)), 'truncated');
});

test('a message with both tags but a cut middle is reported truncated', () => {
  const middleCut = '<message12>\nalpha-example said: line one\n</message12>';
  assert.equal(deliveryReceiptVerdict(TYPED_TEXT, MESSAGE_ID, transcriptOf(middleCut)), 'truncated');
});

test('a message with neither tag nor old number is reported absent', () => {
  assert.equal(deliveryReceiptVerdict(TYPED_TEXT, MESSAGE_ID, transcriptOf('something else')), 'absent');
});

test('tags with different numbers are not a pair', () => {
  const otherPair = '<message123>\nalpha-example said: line one\nline two\n</message123>';
  assert.equal(deliveryReceiptVerdict(TYPED_TEXT, MESSAGE_ID, transcriptOf(otherPair)), 'absent');
  const mismatched = '<message12>\nalpha-example said: line one\nline two\n</message123>';
  assert.equal(deliveryReceiptVerdict(TYPED_TEXT, MESSAGE_ID, transcriptOf(mismatched)), 'truncated');
});

test('a message in the old trailing-number form is still recognised', () => {
  const oldTyped = 'alpha-example said: hello [message 12]';
  assert.equal(deliveryReceiptVerdict(oldTyped, MESSAGE_ID, transcriptOf(oldTyped)), 'intact');
  assert.equal(
    deliveryReceiptVerdict(oldTyped, MESSAGE_ID, transcriptOf('hello [message 12]')),
    'truncated',
  );
  assert.equal(promptKindOf(oldTyped), RELAYED_PROMPT);
});

test('a tagged message is classified as delivered whole, cut, or folded into a chip', () => {
  assert.equal(promptKindOf(TYPED_TEXT), RELAYED_PROMPT);
  assert.equal(promptKindOf('<message12>\nalpha-example said: line one'), RELAYED_PROMPT);
  assert.equal(promptKindOf('line two\n</message12>'), RELAYED_PROMPT);
  assert.equal(promptKindOf(chipFolded(TYPED_TEXT)), RELAYED_PROMPT);
  assert.equal(promptKindOf('<system-reminder>hello</system-reminder>'), OTHER_PROMPT);
});

test('a pane reply after a tagged message is read without the closing tag', () => {
  const pane = ['› <message12>', 'alpha-example said: report', '</message12>', '{"blocked":true}'].join('\n');
  assert.equal(lastMessageBlock(pane), '{"blocked":true}');
});
