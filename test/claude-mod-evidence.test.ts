import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { runEvidence } from "../scripts/claude-mod-evidence/run.mjs";
import { SPEC_LINES } from "../scripts/claude-mod-evidence/spec-lines.mjs";
import { writeGuardedHerdrClient } from "../scripts/claude-mod-evidence/guarded-herdr-client.mjs";
import { scratchEnvironment } from "../scripts/claude-mod-evidence/isolated-harness.mjs";

const run = promisify(execFile);
const scratchFolders: string[] = [];
after(() => Promise.all(scratchFolders.map((folder) => rm(folder, { recursive: true, force: true }))));

async function scratchFolder(): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), "claude-mod-evidence-test-"));
  scratchFolders.push(folder);
  return folder;
}

interface FakeHarness {
  readonly evidence: string[];
  closed: boolean;
  close(): Promise<void>;
}

function fakeHarnessOpener(opened: FakeHarness[]) {
  return async (line: string, evidenceFolder: string): Promise<FakeHarness> => {
    const harness: FakeHarness = {
      evidence: [path.join(evidenceFolder, `${line}-pane.txt`)],
      closed: false,
      async close() {
        harness.closed = true;
      },
    };
    opened.push(harness);
    return harness;
  };
}

const concurrencyCheck = `
export async function check() {
  globalThis.claudeModEvidenceRunning = (globalThis.claudeModEvidenceRunning ?? 0) + 1;
  globalThis.claudeModEvidenceMostRunning = Math.max(globalThis.claudeModEvidenceMostRunning ?? 0, globalThis.claudeModEvidenceRunning);
  await new Promise((resolve) => setTimeout(resolve, 50));
  globalThis.claudeModEvidenceRunning -= 1;
  return { verdict: "PASS", observed: "checked" };
}
`;

test("a spec line whose behaviour is not built yet is reported NOT VERIFIED with a reason, never PASS", async () => {
  const outFolder = await scratchFolder();
  const linesFolder = await scratchFolder();
  const opened: FakeHarness[] = [];
  const { log, logPath } = await runEvidence({ line: "M1.2", outFolder, linesFolder, open: fakeHarnessOpener(opened) });
  assert.equal(log.lines.length, 1);
  assert.equal(log.lines[0].line, "M1.2");
  assert.equal(log.lines[0].verdict, "NOT VERIFIED");
  assert.match(log.lines[0].observed, /no check is registered for M1\.2/);
  assert.equal(opened.length, 0, "no harness starts for a line with no check");
  assert.deepEqual(JSON.parse(await readFile(logPath, "utf8")), log);
});

test("a group runs every line in it, at most four harnesses at once, and logs each line's verdict, evidence and seconds", async () => {
  const outFolder = await scratchFolder();
  const linesFolder = await scratchFolder();
  const registered = ["M3.1", "M3.2", "M3.3", "M3.4", "M3.5", "M3.6"];
  await Promise.all(registered.map((line) => writeFile(path.join(linesFolder, `${line}.mjs`), concurrencyCheck)));
  const opened: FakeHarness[] = [];
  const { log } = await runEvidence({ group: "M3", outFolder, linesFolder, open: fakeHarnessOpener(opened) });
  assert.deepEqual(log.lines.map((entry: { line: string }) => entry.line), ["M3.1", "M3.2", "M3.3", "M3.4", "M3.5", "M3.6", "M3.7", "M3.8"]);
  assert.deepEqual(log.lines.map((entry: { verdict: string }) => entry.verdict), ["PASS", "PASS", "PASS", "PASS", "PASS", "PASS", "NOT VERIFIED", "NOT VERIFIED"]);
  assert.equal((globalThis as { claudeModEvidenceMostRunning?: number }).claudeModEvidenceMostRunning, 4);
  assert.equal(opened.length, 6);
  assert.ok(opened.every((harness) => harness.closed));
  for (const entry of log.lines) {
    assert.deepEqual(Object.keys(entry).sort(), ["error", "evidence", "expected", "line", "observed", "seconds", "settings_after", "settings_before", "verdict"]);
    assert.equal(typeof entry.seconds, "number");
  }
  assert.deepEqual(log.lines[0].evidence, [path.join(outFolder, "M3.1", "M3.1-pane.txt")]);
  assert.equal(typeof log.run_seconds, "number");
});

test("the group all runs every spec line once", async () => {
  const outFolder = await scratchFolder();
  const linesFolder = await scratchFolder();
  const { log } = await runEvidence({ group: "all", outFolder, linesFolder, open: fakeHarnessOpener([]) });
  assert.deepEqual(log.lines.map((entry: { line: string }) => entry.line), SPEC_LINES.map((entry) => entry.line));
});

test("a line check that stops with an error is FAIL with that error, and its harness is still closed", async () => {
  const outFolder = await scratchFolder();
  const linesFolder = await scratchFolder();
  await writeFile(path.join(linesFolder, "M3.8.mjs"), 'export async function check() { throw new Error("composer never appeared"); }\n');
  const opened: FakeHarness[] = [];
  const { log } = await runEvidence({ line: "M3.8", outFolder, linesFolder, open: fakeHarnessOpener(opened) });
  assert.equal(log.lines[0].verdict, "FAIL");
  assert.match(log.lines[0].error, /composer never appeared/);
  assert.equal(opened[0]?.closed, true);
});

test("an unknown spec line is refused rather than logged", async () => {
  const outFolder = await scratchFolder();
  await assert.rejects(runEvidence({ line: "M9.9", outFolder }), /no spec line matches --line M9\.9/);
});

test("the M3.6 herdr client refuses send-text, send-keys and reads for the recipient pane and passes every other call through", async () => {
  const folder = await scratchFolder();
  const realClient = path.join(folder, "real-herdr");
  await writeFile(realClient, '#!/usr/bin/env bash\necho "real: $*"\n');
  await chmod(realClient, 0o755);
  const { clientPath, refusalLog } = await writeGuardedHerdrClient({ folder, realClient, recipients: ["w1:p1", "recipient"] });
  for (const call of [
    ["--session", "s", "pane", "send-text", "w1:p1", "hello"],
    ["pane", "send-keys", "w1:p1", "enter"],
    ["--session", "s", "pane", "read", "w1:p1"],
    ["--session", "s", "agent", "read", "recipient"],
  ]) {
    await assert.rejects(run(clientPath, call), (error: { code?: number }) => error.code === 97);
  }
  const passed = await run(clientPath, ["--session", "s", "pane", "send-text", "w1:p2", "hello"]);
  assert.equal(passed.stdout.trim(), "real: --session s pane send-text w1:p2 hello");
  const listed = await run(clientPath, ["--session", "s", "agent", "list"]);
  assert.equal(listed.stdout.trim(), "real: --session s agent list");
  assert.equal((await readFile(refusalLog, "utf8")).trim().split("\n").length, 4);
});

test("an evidence run never changes the person's own Claude settings: a line that does is marked ERROR, never PASS", async () => {
  const outFolder = await scratchFolder();
  const linesFolder = await scratchFolder();
  const settingsFolder = await scratchFolder();
  const settings = path.join(settingsFolder, "settings.json");
  await writeFile(settings, '{"hooks":{}}\n');
  await writeFile(
    path.join(linesFolder, "M1.2.mjs"),
    `import { writeFile } from "node:fs/promises";\nexport async function check() {\n  await writeFile(${JSON.stringify(settings)}, '{"hooks":{"changed":true}}\\n');\n  return { verdict: "PASS", observed: "checked" };\n}\n`,
  );
  const { log } = await runEvidence({ line: "M1.2", outFolder, linesFolder, open: fakeHarnessOpener([]), settings: [settings] });
  assert.equal(log.lines[0].verdict, "ERROR");
  assert.match(log.lines[0].observed, /changed the person's own Claude settings/u);
  assert.notEqual(log.lines[0].settings_before[settings].sha256, log.lines[0].settings_after[settings].sha256);
});

test("an evidence run that leaves the person's own Claude settings alone keeps its verdict and records both checksums", async () => {
  const outFolder = await scratchFolder();
  const linesFolder = await scratchFolder();
  const settingsFolder = await scratchFolder();
  const settings = path.join(settingsFolder, "settings.json");
  await writeFile(settings, '{"hooks":{}}\n');
  await writeFile(path.join(linesFolder, "M1.2.mjs"), 'export async function check() { return { verdict: "PASS", observed: "checked" }; }\n');
  const { log } = await runEvidence({ line: "M1.2", outFolder, linesFolder, open: fakeHarnessOpener([]), settings: [settings] });
  assert.equal(log.lines[0].verdict, "PASS");
  assert.deepEqual(log.lines[0].settings_before[settings], log.lines[0].settings_after[settings]);
});

test("an evidence run that leaves its own folders in the person's Claude state is marked ERROR, while the person's own counters moving is not", async () => {
  const outFolder = await scratchFolder();
  const linesFolder = await scratchFolder();
  const settingsFolder = await scratchFolder();
  const settings = path.join(settingsFolder, "settings.json");
  const state = path.join(settingsFolder, "claude.json");
  await writeFile(settings, "{}\n");
  await writeFile(state, '{"promptQueueUseCount":1,"projects":{}}\n');
  const writeLine = (text: string) =>
    `import { writeFile } from "node:fs/promises";\nexport async function check() {\n  await writeFile(${JSON.stringify(state)}, ${JSON.stringify(text)});\n  return { verdict: "PASS", observed: "checked" };\n}\n`;
  await writeFile(path.join(linesFolder, "M1.2.mjs"), writeLine('{"promptQueueUseCount":2,"projects":{}}\n'));
  const counted = await runEvidence({ line: "M1.2", outFolder, linesFolder, open: fakeHarnessOpener([]), settings: [settings, state] });
  assert.equal(counted.log.lines[0].verdict, "PASS");
  const leakingLinesFolder = await scratchFolder();
  await writeFile(path.join(leakingLinesFolder, "M1.2.mjs"), writeLine('{"promptQueueUseCount":2,"projects":{"/tmp/cme-abc/repo":{}}}\n'));
  const leaked = await runEvidence({ line: "M1.2", outFolder, linesFolder: leakingLinesFolder, open: fakeHarnessOpener([]), settings: [settings, state] });
  assert.equal(leaked.log.lines[0].verdict, "ERROR");
});

test("an evidence run leaves the throne worktree as it found it: a folder the run's backend generates is removed, one already there is kept", async () => {
  const { keepFolderAsFound } = await import("../scripts/claude-mod-evidence/isolated-court.mjs");
  const root = await scratchFolder();
  const generated = path.join(root, "generated");
  const kept = path.join(root, "kept");
  await mkdir(kept);
  const restoreGenerated = keepFolderAsFound(generated);
  const restoreKept = keepFolderAsFound(kept);
  await mkdir(generated);
  await Promise.all([restoreGenerated(), restoreKept()]);
  assert.deepEqual(await readdir(root), ["kept"]);
});

test("the Claude config copy skips lock files and survives files vanishing while it copies", async () => {
  const { copyClaudeConfig } = await import("../scripts/claude-mod-evidence/isolated-harness.mjs");
  const source = await scratchFolder();
  const target = path.join(await scratchFolder(), "copy");
  await writeFile(path.join(source, "settings.json"), "{}\n");
  await writeFile(path.join(source, "history.jsonl.lock"), "");
  await writeFile(path.join(source, ".update.lock"), "");
  await mkdir(path.join(source, "plugins"));
  const doomed = Array.from({ length: 200 }, (_, index) => path.join(source, "plugins", `doomed-${index}`));
  await Promise.all(doomed.map((file) => writeFile(file, "x")));
  const copying = copyClaudeConfig(source, target);
  await Promise.all(doomed.map((file) => rm(file, { force: true })));
  await copying;
  assert.deepEqual((await readdir(target)).sort(), ["plugins", "settings.json"]);
});

test("once a line changes the person's own Claude settings the run starts no further line and marks the rest ERROR", async () => {
  const outFolder = await scratchFolder();
  const linesFolder = await scratchFolder();
  const settingsFolder = await scratchFolder();
  const settings = path.join(settingsFolder, "settings.json");
  await writeFile(settings, "{}\n");
  await writeFile(
    path.join(linesFolder, "M3.1.mjs"),
    `import { writeFile } from "node:fs/promises";\nexport async function check() {\n  await writeFile(${JSON.stringify(settings)}, '{"changed":true}\\n');\n  return { verdict: "PASS", observed: "checked" };\n}\n`,
  );
  const slowPass = 'export async function check() { await new Promise((resolve) => setTimeout(resolve, 200)); return { verdict: "PASS", observed: "checked" }; }\n';
  for (const line of ["M3.2", "M3.3", "M3.4", "M3.5", "M3.6", "M3.7", "M3.8"]) await writeFile(path.join(linesFolder, `${line}.mjs`), slowPass);
  const opened: FakeHarness[] = [];
  const { log } = await runEvidence({ group: "M3", outFolder, linesFolder, open: fakeHarnessOpener(opened), settings: [settings] });
  assert.equal(log.lines[0].verdict, "ERROR");
  for (const entry of log.lines.slice(4)) {
    assert.equal(entry.verdict, "ERROR");
    assert.match(entry.observed, /^not run/u);
  }
  assert.equal(opened.length, 4);
});

test("the groups M, G and T select every behaviour line, every flow and the timing case", async () => {
  const { selectSpecLines } = await import("../scripts/claude-mod-evidence/spec-lines.mjs");
  const lines = (group: string) => selectSpecLines({ group }).map((entry: { line: string }) => entry.line);
  assert.deepEqual(lines("G"), ["G1", "G2", "G4", "G5"]);
  assert.deepEqual(lines("T"), ["T1"]);
  assert.equal(lines("M").length, 17);
  assert.deepEqual(lines("all"), SPEC_LINES.map((entry) => entry.line));
});

test("a line's figures are logged under its own entry", async () => {
  const outFolder = await scratchFolder();
  const linesFolder = await scratchFolder();
  await writeFile(path.join(linesFolder, "T1.mjs"), 'export async function check() { return { verdict: "PASS", observed: "timed", figures: { mod: { median_seconds: 2 } } }; }\n');
  const { log } = await runEvidence({ line: "T1", outFolder, linesFolder, open: fakeHarnessOpener([]) });
  assert.deepEqual(log.lines[0].figures, { mod: { median_seconds: 2 } });
});

test("an evidence run's scratch agents carry neither the person's git signing identity nor the live throne root", () => {
  const environment = scratchEnvironment({
    PATH: "/usr/bin",
    THRONE_LIVE_ROOT: "/live/throne",
    GIT_AUTHOR_EMAIL: "person@example.org",
    GIT_COMMITTER_NAME: "Person",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "commit.gpgsign",
    GIT_CONFIG_VALUE_0: "true",
    GIT_SIGNING_KEY: "ABCDEF",
    THRONE_GIT_SIGNING_KEY: "ABCDEF",
    GIT_EDITOR: "true",
  });
  assert.deepEqual(Object.keys(environment).sort(), ["GIT_EDITOR", "PATH", "THRONE_LIVE_ROOT"]);
  assert.equal(environment.THRONE_LIVE_ROOT, path.resolve(import.meta.dirname, ".."));
});
