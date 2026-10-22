import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { recordDeliveredSupervisionEvent } from "./alpha-monitoring.ts";

test("a Shadow's report to its Alpha counts as completion whatever the case of its leading done", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "alpha-monitoring-"));
  try {
    const statePath = path.join(dir, "state.json");
    const dependencies = {
      resolveCaller: async () => null,
      now: () => 1,
      statePath,
      lockPath: path.join(dir, "lock"),
    };
    for (const prompt of ["DONE: slice merged", "Done: slice merged", "done, slice merged"]) {
      const eventId = await recordDeliveredSupervisionEvent(
        {
          sender: "shadow-flying-01",
          senderRole: "Shadow",
          senderSupervisor: "alpha-flying-01",
          recipient: "alpha-flying-01",
          recipientRole: "Alpha",
          prompt,
        },
        dependencies,
      );
      assert.notEqual(eventId, null, prompt);
      const state = JSON.parse(await readFile(statePath, "utf8"));
      assert.equal(state.trustedEvents[eventId!].context, "completion", prompt);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
