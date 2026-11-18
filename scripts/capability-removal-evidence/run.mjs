import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createLineWorkspace } from "./support.mjs";

const GROUPS = ["C1", "C2", "C3", "C4", "C5", "C6", "H"];
const EVERY_GROUP = "all";
const MOST_LINES_AT_ONCE = 4;

async function loadLines() {
  const loaded = [];
  for (const group of GROUPS) {
    const module = await import(`./lines/${group.toLowerCase()}.mjs`);
    for (const line of module.lines) loaded.push({ ...line, group });
  }
  return loaded;
}

function selectLines(allLines, wantedLines, wantedGroups) {
  const groups = new Set(wantedGroups.includes(EVERY_GROUP) ? GROUPS : wantedGroups);
  for (const group of groups) {
    if (!GROUPS.includes(group)) throw new Error(`unknown group "${group}"; groups: ${GROUPS.join(", ")}, ${EVERY_GROUP}`);
  }
  const unknown = wantedLines.filter((id) => !allLines.some((line) => line.id === id));
  if (unknown.length > 0) throw new Error(`unknown line ${unknown.join(", ")}`);
  return allLines.filter((line) => wantedLines.includes(line.id) || groups.has(line.group));
}

async function runOneLine(line, outDirectory, options) {
  const started = Date.now();
  const lineDirectory = path.join(outDirectory, line.id);
  await mkdir(lineDirectory, { recursive: true });
  const workspace = await createLineWorkspace(lineDirectory);
  const seconds = () => (Date.now() - started) / 1000;
  try {
    const outcome = await line.run(workspace, options);
    return { line: line.id, verdict: outcome.verdict, observed: outcome.observed, before: outcome.before ?? null, files: line.restsOn ?? [], ...workspace.evidence(), error: outcome.error ?? null, seconds: seconds() };
  } catch (error) {
    return { line: line.id, verdict: "FAIL", observed: "the line threw", before: null, files: line.restsOn ?? [], ...workspace.evidence(), error: String(error?.stack ?? error), seconds: seconds() };
  } finally {
    await workspace.close();
  }
}

async function runTogether(lines, outDirectory, options) {
  const results = new Array(lines.length);
  let next = 0;
  const worker = async () => {
    while (next < lines.length) {
      const index = next++;
      results[index] = await runOneLine(lines[index], outDirectory, options);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MOST_LINES_AT_ONCE, lines.length) }, worker));
  return results;
}

async function main() {
  const { values } = parseArgs({
    options: {
      line: { type: "string", multiple: true, default: [] },
      group: { type: "string", multiple: true, default: [] },
      out: { type: "string" },
      "record-before": { type: "boolean" },
    },
  });
  if (values.line.length === 0 && values.group.length === 0) {
    process.stderr.write(`usage: bun scripts/capability-removal-evidence/run.mjs (--line <C or H id> | --group <C1..C6|H|${EVERY_GROUP}>)... [--out <folder>] [--record-before]\n`);
    process.exit(2);
  }
  const runStarted = new Date();
  const outDirectory = path.resolve(values.out ?? path.join(os.homedir(), "tmp", "capability-removal-evidence-out", runStarted.toISOString().replaceAll(":", "-")));
  await mkdir(outDirectory, { recursive: true });
  const selected = selectLines(await loadLines(), values.line, values.group);
  const lines = await runTogether(selected, outDirectory, { recordBefore: values["record-before"] === true });
  const report = { run_started: runStarted.toISOString(), run_seconds: (Date.now() - runStarted.getTime()) / 1000, lines };
  const logPath = path.join(outDirectory, "capability-removal-evidence.json");
  await writeFile(logPath, `${JSON.stringify(report, null, 2)}\n`);
  for (const line of lines) process.stdout.write(`${line.line}\t${line.verdict}\t${line.observed}\n`);
  process.stdout.write(`log: ${logPath}\n`);
  process.exit(lines.some((line) => line.verdict === "FAIL") ? 1 : 0);
}

await main();
