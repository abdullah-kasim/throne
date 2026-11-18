import assert from "node:assert/strict";
import { test } from "node:test";
import { piStartState } from "../scripts/pi-evidence/support.mjs";

const COMMAND = `env PI_BIN='/x/cli.js' '/repo/bin/piy' '--model' 'deepseek-v5-flash' '--session' 'abc'; echo "pi exited with status $?"`;

test("the launch command echoed twice by the shell still does not count as pi having started", () => {
  const pane = `${COMMAND}\n\nrepository on master\n[ 14:36:50 ] ${COMMAND}\nhint: Using 'master'\n`;
  assert.deepEqual(piStartState(pane, "deepseek-v5-flash"), { state: "waiting" });
});

test("the model id inside the echoed launch command alone does not count as pi having started", () => {
  const pane = `$ env PI_BIN='/x/cli.js' '/repo/bin/piy' '--model' 'deepseek-v5-\nflash' '--session' 'abc'; echo "pi exited with status $?"\n`;
  assert.deepEqual(piStartState(pane, "deepseek-v5-flash"), { state: "waiting" });
});

test("a piy that exits before drawing is a failure naming its exit status and its own message", () => {
  const pane = `$ ${COMMAND}\npiy: no pi found: set PI_BIN\npi exited with status 127\n$ `;
  assert.deepEqual(piStartState(pane, "deepseek-v5-flash"), {
    state: "exited",
    cause: "pi exited with status 127 before drawing deepseek-v5-flash: piy: no pi found: set PI_BIN",
  });
});

test("pi drawing the model in its own footer counts as started", () => {
  const pane = `$ ${COMMAND}\n\n ~/repo   deepseek-v5-flash • medium\n`;
  assert.deepEqual(piStartState(pane, "deepseek-v5-flash"), { state: "drawn" });
});

test("pi's full screen with the launch command scrolled away counts as started", () => {
  const pane = `\n> \n0.0%/128k (auto)        deepseek-v5-flash\n`;
  assert.deepEqual(piStartState(pane, "deepseek-v5-flash"), { state: "drawn" });
});
