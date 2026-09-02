import assert from "node:assert/strict";
import test from "node:test";
import {
  IncompleteHerdrPaneProcessInfoError,
  parsePaneProcessInfo,
} from "../src/herdr/herdr-inventory.service.ts";

function processInfoJson(rows: unknown[]): string {
  return JSON.stringify({
    id: "cli:pane:process_info",
    result: { process_info: { pane_id: "w1:p2", foreground_processes: rows } },
  });
}

// The exact shape macOS herdr v0.8.2 reported for a claude session's MCP
// child on 2026-09-02: a name and argv0 but no argv, permanently.
test("a foreground row with a name and argv0 but no argv is accepted, not retried forever", () => {
  const info = parsePaneProcessInfo(
    processInfoJson([
      { argv0: "mcp-context-a8c", cwd: "/Users/theuser", name: "node", pid: 61221 },
      {
        argv: ["/Users/theuser/.local/bin/claude", "--dangerously-skip-permissions"],
        argv0: "claude",
        name: "2.1.258",
        pid: 61101,
      },
    ]),
  );
  assert.equal(info.paneId, "w1:p2");
  assert.deepEqual(info.foregroundProcesses[0], {
    name: "node",
    argv: ["mcp-context-a8c"],
    cwd: "/Users/theuser",
    pid: 61221,
  });
  assert.deepEqual(info.foregroundProcesses[1]?.argv, [
    "/Users/theuser/.local/bin/claude",
    "--dangerously-skip-permissions",
  ]);
});

test("a foreground row with only a name still yields an argv the classifiers can read", () => {
  const info = parsePaneProcessInfo(processInfoJson([{ name: "vim", pid: 7 }]));
  assert.deepEqual(info.foregroundProcesses[0], {
    name: "vim",
    argv: ["vim"],
    cwd: undefined,
    pid: 7,
  });
});

test("a foreground row with argv but no name takes its name from argv[0]", () => {
  const info = parsePaneProcessInfo(processInfoJson([{ argv: ["/usr/bin/vim", "notes.md"] }]));
  assert.equal(info.foregroundProcesses[0]?.name, "/usr/bin/vim");
});

test("a foreground row with no name, no argv and no argv0 is still refused", () => {
  assert.throws(
    () => parsePaneProcessInfo(processInfoJson([{ pid: 9, cwd: "/" }])),
    (error: unknown) =>
      error instanceof IncompleteHerdrPaneProcessInfoError &&
      error.message.includes("process row 0 is missing name / argv"),
  );
});
