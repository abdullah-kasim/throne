import { readFile } from "node:fs/promises";
import path from "node:path";
import { runCommand, THRONE_ROOT } from "../support.mjs";

const FEATURE_WORDS = "requires: ?non-coding|capability[- ]floor|capability grade|capability score";
const SEARCHED_PATHS = [".claude/skills", "agent_docs", "docs", "AGENTS.md", "CLAUDE.md", "README.md"];
const DATED_NOTE = /\b20\d\d-\d\d-\d\d\b/;
const GAUNTLET_SKILL = ".claude/skills/gauntlet/SKILL.md";
const REQUIRES_LINE = /^\s*-?\s*`?requires:/m;
const FLOORS_AS_HARD_GATE = /capability floors[^.]*hard gate/i;

async function featureWordsAreGone(workspace) {
  const searched = await runCommand("git", ["-C", THRONE_ROOT, "grep", "-n", "-i", "-E", FEATURE_WORDS, "--", ...SEARCHED_PATHS]);
  const hits = searched.stdout.split("\n").filter((line) => line.length > 0);
  const undated = hits.filter((line) => !DATED_NOTE.test(line));
  const gauntlet = await readFile(path.join(THRONE_ROOT, GAUNTLET_SKILL), "utf8");
  const claude = await readFile(path.join(THRONE_ROOT, "CLAUDE.md"), "utf8");
  const failures = [
    ...undated.map((line) => `undated hit: ${line}`),
    ...(REQUIRES_LINE.test(gauntlet) ? [`${GAUNTLET_SKILL} still carries a requires: line`] : []),
    ...(FLOORS_AS_HARD_GATE.test(claude) ? ["CLAUDE.md still calls capability floors a hard gate"] : []),
  ];
  await workspace.saveText("C5.1-grep.txt", `${searched.stdout}`);
  return failures.length === 0
    ? { verdict: "PASS", observed: `${hits.length} hits, all dated history notes; gauntlet gates carry no requires: line; CLAUDE.md names no capability floor gate` }
    : { verdict: "FAIL", observed: failures.join("; ") };
}

export const lines = [{ id: "C5.1", run: featureWordsAreGone, restsOn: SEARCHED_PATHS }];
