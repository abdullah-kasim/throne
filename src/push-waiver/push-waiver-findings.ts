import { formatFileLine, parseFileLine } from "./file-line.ts";
import { PushWaiverRefusal } from "./push-waiver-refusal.ts";

export interface Finding {
  readonly number: number;
  readonly severity: string;
  readonly location: string;
  readonly title: string;
}

type UnnumberedFinding = Omit<Finding, "number">;

const SEVERITY_WORD = /^[A-Za-z]+$/;
const TOKEN_WRAPPING = /^[`([]+|[`)\],;:]+$/g;
const TITLE_LEAD = /^[\s\-—–:]+/;

function looksLikeJson(text: string): boolean {
  return /^[[{]/.test(text.trimStart());
}

function stripTokenWrapping(token: string): string {
  return token.replace(TOKEN_WRAPPING, "");
}

function readFindingLine(line: string, lineNumber: number): UnnumberedFinding {
  const tokens = line.trim().split(/\s+/);
  const severity = stripTokenWrapping(tokens[0] ?? "");
  const locationIndex = tokens.findIndex((token, index) => index > 0 && parseFileLine(stripTokenWrapping(token)) !== undefined);
  const title = locationIndex < 0 ? "" : tokens.slice(locationIndex + 1).join(" ").replace(TITLE_LEAD, "");
  if (!SEVERITY_WORD.test(severity) || locationIndex < 0 || title === "") {
    throw new PushWaiverRefusal(
      `findings file line ${lineNumber} is not a finding: expected "<severity> <file:line> <title>", got "${line.trim()}".`,
    );
  }
  return { severity, location: stripTokenWrapping(tokens[locationIndex]!), title };
}

function readFindingLines(text: string): UnnumberedFinding[] {
  return text
    .split("\n")
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => line.trim() !== "")
    .map(({ line, lineNumber }) => readFindingLine(line, lineNumber));
}

function textField(value: Record<string, unknown>, names: readonly string[]): string {
  const found = names.map((name) => value[name]).find((field) => typeof field === "string" && field.trim() !== "");
  return typeof found === "string" ? found.trim() : "";
}

function readJsonFinding(value: unknown, position: number): UnnumberedFinding {
  const fields = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const severity = textField(fields, ["severity"]);
  const file = textField(fields, ["file", "path"]);
  const line = typeof fields.line === "number" ? String(fields.line) : textField(fields, ["line"]);
  const title = textField(fields, ["title", "message"]);
  const location = parseFileLine(`${file}:${line}`);
  if (severity === "" || location === undefined || title === "") {
    throw new PushWaiverRefusal(
      `findings file entry ${position} is not a finding: it needs a severity, a file (or path), a line and a title (or message).`,
    );
  }
  return { severity, location: formatFileLine(location), title };
}

function readFindingsJson(text: string): UnnumberedFinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new PushWaiverRefusal(`findings file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(list)) {
    throw new PushWaiverRefusal("findings file JSON must be an array of findings or an object with a findings array.");
  }
  return list.map((value, index) => readJsonFinding(value, index + 1));
}

export function readFindings(text: string): Finding[] {
  const findings = looksLikeJson(text) ? readFindingsJson(text) : readFindingLines(text);
  if (findings.length === 0) {
    throw new PushWaiverRefusal("findings file holds no findings; a waiver covers a push the checks blocked.");
  }
  return findings.map((finding, index) => ({ number: index + 1, ...finding }));
}
