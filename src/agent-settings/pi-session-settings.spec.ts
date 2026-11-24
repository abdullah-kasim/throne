import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { piSessionDirectory } from "../create-agent/pi-launch.ts";
import { readPiSessionSettings } from "./pi-session-settings.ts";

test("the settings tick reads a pi agent's name and colour from its session", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "pi-session-settings-"));
  const sessionFolder = piSessionDirectory("shadow-pi-01", dataDirectory);
  await mkdir(sessionFolder, { recursive: true });
  const entries = [
    { type: "session", id: "session-of-shadow-pi-01" },
    { type: "session_info", name: "old-name" },
    { type: "custom", customType: "throne-agent-colour", data: { colour: "blue" } },
    { type: "session_info", name: "shadow-pi-01" },
    { type: "custom", customType: "another-extension", data: { colour: "red" } },
    { type: "custom", customType: "throne-agent-colour", data: { colour: "purple" } },
  ];
  await writeFile(
    path.join(sessionFolder, "2026-11-24T10-00-00-000Z_session-of-shadow-pi-01.jsonl"),
    entries.map((entry) => JSON.stringify(entry)).join("\n"),
  );
  await writeFile(
    path.join(sessionFolder, "2026-11-24T09-00-00-000Z_another-session.jsonl"),
    JSON.stringify({ type: "session_info", name: "someone-else" }),
  );

  assert.deepEqual(await readPiSessionSettings("shadow-pi-01", "session-of-shadow-pi-01", dataDirectory), {
    colour: "purple",
    sessionName: "shadow-pi-01",
  });
  assert.deepEqual(await readPiSessionSettings("shadow-pi-01", "missing-session", dataDirectory), {
    colour: undefined,
    sessionName: undefined,
  });
});
