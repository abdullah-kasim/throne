import type { CommandRegistryEntry } from "../shared-policy/command-registry.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type EntranceFailureMode =
  "unknown flag" | "missing argument" | "invalid value" | "policy refusal";

export interface EntranceSteeringEvidence {
  readonly commandName: string;
  readonly failureMode: EntranceFailureMode;
  readonly invocation: string;
  readonly evidence: string;
  readonly verdict: "PASS" | "N/A";
  readonly missingElement: string;
}

export interface ExecutableEntranceEvidence {
  readonly commandName: string;
  readonly failureMode: EntranceFailureMode;
  readonly testFile: string;
  readonly testName: string;
  readonly sourceFile: string;
  readonly sourceAnchor: string;
  readonly invocationTokens: readonly string[];
  readonly reasonAssertionTokens: readonly string[];
  readonly bypassAssertionTokens: readonly string[];
  readonly humanRouteAssertionTokens: readonly string[];
  readonly statusAssertionTokens: readonly string[];
  readonly noEffectAssertionTokens: readonly string[];
}

const FAILURE_MODES: readonly EntranceFailureMode[] = [
  "unknown flag",
  "missing argument",
  "invalid value",
  "policy refusal",
];

function requireEvidenceText(value: string, field: string): string {
  if (value.trim() === "") throw new Error(`missing ${field}`);
  return value;
}

function citedTestBlock(testSource: string, testName: string): string {
  const titleIndex = testSource.indexOf(testName);
  if (titleIndex < 0) throw new Error("cited executable test name does not exist");
  if (testName.includes("${")) {
    const fixtureStart = testSource.lastIndexOf("\nfor (", titleIndex);
    if (fixtureStart < 0) {
      throw new Error("cited executable fixture is not enclosed by a case loop");
    }
    const fixtureEnd = [
      testSource.indexOf("\nfor (", titleIndex + testName.length),
      testSource.indexOf("\ntest(", titleIndex + testName.length),
    ]
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0];
    return testSource.slice(fixtureStart + 1, fixtureEnd);
  }
  const start = Math.max(
    testSource.lastIndexOf("\ntest(", titleIndex),
    testSource.lastIndexOf("\nit(", titleIndex),
  );
  const searchFrom = titleIndex + testName.length;
  const nextTest = [testSource.indexOf("\ntest(", searchFrom), testSource.indexOf("\nit(", searchFrom)]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  return testSource.slice(start < 0 ? 0 : start + 1, nextTest);
}

export function assertEntranceSteeringCoverage(
  registry: readonly CommandRegistryEntry[],
  coverage: readonly EntranceSteeringEvidence[],
): void {
  const registeredNames = new Set(registry.map((entry) => entry.name));
  const coveredNames = new Set(coverage.map((entry) => entry.commandName));
  const missingCommands = [...registeredNames].filter(
    (name) => !coveredNames.has(name),
  );
  if (missingCommands.length > 0) {
    throw new Error(
      `uncovered registered commands: ${missingCommands.join(",")}`,
    );
  }
  for (const commandName of registeredNames) {
    for (const failureMode of FAILURE_MODES) {
      const matchingRecords = coverage.filter(
        (record) =>
          record.commandName === commandName &&
          record.failureMode === failureMode,
      );
      if (matchingRecords.length !== 1) {
        throw new Error(
          `${commandName}/${failureMode} requires exactly one independent evidence record`,
        );
      }
    }
  }
  for (const record of coverage) {
    if (!registeredNames.has(record.commandName)) {
      throw new Error(`unregistered command in audit: ${record.commandName}`);
    }
    requireEvidenceText(record.invocation, "invocation");
    requireEvidenceText(record.evidence, "evidence");
    requireEvidenceText(record.missingElement, "missing-element verdict");
    if (record.verdict === "PASS") {
      if (record.missingElement !== "None") {
        throw new Error(
          `${record.commandName}/${record.failureMode} passes with missing ${record.missingElement}`,
        );
      }
    } else if (record.evidence.trim().length < 20) {
      throw new Error(
        `${record.commandName}/${record.failureMode} N/A lacks a structural reason`,
      );
    }
  }
}

export async function verifyEntranceSteeringEvidence(
  repositoryRoot: string,
  coverage: readonly EntranceSteeringEvidence[],
  executableEvidence: readonly ExecutableEntranceEvidence[],
  readText: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<void> {
  for (const record of coverage) {
    const matches = executableEvidence.filter(
      (evidence) =>
        evidence.commandName === record.commandName &&
        evidence.failureMode === record.failureMode,
    );
    if (record.verdict === "N/A") {
      if (matches.length !== 0) {
        throw new Error(`${record.commandName}/${record.failureMode} is N/A but has executable evidence`);
      }
      continue;
    }
    if (matches.length !== 1) {
      throw new Error(`${record.commandName}/${record.failureMode} requires exactly one executable evidence record`);
    }
    const evidence = matches[0]!;
    if (
      !record.evidence.includes(evidence.testFile) ||
      !record.evidence.includes(evidence.testName)
    ) {
      throw new Error(
        `${record.commandName}/${record.failureMode} audit row does not cite its executable test`,
      );
    }
    const testSource = await readText(join(repositoryRoot, evidence.testFile));
    const commandSource = await readText(join(repositoryRoot, evidence.sourceFile));
    let testBlock: string;
    try {
      testBlock = citedTestBlock(testSource, evidence.testName);
    } catch (error) {
      throw new Error(
        `${record.commandName}/${record.failureMode}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const groups = [
      ["invocation", evidence.invocationTokens],
      ["reason", evidence.reasonAssertionTokens],
      ["typed bypass", evidence.bypassAssertionTokens],
      ["human route", evidence.humanRouteAssertionTokens],
      ["status", evidence.statusAssertionTokens],
      ["no-effect boundary", evidence.noEffectAssertionTokens],
    ] as const;
    for (const [label, tokens] of groups) {
      if (tokens.length === 0 || tokens.some((token) => !testBlock.includes(token))) {
        throw new Error(`${record.commandName}/${record.failureMode} executable test is missing ${label}`);
      }
    }
    if (!commandSource.includes(evidence.sourceAnchor)) {
      throw new Error(`${record.commandName}/${record.failureMode} command-local source anchor is missing`);
    }
  }
  const passCount = coverage.filter((record) => record.verdict === "PASS").length;
  if (executableEvidence.length !== passCount) {
    throw new Error(`executable evidence count ${executableEvidence.length} does not match PASS count ${passCount}`);
  }
}

export function parseEntranceSteeringAudit(
  markdown: string,
): EntranceSteeringEvidence[] {
  const records: EntranceSteeringEvidence[] = [];
  for (const line of markdown.split("\n")) {
    const match = line.match(
      /^\|\s*`([^`]+)`\s*\|\s*(unknown flag|missing argument|invalid value|policy refusal)\s*\|\s*(PASS|N\/A|UNREACHED)\s*\|\s*(.+?)\s*\|$/,
    );
    if (match === null) continue;
    const [, commandName, failureMode, verdict, detail] = match;
    if (verdict === "UNREACHED") {
      throw new Error(`${commandName}/${failureMode} remains UNREACHED`);
    }
    records.push({
      commandName,
      failureMode: failureMode as EntranceFailureMode,
      invocation: detail,
      evidence: detail.trim(),
      verdict: verdict as "PASS" | "N/A",
      missingElement: "None",
    });
  }
  return records;
}
