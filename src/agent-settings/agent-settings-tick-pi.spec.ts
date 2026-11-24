import assert from "node:assert/strict";
import { test } from "node:test";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import { runAgentSettingsTick } from "./agent-settings-tick.ts";
import {
  DRY_RUN,
  REAL_RUN,
  commandsTypedInto,
  courtWith,
  lineOf,
  shadowWithTheWrongColour,
} from "./agent-settings-tick.test-support.ts";

test("the settings tick renames a live pi agent whose session name drifted", async () => {
  const court = await courtWith({
    liveAgents: [
      {
        name: "shadow-pi-02",
        role: "Shadow",
        harness: HARNESS_NAMES.PI,
        session: { colour: "blue", sessionName: "drifted" },
      },
    ],
  });

  const lines = await runAgentSettingsTick(REAL_RUN, court.deps);

  assert.deepEqual(commandsTypedInto(court, "shadow-pi-02"), ["/color purple", "/rename shadow-pi-02"]);
  assert.equal(
    lineOf(lines, "shadow-pi-02"),
    "shadow-pi-02: colour is blue, set to purple (try 1 of 3); name is drifted, set to shadow-pi-02 (try 1 of 3)",
  );
});

test("a dry run of the tick changes nothing on a pi agent", async () => {
  const court = await courtWith({
    liveAgents: [{ ...shadowWithTheWrongColour("shadow-pi-03"), harness: HARNESS_NAMES.PI }],
  });

  const lines = await runAgentSettingsTick(DRY_RUN, court.deps);

  assert.deepEqual(court.typed, []);
  assert.equal(
    lineOf(lines, "shadow-pi-03"),
    "shadow-pi-03: colour is blue, would be set to purple; name shadow-pi-03 is right",
  );
});
