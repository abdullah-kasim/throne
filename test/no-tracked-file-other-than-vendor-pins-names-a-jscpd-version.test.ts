import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const PIN_FILE = "vendor-pins.json";
const VERSION_MENTION = /jscpd[@ ]\d/;

async function trackedFiles(): Promise<string[]> {
  const { stdout } = await promisify(execFile)("git", ["ls-files", "-z"], {
    cwd: REPOSITORY_ROOT,
  });
  return stdout.split("\0").filter((name) => name !== "" && name !== PIN_FILE);
}

async function versionMentions(): Promise<string[]> {
  const mentions: string[] = [];
  for (const name of await trackedFiles()) {
    const text = await readFile(resolve(REPOSITORY_ROOT, name), "utf8").catch(
      () => "",
    );
    if (!VERSION_MENTION.test(text)) continue;
    text.split("\n").forEach((line, index) => {
      if (VERSION_MENTION.test(line))
        mentions.push(`${name}:${index + 1}: ${line.trim()}`);
    });
  }
  return mentions;
}

test("no tracked file other than vendor-pins.json names a jscpd version", async () => {
  assert.deepEqual(await versionMentions(), []);
});
