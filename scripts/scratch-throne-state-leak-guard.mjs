import { mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const scratchRoot = path.join(os.homedir(), "tmp");
const fixturePrefix = "throne-scratch-state-";
const snapshotPath = path.join(
  scratchRoot,
  `throne-scratch-state-leak-guard-${process.env.THRONE_SUITE_RUN_ID ?? "standalone"}.json`,
);

export function listScratchStateResidue(root = scratchRoot) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(fixturePrefix))
      .map((entry) => path.join(root, entry.name))
      .sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export function findLeakedScratchState(before, after) {
  const known = new Set(before);
  return after.filter((entry) => !known.has(entry));
}

function runPretest() {
  mkdirSync(scratchRoot, { recursive: true });
  writeFileSync(snapshotPath, JSON.stringify(listScratchStateResidue()), "utf8");
}

function runPosttest() {
  const before = JSON.parse(readFileSync(snapshotPath, "utf8"));
  rmSync(snapshotPath, { force: true });
  const leaked = findLeakedScratchState(before, listScratchStateResidue());
  if (leaked.length === 0) return;
  console.error(
    `scratch-throne-state-leak-guard: ${leaked.length} durable state fixture(s) leaked by this test run:\n` +
      leaked.map((entry) => `  - ${entry}`).join("\n"),
  );
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2];
  if (mode === "pretest") runPretest();
  else if (mode === "posttest") runPosttest();
  else {
    console.error(
      `scratch-throne-state-leak-guard: unknown mode "${mode}" — expected "pretest" or "posttest"`,
    );
    process.exitCode = 1;
  }
}
