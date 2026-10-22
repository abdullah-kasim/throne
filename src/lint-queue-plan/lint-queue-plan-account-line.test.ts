import assert from "node:assert/strict";
import { test } from "node:test";
import { lintQueuePlanBody } from "./lint-queue-plan.ts";
import { parseAddToQueueArgs } from "../add-to-queue/add-to-queue-runtime.ts";

const LAUNCH_READY_BODY = [
  "INTENT: read the tracker through its MCP server.",
  "SCOPE: one report.",
  "RULINGS: none.",
  "VERIFIED-NOUNS: render-queue.",
  "REUSE: none found.",
].join("\n");

function fileRow(body: string) {
  return parseAddToQueueArgs(["--objective-code", "acq", "--target-repo", "/tmp/example-target", body]);
}

test("a queue row marked ACCOUNT: company passes the plan lint", () => {
  assert.deepEqual(lintQueuePlanBody(`${LAUNCH_READY_BODY}\nACCOUNT: company`), []);
});

test("a queue row with an unknown ACCOUNT value fails the plan lint", () => {
  const failures = lintQueuePlanBody(`${LAUNCH_READY_BODY}\nACCOUNT: personal`);
  assert.equal(failures.length, 1, JSON.stringify(failures));
  assert.match(failures[0]!, /"personal"/);
  assert.match(failures[0]!, /only accepted value is "company"/);
});

test("the ACCOUNT line is not a required section of a launch-ready plan", () => {
  assert.deepEqual(lintQueuePlanBody(LAUNCH_READY_BODY), []);
});

test("add-to-queue refuses a row with an unknown ACCOUNT value and files a company row", () => {
  assert.throws(() => fileRow(`${LAUNCH_READY_BODY}\nACCOUNT: Company`), /only accepted value is "company"/);
  assert.equal(fileRow(`${LAUNCH_READY_BODY}\nACCOUNT: company`).body.endsWith("ACCOUNT: company"), true);
});
