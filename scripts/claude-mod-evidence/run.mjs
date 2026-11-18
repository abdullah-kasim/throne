import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { selectSpecLines } from "./spec-lines.mjs";

export const MOST_LINES_AT_ONCE = 4;
export const PERSONS_CLAUDE_SETTINGS = [
  path.join(os.homedir(), "dotfiles", "claude", ".claude", "settings.json"),
  path.join(os.homedir(), ".claude.json"),
];
export const LINE_CHECKS_FOLDER = path.join(path.dirname(fileURLToPath(import.meta.url)), "lines");

function lineCheckPath(linesFolder, line) {
  return path.join(linesFolder, `${line}.mjs`);
}

async function openHarness(line, evidenceFolder) {
  const { openIsolatedHarness } = await import("./isolated-harness.mjs");
  return openIsolatedHarness({ line, evidenceFolder });
}

export const RUN_FOLDER_MARK = "/cme-";

export async function checksums(files) {
  return Object.fromEntries(
    await Promise.all(
      files.map(async (file) => {
        const bytes = await readFile(file).catch(() => undefined);
        if (bytes === undefined) return [file, { sha256: "absent", runFolders: 0 }];
        return [file, { sha256: createHash("sha256").update(bytes).digest("hex"), runFolders: bytes.toString("utf8").split(RUN_FOLDER_MARK).length - 1 }];
      }),
    ),
  );
}

function changedFiles(before, after, settingsFile) {
  return Object.keys(before).filter((file) =>
    file === settingsFile ? before[file].sha256 !== after[file].sha256 : after[file].runFolders > before[file].runFolders,
  );
}

async function guardedLine(entry, settings, options) {
  const before = await checksums(settings);
  const result = await runOneLine(entry, options);
  const after = await checksums(settings);
  const changed = changedFiles(before, after, settings[0]);
  if (changed.length === 0) return { ...result, settings_before: before, settings_after: after };
  return {
    ...result,
    settingsChanged: true,
    verdict: "ERROR",
    observed: `the run changed the person's own Claude settings (${changed.join(", ")}); ${result.observed}`,
    settings_before: before,
    settings_after: after,
  };
}

async function runOneLine(entry, { linesFolder, outFolder, open }) {
  const started = Date.now();
  const checkPath = lineCheckPath(linesFolder, entry.line);
  const base = { line: entry.line, expected: entry.expected };
  if (!existsSync(checkPath)) {
    return {
      ...base,
      verdict: "NOT VERIFIED",
      observed: `no check is registered for ${entry.line} yet (expected ${checkPath})`,
      evidence: [],
      error: null,
      seconds: (Date.now() - started) / 1000,
    };
  }
  const evidenceFolder = path.join(outFolder, entry.line);
  let harness;
  try {
    const { check } = await import(pathToFileURL(checkPath).href);
    harness = await open(entry.line, evidenceFolder);
    const result = await check(harness);
    return {
      ...base,
      verdict: result.verdict,
      observed: result.observed,
      ...(result.figures === undefined ? {} : { figures: result.figures }),
      evidence: [...harness.evidence, ...(result.evidence ?? [])],
      error: null,
      seconds: (Date.now() - started) / 1000,
    };
  } catch (error) {
    return {
      ...base,
      verdict: "FAIL",
      observed: "the check stopped with an error",
      evidence: harness?.evidence ?? [],
      error: error instanceof Error ? error.stack ?? error.message : String(error),
      seconds: (Date.now() - started) / 1000,
    };
  } finally {
    await harness?.close();
  }
}

const notRunAfterSettingsChanged = {
  verdict: "ERROR",
  observed: "not run: an earlier line changed the person's own Claude settings, so the run stopped",
  evidence: [],
  error: null,
  seconds: 0,
};

export async function runEvidence({ line, group, outFolder, linesFolder = LINE_CHECKS_FOLDER, open = openHarness, settings = PERSONS_CLAUDE_SETTINGS }) {
  const started = Date.now();
  const selected = selectSpecLines({ line, group });
  const results = new Array(selected.length);
  let next = 0;
  let settingsChanged = false;
  const worker = async () => {
    while (next < selected.length) {
      const index = next++;
      if (settingsChanged) {
        results[index] = { ...notRunAfterSettingsChanged, line: selected[index].line, expected: selected[index].expected };
        continue;
      }
      const { settingsChanged: changed, ...result } = await guardedLine(selected[index], settings, { linesFolder, outFolder, open });
      if (changed) settingsChanged = true;
      results[index] = result;
    }
  };
  await mkdir(outFolder, { recursive: true });
  await Promise.all(Array.from({ length: Math.min(MOST_LINES_AT_ONCE, selected.length) }, worker));
  const log = {
    selection: line ? { line } : { group },
    lines: results,
    run_seconds: (Date.now() - started) / 1000,
  };
  const logPath = path.join(outFolder, "evidence.json");
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  return { log, logPath };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { line: { type: "string" }, group: { type: "string" }, out: { type: "string" } },
  });
  if (Boolean(values.line) === Boolean(values.group)) {
    console.error("usage: bun scripts/claude-mod-evidence/run.mjs (--line <id> | --group <group>) [--out <folder>]");
    process.exit(2);
  }
  const outFolder = path.resolve(
    values.out ?? path.join(os.homedir(), "tmp", "claude-mod-evidence", `${values.line ?? values.group}-${new Date().toISOString().replace(/[:.]/g, "-")}`),
  );
  const { log, logPath } = await runEvidence({ line: values.line, group: values.group, outFolder });
  for (const entry of log.lines) console.log(`${entry.line} ${entry.verdict} (${entry.seconds}s) ${entry.observed}`);
  console.log(`log: ${logPath}`);
}
