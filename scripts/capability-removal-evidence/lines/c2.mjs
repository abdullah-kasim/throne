import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { COMMITTED_DEFAULT_CONFIG, THRONE_ROOT, sameAnswers } from "../support.mjs";
import { createAgentArguments } from "./c1.mjs";
import { pollUntil } from "../../pi-evidence/support.mjs";
import { closeRealCourt, lastMessageIsAToolResult, launchRealPiAgent, openRealCourt } from "./real-court.mjs";

const NOTICE_WORDS = "capability requirements were removed";
const REMOVAL_DATE = "2026-11-15";
const OLD_GATE_FILE = path.join(THRONE_ROOT, "test", "fixtures", "capability-removal-evidence", "data-home", "data", "alpha-oldgrades-01", "todo-2026-11-14-0900-old-grades", "01z_critique_core.md");
const REQUIRES_LINE = /^requires: (.+)$/m;
const COMMANDS_DOC = path.join(THRONE_ROOT, "agent_docs", "commands.md");
const GRADING_TASK_MARKER = "GRADE-ONE-LINE";
const GRADED_LINE = "C9.9: one plus one is two";
const CRITIC_VERDICT = "C9.9 PASS: one plus one is two";
const CRITIC_NAME = "shadow-capevidence-01z-critique";
const CREATE_AGENT_FILES = ["src/create-agent/request.ts", "src/create-agent/request-arguments.ts", "scripts/capability-removal-evidence/create-agent-court.ts"];

function noticeCount(text) {
  return text.split(NOTICE_WORDS).length - 1;
}

async function launchWithAndWithout(workspace, requiresValue, lineId) {
  await workspace.useConfig(COMMITTED_DEFAULT_CONFIG);
  const name = "shadow-requires-01";
  const [plain, withRequires] = await Promise.all([
    workspace.createAgent(createAgentArguments("Shadow", "opus", name)),
    workspace.createAgent(createAgentArguments("Shadow", "opus", name, ["--requires", requiresValue])),
  ]);
  await workspace.saveText(`${lineId}-launches.json`, `${JSON.stringify({ plain, with_requires: withRequires }, null, 2)}\n`);
  if (withRequires.launch_arguments.length === 0) return { verdict: "FAIL", observed: `--requires ${requiresValue} did not launch: ${withRequires.stderr}` };
  if (noticeCount(withRequires.stdout) !== 1) return { verdict: "FAIL", observed: `the notice appeared ${noticeCount(withRequires.stdout)} times: ${withRequires.stdout}` };
  if (noticeCount(plain.stdout) !== 0) return { verdict: "FAIL", observed: "the notice appeared without --requires" };
  const same = sameAnswers(plain.launch_arguments, withRequires.launch_arguments) && sameAnswers(plain.spawn, withRequires.spawn) && plain.code === withRequires.code;
  if (!same) return { verdict: "FAIL", observed: "the launch with --requires differs from the one without it" };
  const notice = withRequires.stdout.split("\n").find((text) => text.includes(NOTICE_WORDS));
  return { verdict: "PASS", observed: `--requires ${requiresValue} launched exactly as without it and printed once: ${notice}` };
}

async function helpAndDocsSayIgnored(workspace) {
  const help = await workspace.throneCli(["create-agent", "--help"]);
  const helpLine = help.stdout.split("[").find((part) => part.startsWith("--requires")) ?? "";
  const docs = await readFile(COMMANDS_DOC, "utf8");
  const docsLines = docs.split("\n").filter((text) => text.includes("--requires"));
  const helpSays = helpLine.includes("accepted and ignored") && helpLine.includes(REMOVAL_DATE);
  const docsSay = docsLines.length > 0 && docsLines.every((text) => text.includes("ignored")) && docsLines.some((text) => text.includes(REMOVAL_DATE));
  await workspace.saveText("C2.3-help-and-docs.json", `${JSON.stringify({ help_exit: help.code, help_stderr: help.stderr, help_line: helpLine, docs_lines: docsLines }, null, 2)}\n`);
  if (!helpSays) return { verdict: "FAIL", observed: `create-agent --help says: ${helpLine}` };
  if (!docsSay) return { verdict: "NOT VERIFIED", observed: `create-agent --help says it is accepted and ignored with the date; agent_docs/commands.md still says otherwise (the words slice owns it): ${docsLines.join(" | ")}` };
  return { verdict: "PASS", observed: `help and agent_docs/commands.md both say --requires is accepted and ignored, dated ${REMOVAL_DATE}` };
}

export function criticReply(gateFile) {
  return (body) => {
    const asked = JSON.stringify(body.messages ?? []).includes(GRADING_TASK_MARKER);
    if (!asked || lastMessageIsAToolResult(body)) return { text: "graded" };
    return { toolCalls: [{ id: "critic-verdict", name: "bash", arguments: JSON.stringify({ command: `printf '%s\\n' '- ${CRITIC_VERDICT}' >> '${gateFile}'` }) }] };
  };
}

async function oldGateStillGetsItsCritic(workspace) {
  const gate = await readFile(OLD_GATE_FILE, "utf8");
  const requiresValue = gate.match(REQUIRES_LINE)?.[1];
  if (requiresValue === undefined) return { verdict: "FAIL", observed: "the fixture gate file has no requires: line" };
  const court = await openRealCourt(workspace);
  try {
    const gateFile = `${court.repository}/${path.basename(OLD_GATE_FILE)}`;
    await writeFile(gateFile, gate);
    const standIn = await court.standIn({ plannedReply: criticReply(gateFile) });
    const { created, herdr, paneId, ready } = await launchRealPiAgent(court, CRITIC_NAME, standIn, ["--requires", requiresValue]);
    await workspace.saveText("C2.4-create-agent.txt", `exit ${created.code}\n${created.stdout}\n${created.stderr}`);
    if (!ready.found) return { verdict: "FAIL", observed: `the critic never started: create-agent exit ${created.code}`, error: `${ready.cause ?? ""} ${created.stderr}`.trim() };
    await herdr.typeAndSubmit(paneId, `${GRADING_TASK_MARKER} ${GRADED_LINE}`);
    const graded = (await pollUntil(() => readFile(gateFile, "utf8"), (text) => text.includes(CRITIC_VERDICT), 60_000, 500)).found;
    await workspace.saveText("C2.4-pane.txt", await herdr.readPane(paneId));
    await workspace.saveText("C2.4-gate-file-after.md", await readFile(gateFile, "utf8"));
    const noticed = noticeCount(created.stdout) === 1;
    if (!noticed) return { verdict: "FAIL", observed: `create-agent printed the --requires notice ${noticeCount(created.stdout)} times` };
    return graded
      ? { verdict: "PASS", observed: `a real pi critic created with --requires ${requiresValue} from the gate file graded "${GRADED_LINE}" and its verdict "${CRITIC_VERDICT}" arrived in the gate file` }
      : { verdict: "FAIL", observed: "the critic launched but its verdict never arrived in the gate file within 60s" };
  } finally {
    await closeRealCourt(court);
  }
}

export const lines = [
  { id: "C2.1", run: (workspace) => launchWithAndWithout(workspace, "non-coding>=4", "C2.1"), restsOn: CREATE_AGENT_FILES },
  { id: "C2.2", run: (workspace) => launchWithAndWithout(workspace, "banana", "C2.2"), restsOn: CREATE_AGENT_FILES },
  { id: "C2.3", run: helpAndDocsSayIgnored, restsOn: [...CREATE_AGENT_FILES, "agent_docs/commands.md"] },
  { id: "C2.4", run: oldGateStillGetsItsCritic, restsOn: [...CREATE_AGENT_FILES, "test/fixtures/capability-removal-evidence/data-home/data/alpha-oldgrades-01/todo-2026-11-14-0900-old-grades/01z_critique_core.md", "scripts/capability-removal-evidence/lines/real-court.mjs"] },
];
