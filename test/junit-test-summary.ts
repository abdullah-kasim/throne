const TEST_CASE = /<testcase\s([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
const XML_ENTITY = /&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-fA-F]+);/g;
const NAMED_ENTITIES: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };

type TestOutcome = "pass" | "fail" | "skip";

type TestCase = {
  name: string;
  file: string;
  line: string;
  durationMs: number;
  outcome: TestOutcome;
};

function decodeXmlText(text: string): string {
  return text.replace(XML_ENTITY, (_entity, code: string) => {
    if (code.startsWith("#x")) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(Number(code.slice(1)));
    return NAMED_ENTITIES[code];
  });
}

function readAttribute(attributes: string, name: string): string {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attributes);
  return match ? decodeXmlText(match[1]) : "";
}

function readOutcome(body: string | undefined): TestOutcome {
  if (body && /<(failure|error)[\s>/]/.test(body)) return "fail";
  if (body && /<skipped[\s>/]/.test(body)) return "skip";
  return "pass";
}

export function parseJunitTestCases(report: string): TestCase[] {
  return [...report.matchAll(TEST_CASE)].map(([, attributes, body]) => ({
    name: readAttribute(attributes, "name"),
    file: readAttribute(attributes, "file"),
    line: readAttribute(attributes, "line") || "1",
    durationMs: Math.round(Number(readAttribute(attributes, "time")) * 1000000) / 1000,
    outcome: readOutcome(body),
  }));
}

function formatTestCaseLine(testCase: TestCase): string {
  if (testCase.outcome === "skip") return `﹣ ${testCase.name} (${testCase.durationMs}ms) # SKIP`;
  return `${testCase.outcome === "pass" ? "✔" : "✖"} ${testCase.name} (${testCase.durationMs}ms)`;
}

export function formatJunitSummary(report: string): string {
  const testCases = parseJunitTestCases(report);
  const failed = testCases.filter((testCase) => testCase.outcome === "fail");
  const count = (outcome: TestOutcome) => testCases.filter((testCase) => testCase.outcome === outcome).length;
  const lines = [
    ...testCases.map(formatTestCaseLine),
    `ℹ tests ${testCases.length}`,
    `ℹ pass ${count("pass")}`,
    `ℹ fail ${failed.length}`,
    "ℹ cancelled 0",
    `ℹ skipped ${count("skip")}`,
  ];
  if (failed.length > 0) {
    lines.push("", "✖ failing tests:", "");
    for (const testCase of failed) {
      lines.push(`test at ${testCase.file}:${testCase.line}:1`, formatTestCaseLine(testCase), "");
    }
  }
  return `${lines.join("\n")}\n`;
}
