import { Injectable } from "@nestjs/common";
import path from "node:path";
import {
  launcherFamily,
  resolveModel,
  sameLauncherFamily,
  type Harness,
} from "../harness-routing/harness.ts";
import { modelEffortRange } from "../harness-routing/policy/capabilities.ts";
import type {
  LaunchRecipe,
  SessionCandidate,
  SessionEvidence,
  StatusFields,
  SwitchRequest,
  SwitchTargetResult,
} from "./session.contracts.ts";

const FULL_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const FULL_ID_TEXT = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i;
const PREFIX = /^[0-9a-f]{8}[0-9a-f-]*$/;
const PREFIX_TEXT = /[0-9a-f]{8}[0-9a-f-]*(?:…|\.\.\.)?/i;
const LABELS = {
  session: ["session", "session id", "conversation", "conversation id"],
  model: ["model"],
  cwd: ["cwd", "workdir", "working directory", "directory", "path"],
} as const;

function sameDirectory(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

@Injectable()
export class SessionService {
  isFullSessionId(value: unknown): value is string {
    return (
      typeof value === "string" && FULL_ID.test(value.trim().toLowerCase())
    );
  }

  normalizeSessionPrefix(displayed: string): string | null {
    const value = displayed
      .trim()
      .toLowerCase()
      .replace(/(?:…|\.\.\.)$/, "")
      .replace(/-+$/, "");
    return PREFIX.test(value) ? value : null;
  }

  parseStatusFields(status: string): StatusFields {
    const fields: StatusFields = {};
    for (const line of status.split("\n")) {
      const separator = line.indexOf(":");
      if (separator < 0) continue;
      const label = line
        .slice(0, separator)
        .replace(/[^\p{L}\p{N} ]+/gu, " ")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
      const value = line.slice(separator + 1).trim();
      if (!label || !value) continue;
      for (const [field, labels] of Object.entries(LABELS)) {
        if (
          fields[field as keyof StatusFields] === undefined &&
          (labels as readonly string[]).includes(label)
        )
          fields[field as keyof StatusFields] = value;
      }
    }
    return fields;
  }

  parseClaudeStatusSession(status: string): string | null {
    const labelled = this.parseStatusFields(status).session;
    const found = (
      labelled !== undefined && FULL_ID_TEXT.test(labelled) ? labelled : status
    ).match(FULL_ID_TEXT);
    return found?.[0].toLowerCase() ?? null;
  }

  parseCodexStatusSession(status: string): string | null {
    const found = (this.parseStatusFields(status).session ?? status).match(
      PREFIX_TEXT,
    );
    return found === null ? null : this.normalizeSessionPrefix(found[0]);
  }

  resolveSessionPrefix(
    displayed: string,
    candidates: readonly SessionCandidate[],
    expectedCwd: string,
  ): SessionEvidence {
    const prefix = this.normalizeSessionPrefix(displayed);
    if (prefix === null)
      return {
        ok: false,
        reason: "unreadable",
        message: `"${displayed.trim()}" is not a native session id or prefix`,
      };
    const matches = candidates.filter(
      (candidate) =>
        this.isFullSessionId(candidate.id) &&
        candidate.id.trim().toLowerCase().startsWith(prefix),
    );
    const sessions = new Map<string, { id: string; cwds: string[] }>();
    for (const candidate of matches) {
      const id = candidate.id.trim().toLowerCase();
      const session = sessions.get(id) ?? { id, cwds: [] };
      if (candidate.cwd !== undefined) session.cwds.push(candidate.cwd);
      sessions.set(id, session);
    }
    const distinct = [...sessions.values()];
    const here = distinct.filter((session) =>
      session.cwds.some((cwd) => sameDirectory(cwd, expectedCwd)),
    );
    const unlocated = distinct.filter((session) => session.cwds.length === 0);
    if (!matches.length)
      return {
        ok: false,
        reason: "missing",
        message: `no native session matches the displayed prefix "${prefix}"`,
      };
    if (!here.length)
      return {
        ok: false,
        reason: "cwd-mismatch",
        message: `the native session matching "${prefix}" is not proven to run in "${expectedCwd}"`,
      };
    if (here.length > 1)
      return {
        ok: false,
        reason: "ambiguous",
        message: `${here.length} native sessions match the displayed prefix "${prefix}" in "${expectedCwd}"`,
      };
    if (unlocated.length)
      return {
        ok: false,
        reason: "ambiguous",
        message: `a native session matching "${prefix}" has no recorded working directory and is not proven unique in "${expectedCwd}"`,
      };
    return { ok: true, sessionId: here[0]!.id };
  }

  resolveClaudeSession(
    status: string,
    expectedCwd?: string,
    candidates?: readonly SessionCandidate[],
  ): SessionEvidence {
    const displayed = this.parseClaudeStatusSession(status);
    if (displayed === null)
      return {
        ok: false,
        reason: "unreadable",
        message: "the Claude status panel exposes no full native session id",
      };
    return expectedCwd === undefined || candidates === undefined
      ? { ok: true, sessionId: displayed }
      : this.resolveSessionPrefix(displayed, candidates, expectedCwd);
  }

  resolveCodexSession(
    status: string,
    candidates: readonly SessionCandidate[],
    expectedCwd: string,
  ): SessionEvidence {
    const displayed = this.parseCodexStatusSession(status);
    return displayed === null
      ? {
          ok: false,
          reason: "unreadable",
          message: "the Codex status panel exposes no native session prefix",
        }
      : this.resolveSessionPrefix(displayed, candidates, expectedCwd);
  }

  validateSwitchTarget(
    current: LaunchRecipe,
    request: SwitchRequest,
  ): SwitchTargetResult {
    let storedModel: string;
    let targetModel: string;
    try {
      storedModel = resolveModel(current.harness, current.model);
    } catch (error) {
      return { ok: false, message: `stored ${(error as Error).message}` };
    }
    try {
      targetModel = resolveModel(current.harness, request.model);
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
    if (!sameLauncherFamily(current.harness, storedModel, targetModel))
      return {
        ok: false,
        message: `"${storedModel}" launches through ${launcherFamily(current.harness, storedModel)} but "${targetModel}" launches through ${launcherFamily(current.harness, targetModel)}; switching across launcher families is not supported`,
      };
    const range = modelEffortRange(current.harness, targetModel);
    if (range === undefined)
      return {
        ok: false,
        message: `no configured effort range for ${current.harness} model "${targetModel}"`,
      };
    const effort = request.effort ?? current.effort;
    if (!Number.isInteger(effort) || effort < range.min || effort > range.max)
      return {
        ok: false,
        message: `${request.effort === undefined ? "stored" : "requested"} effort ${effort} is outside the supported range ${range.min}–${range.max} for "${targetModel}"`,
      };
    return {
      ok: true,
      target: { harness: current.harness, model: targetModel, effort },
    };
  }
}

