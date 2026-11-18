import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { createLineWorkspace, skippedLineReason } from "./support.mjs";

const GROUPS = ["launch", "models", "account", "delivery", "state", "lifecycle", "runtime", "flows", "hooks"];
const MOST_LINES_AT_ONCE = 4;

async function loadGroups() {
  const loaded = [];
  for (const group of GROUPS) {
    const module = await import(`./lines/${group}.mjs`);
    for (const line of module.lines) loaded.push({ ...line, group });
  }
  return loaded;
}

function selectLines(allLines, options) {
  if (options.all) return allLines;
  const wanted = new Set(options.line ?? []);
  const groups = new Set(options.group ?? []);
  for (const group of groups) {
    if (!GROUPS.includes(group)) throw new Error(`unknown group "${group}"; groups: ${GROUPS.join(", ")}`);
  }
  const chosen = allLines.filter((line) => wanted.has(line.id) || groups.has(line.group));
  const unknown = [...wanted].filter((id) => !allLines.some((line) => line.id === id));
  if (unknown.length > 0) throw new Error(`unknown line ${unknown.join(", ")}`);
  return chosen;
}

async function runOneLine(line, outDirectory, flags) {
  const started = Date.now();
  const lineDirectory = path.join(outDirectory, line.id);
  await mkdir(lineDirectory, { recursive: true });
  const skipped = skippedLineReason(line, flags);
  if (skipped !== null) {
    return { line: line.id, verdict: "NOT VERIFIED", observed: skipped, pane_text_paths: [], files: [], error: null, seconds: 0 };
  }
  const workspace = await createLineWorkspace(lineDirectory);
  try {
    const outcome = await line.run(workspace);
    return { line: line.id, verdict: outcome.verdict, observed: outcome.observed, ...workspace.evidence(), error: outcome.error ?? null, tokens: outcome.tokens ?? null, seconds: (Date.now() - started) / 1000 };
  } catch (error) {
    return { line: line.id, verdict: "FAIL", observed: "the line threw", ...workspace.evidence(), error: String(error?.stack ?? error), seconds: (Date.now() - started) / 1000 };
  } finally {
    await workspace.close();
  }
}

async function runTogether(lines, outDirectory, flags) {
  const results = new Array(lines.length);
  let next = 0;
  const worker = async () => {
    while (next < lines.length) {
      const index = next++;
      results[index] = await runOneLine(lines[index], outDirectory, flags);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MOST_LINES_AT_ONCE, lines.length) }, worker));
  return results;
}

async function main() {
  const { values } = parseArgs({
    options: {
      line: { type: "string", multiple: true },
      group: { type: "string", multiple: true },
      all: { type: "boolean" },
      out: { type: "string" },
      "real-provider": { type: "boolean" },
      "real-harnesses": { type: "boolean" },
    },
  });
  if (values.out === undefined || (!values.all && values.line === undefined && values.group === undefined)) {
    process.stderr.write("usage: bun scripts/pi-evidence/run.mjs (--line <P id> | --group <name> | --all)... --out <dir> [--real-provider] [--real-harnesses]\n");
    process.exit(2);
  }
  const outDirectory = path.resolve(values.out);
  await mkdir(outDirectory, { recursive: true });
  const runStarted = new Date();
  const selected = selectLines(await loadGroups(), values);
  const flags = { realProvider: values["real-provider"] === true, realHarnesses: values["real-harnesses"] === true };
  const runsSerially = (line) => line.realProvider === true || line.realHarnesses === true;
  const ordinary = await runTogether(selected.filter((line) => !runsSerially(line)), outDirectory, flags);
  const serial = [];
  for (const line of selected.filter(runsSerially)) {
    serial.push(await runOneLine(line, outDirectory, flags));
  }
  const report = {
    run_started: runStarted.toISOString(),
    run_seconds: (Date.now() - runStarted.getTime()) / 1000,
    lines: [...ordinary, ...serial],
  };
  report.run_tokens = report.lines.reduce((total, line) => total + (line.tokens?.total ?? 0), 0);
  const logPath = path.join(outDirectory, "pi-evidence.json");
  await writeFile(logPath, `${JSON.stringify(report, null, 2)}\n`);
  for (const line of report.lines) process.stdout.write(`${line.line}\t${line.verdict}\t${line.tokens == null ? "" : `tokens ${line.tokens.total}\t`}${line.observed}\n`);
  process.stdout.write(`log: ${logPath}\n`);
}

await main();
