import { test } from "node:test";
import assert from "node:assert/strict";
import { styledLinesFromAnsi } from "./ansi.ts";
import { readPiComposer } from "./pi-composer.ts";

const RULES = "─".repeat(30);

test("readPiComposer reads the draft under a top border whose name badge holds a rule character", () => {
  const screen = [`${RULES} build─fix ─`, "hello there", RULES].join("\n");
  assert.deepEqual(readPiComposer(styledLinesFromAnsi(screen)), { state: "draft", text: "hello there" });
});
