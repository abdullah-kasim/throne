import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMMAND_REGISTRY,
  internalDispatchableCommandNames,
  publicCommandNames,
} from "../src/shared-policy/command-registry.ts";

test("the status command is no longer offered by the CLI", () => {
  assert.equal(
    COMMAND_REGISTRY.some((entry) => entry.name === "status"),
    false,
  );
  assert.equal(publicCommandNames().includes("status"), false);
});

test("the status tab poll loop is no longer offered by the CLI", () => {
  assert.equal(
    COMMAND_REGISTRY.some((entry) => entry.name === "status-tab-poll"),
    false,
  );
  assert.equal(
    internalDispatchableCommandNames().includes("status-tab-poll"),
    false,
  );
});

test("no registry entry refers to a command that does not exist", () => {
  for (const entry of COMMAND_REGISTRY) {
    assert.equal(typeof entry.provider, "function", entry.name);
    assert.equal(typeof entry.provider.prototype, "object", entry.name);
    assert.ok(entry.provider.name.length > 0, entry.name);
  }
});

test("the status-tab-poll loop no longer recreates the throne root after a wipe", async () => {
  await assert.rejects(
    import("../src/status/provision-status-tab.ts"),
  );
  await assert.rejects(
    import("../src/throne-backend/tab-keep-aliver.hosted-worker.ts"),
  );
});
