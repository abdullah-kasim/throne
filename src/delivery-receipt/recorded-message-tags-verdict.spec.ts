import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  deliveryReceiptVerdict,
  type DeliveryReceiptVerdict,
} from "./delivery-receipt-verdict.ts";

const FIXTURES_DIRECTORY = path.join(import.meta.dirname, "fixtures");
const SHORT_MESSAGE_ID = 1;
const LONG_PASTE_ID = 3;
const DELIVERY_NOTICE_ID = 6;
const ID_NEVER_DELIVERED = 2;

async function verdictOfRecording(
  fixtureName: string,
  messageId: number,
  typedTextId = messageId,
): Promise<DeliveryReceiptVerdict> {
  const typedTexts = JSON.parse(
    await readFile(path.join(FIXTURES_DIRECTORY, "typed-texts.json"), "utf8"),
  ) as Record<string, string>;
  const transcript = await readFile(
    path.join(FIXTURES_DIRECTORY, `${fixtureName}.jsonl`),
    "utf8",
  );
  return deliveryReceiptVerdict(
    typedTexts[String(typedTextId)]!,
    messageId,
    transcript,
  );
}

test("a tagged message delivered to a real Claude pane is reported intact", async () => {
  assert.equal(
    await verdictOfRecording(
      "scratch-pane-tagged-message-claude",
      SHORT_MESSAGE_ID,
    ),
    "intact",
  );
});

test("a tagged long message folded into a pasted chip on a real Claude pane is reported intact", async () => {
  assert.equal(
    await verdictOfRecording(
      "scratch-pane-tagged-long-paste-claude",
      LONG_PASTE_ID,
    ),
    "intact",
  );
});

test("a tagged delivery notice on a real Claude pane is reported intact", async () => {
  assert.equal(
    await verdictOfRecording(
      "scratch-pane-tagged-delivery-notice-claude",
      DELIVERY_NOTICE_ID,
    ),
    "intact",
  );
});

test("a recorded message edited down to its opening tag is reported truncated", async () => {
  assert.equal(
    await verdictOfRecording(
      "scratch-pane-tagged-message-claude-edited-opening-tag-only",
      SHORT_MESSAGE_ID,
    ),
    "truncated",
  );
});

test("a recorded message edited down to its closing tag is reported truncated", async () => {
  assert.equal(
    await verdictOfRecording(
      "scratch-pane-tagged-message-claude-edited-closing-tag-only",
      SHORT_MESSAGE_ID,
    ),
    "truncated",
  );
});

test("a recorded transcript is reported absent for a message id it never received", async () => {
  assert.equal(
    await verdictOfRecording(
      "scratch-pane-tagged-message-claude",
      ID_NEVER_DELIVERED,
      SHORT_MESSAGE_ID,
    ),
    "absent",
  );
});
