import type { Harness } from "../harness-routing/harness.ts";

export interface SessionCandidate {
  id: string;
  cwd?: string;
}

export type SessionRefusal =
  "unreadable" | "missing" | "ambiguous" | "cwd-mismatch";

export type SessionEvidence =
  | { ok: true; sessionId: string }
  | { ok: false; reason: SessionRefusal; message: string };

export interface StatusFields {
  session?: string;
  model?: string;
  cwd?: string;
}

export interface LaunchRecipe {
  harness: Harness;
  model: string;
  effort: number;
}

export interface SwitchRequest {
  model: string;
  effort?: number;
}

export type SwitchTargetResult =
  { ok: true; target: LaunchRecipe } | { ok: false; message: string };
