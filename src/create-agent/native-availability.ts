import {
  HARNESS_NAMES,
  isGptModel,
  MODEL_NAMES,
  type Harness,
} from "../harness-routing/harness.ts";
import type {
  UnreadableUsageWindow,
  UsagePayload,
  UsageWindow,
} from "../plan-usage-remaining/telemetry.types.ts";
import type { CodexUsagePayload } from "../shared-policy/codex-usage.service.ts";
import { errorText } from "../shared-policy/error-text.ts";

export const NATIVE_CLAUDE_MODELS = [
  MODEL_NAMES.FABLE,
  MODEL_NAMES.OPUS,
] as const;
export type NativeClaudeModel = (typeof NATIVE_CLAUDE_MODELS)[number];
export interface NativeClaudeTarget {
  harness: typeof HARNESS_NAMES.CLAUDE;
  model: NativeClaudeModel;
}
export interface NativeClaudeWindowEvidence {
  cap_window: string;
  remaining_pct: number;
  reset_time?: string;
  scope_model?: string;
}
export type NativeClaudeAvailability =
  | {
      status: "available";
      target: NativeClaudeTarget;
      as_of: string;
      applicable_windows: NativeClaudeWindowEvidence[];
    }
  | {
      status: "exhausted";
      target: NativeClaudeTarget;
      as_of: string;
      exhausted_windows: NativeClaudeWindowEvidence[];
    }
  | {
      status: "stale-unknown";
      target: NativeClaudeTarget;
      as_of: string;
      error?: string;
    }
  | {
      status: "unknown";
      target: NativeClaudeTarget;
      as_of: string;
      reason:
        | "duplicate-applicable-window"
        | "malformed-applicable-window"
        | "missing-applicable-allowance";
      detail: string;
    }
  | {
      status: "source-failure";
      target: NativeClaudeTarget;
      as_of?: string;
      error: string;
    };
export type NativeClaudeUsageReader = () => Promise<UsagePayload>;

type ApplicableWindowName = "5h" | "weekly";
type SelectedWindow = { name: ApplicableWindowName; window: UsageWindow };
const isPercentage = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 100;
const scopedWeekly = (
  window: Pick<UsageWindow, "cap_window" | "scope_model">,
) =>
  window.cap_window.startsWith("weekly:") && window.scope_model !== undefined;
const matchesModel = (
  window: Pick<UsageWindow, "cap_window" | "scope_model">,
  model: NativeClaudeModel,
) => scopedWeekly(window) && window.scope_model?.toLowerCase() === model;
const windowEvidence = (window: UsageWindow): NativeClaudeWindowEvidence => ({
  cap_window: window.cap_window,
  remaining_pct: window.remaining_pct,
  ...(window.reset_time === undefined ? {} : { reset_time: window.reset_time }),
  ...(window.scope_model === undefined
    ? {}
    : { scope_model: window.scope_model }),
});
const isAvailability = (
  value: SelectedWindow | NativeClaudeAvailability | undefined,
): value is NativeClaudeAvailability =>
  value !== undefined && "status" in value;

function unknown(
  target: NativeClaudeTarget,
  payload: UsagePayload,
  reason: Extract<NativeClaudeAvailability, { status: "unknown" }>["reason"],
  detail: string,
): NativeClaudeAvailability {
  return { status: "unknown", target, as_of: payload.as_of, reason, detail };
}
function selectWindow(
  target: NativeClaudeTarget,
  payload: UsagePayload,
  name: ApplicableWindowName,
  readable: UsageWindow[],
  unreadable: UnreadableUsageWindow[],
): SelectedWindow | NativeClaudeAvailability | undefined {
  const count = readable.length + unreadable.length;
  if (count > 1)
    return unknown(
      target,
      payload,
      "duplicate-applicable-window",
      `Claude usage reported ${count} applicable ${name} windows for ${target.model}`,
    );
  if (unreadable.length === 1)
    return unknown(
      target,
      payload,
      "malformed-applicable-window",
      `Claude usage reported an unreadable applicable ${name} window for ${target.model}`,
    );
  if (readable.length === 0) return undefined;
  const window = readable[0];
  if (!isPercentage(window.used_pct) || !isPercentage(window.remaining_pct))
    return unknown(
      target,
      payload,
      "malformed-applicable-window",
      `Claude usage reported an out-of-range applicable ${name} percentage for ${target.model}`,
    );
  return { name, window };
}

export function evaluateNativeClaudeAvailability(
  target: NativeClaudeTarget,
  payload: UsagePayload,
): NativeClaudeAvailability {
  if (payload.stale === true)
    return {
      status: "stale-unknown",
      target,
      as_of: payload.as_of,
      ...(payload.error === undefined ? {} : { error: payload.error }),
    };
  if (payload.source === "error")
    return {
      status: "source-failure",
      target,
      as_of: payload.as_of,
      error: payload.error ?? "Claude usage source returned an error payload",
    };
  const windows = payload.windows ?? [],
    unreadable = payload.unreadable_windows ?? [];
  const session = selectWindow(
    target,
    payload,
    "5h",
    windows.filter((w) => w.cap_window === "5h"),
    unreadable.filter((w) => w.cap_window === "5h"),
  );
  if (isAvailability(session)) return session;
  const scoped = windows.filter((w) => matchesModel(w, target.model)),
    unreadableScoped = unreadable.filter((w) => matchesModel(w, target.model));
  const weekly = selectWindow(
    target,
    payload,
    "weekly",
    scoped.length + unreadableScoped.length > 0
      ? scoped
      : windows.filter((w) => w.cap_window === "weekly" && !scopedWeekly(w)),
    scoped.length + unreadableScoped.length > 0
      ? unreadableScoped
      : unreadable.filter(
          (w) => w.cap_window === "weekly" && w.scope_model === undefined,
        ),
  );
  if (isAvailability(weekly)) return weekly;
  const applicable = [session, weekly].filter(
    (value): value is SelectedWindow => value !== undefined,
  );
  if (applicable.length === 0)
    return unknown(
      target,
      payload,
      "missing-applicable-allowance",
      `Claude usage reported no readable applicable allowance for ${target.model}`,
    );
  const exhausted = applicable
    .filter(({ window }) => window.remaining_pct <= 0)
    .map(({ window }) => windowEvidence(window));
  return exhausted.length > 0
    ? {
        status: "exhausted",
        target,
        as_of: payload.as_of,
        exhausted_windows: exhausted,
      }
    : {
        status: "available",
        target,
        as_of: payload.as_of,
        applicable_windows: applicable.map(({ window }) =>
          windowEvidence(window),
        ),
      };
}

export async function getNativeClaudeAvailability(
  target: NativeClaudeTarget,
  source: NativeClaudeUsageReader,
): Promise<NativeClaudeAvailability> {
  try {
    return evaluateNativeClaudeAvailability(target, await source());
  } catch (error) {
    return { status: "source-failure", target, error: errorText(error) };
  }
}

export function nativeClaudeTarget(
  harness: Harness,
  model: string,
): NativeClaudeTarget | undefined {
  if (
    harness !== HARNESS_NAMES.CLAUDE ||
    (model !== MODEL_NAMES.FABLE && model !== MODEL_NAMES.OPUS)
  ) {
    return undefined;
  }
  return { harness, model: model as NativeClaudeModel };
}

function nativeModelLabel(model: NativeClaudeModel): string {
  return model === MODEL_NAMES.FABLE ? "Fable" : "Opus";
}

function nativeAvailabilityDetail(
  availability: NativeClaudeAvailability,
): string {
  if (availability.status === "stale-unknown") {
    return [
      `state stale-unknown as of ${availability.as_of}`,
      availability.error === undefined
        ? undefined
        : `source error: ${availability.error}`,
    ]
      .filter((part): part is string => part !== undefined)
      .join("; ");
  }
  if (availability.status === "unknown") {
    return (
      `state unknown as of ${availability.as_of}; ${availability.reason}: ` +
      availability.detail
    );
  }
  if (availability.status === "source-failure") {
    return (
      `state source-failure${availability.as_of === undefined ? "" : ` as of ${availability.as_of}`}; ` +
      `source error: ${availability.error}`
    );
  }
  return availability.status;
}

export function nativeClaudeGateResult(opts: {
  name: string;
  resuming: boolean;
  availability: NativeClaudeAvailability;
  bypassZeroQuota?: boolean;
}): { kind: "proceed" | "warn" | "refuse"; message?: string } {
  const { availability } = opts;
  if (availability.status === "available") return { kind: "proceed" };
  const model = nativeModelLabel(availability.target.model);
  if (availability.status === "exhausted") {
    const windows = availability.exhausted_windows
      .map(
        (window) =>
          `${window.cap_window} ${window.remaining_pct}% remaining ` +
          `(resets ${window.reset_time ?? "unknown"})`,
      )
      .join("; ");
    const residue = opts.resuming
      ? "The existing registration was retained; no tab or harness launch was created."
      : "No registration, tab, or harness launch was created.";
    if (opts.bypassZeroQuota === true) {
      return {
        kind: "proceed",
        message:
          `create-agent: OVERRIDE --bypass-zero-quota admitted final native Claude ${model} ` +
          `launch target "${opts.name}" because fresh usage as of ${availability.as_of} ` +
          `proves exact exhaustion: ${windows}. All other launch policy remains enforced.\n`,
      };
    }
    return {
      kind: "refuse",
      message:
        `create-agent: refusing final native Claude ${model} launch target ` +
        `"${opts.name}" — fresh usage as of ${availability.as_of} confirms ` +
        `exhaustion: ${windows}. Usage steering cannot bypass confirmed native ` +
        `exhaustion. ${residue}\n`,
    };
  }
  return {
    kind: "warn",
    message:
      `create-agent: warning for final native Claude ${model} launch target ` +
      `"${opts.name}" — ${nativeAvailabilityDetail(availability)}. Proceeding ` +
      `because only fresh confirmed exhaustion blocks this exact model.\n`,
  };
}

export function codexQuotaGateResult(opts: {
  name: string;
  resuming: boolean;
  payload: CodexUsagePayload;
  bypassZeroQuota?: boolean;
}): { kind: "proceed" | "warn" | "refuse"; message?: string } {
  const { payload } = opts;
  const windows = payload.windows ?? [];
  const readable = windows.filter(
    (window) =>
      Number.isFinite(window.remaining_pct) &&
      window.remaining_pct >= 0 &&
      window.remaining_pct <= 100,
  );
  const exhausted = readable.filter((window) => window.remaining_pct === 0);
  if (
    payload.source === "api" &&
    payload.stale !== true &&
    exhausted.length > 0
  ) {
    const evidence = exhausted
      .map(
        (window) =>
          `${window.cap_window} 0% remaining (resets ${window.reset_time ?? "unknown"})`,
      )
      .join("; ");
    if (opts.bypassZeroQuota === true) {
      return {
        kind: "proceed",
        message:
          `create-agent: OVERRIDE --bypass-zero-quota admitted final Codex launch target ` +
          `"${opts.name}" because fresh usage as of ${payload.as_of} proves exact exhaustion: ` +
          `${evidence}. All other launch policy remains enforced.\n`,
      };
    }
    const residue = opts.resuming
      ? "The existing registration was retained; no tab or harness launch was created."
      : "No registration, tab, or harness launch was created.";
    return {
      kind: "refuse",
      message:
        `create-agent: refusing final Codex launch target "${opts.name}" — fresh usage ` +
        `as of ${payload.as_of} confirms exhaustion: ${evidence}. Pass --bypass-zero-quota ` +
        `for a deliberate exact-zero launch test. ${residue}\n`,
    };
  }
  if (
    payload.source === "api" &&
    payload.stale !== true &&
    readable.length > 0
  ) {
    return { kind: "proceed" };
  }
  return { kind: "proceed" };
}

export async function finalQuotaGate(opts: {
  name: string;
  resuming: boolean;
  harness: Harness;
  model: string;
  checkedNativeTarget?: NativeClaudeTarget;
  bypassZeroQuota: boolean;
  readClaude: NativeClaudeUsageReader;
  readCodex: () => Promise<CodexUsagePayload>;
}): Promise<{ refuse: boolean; message?: string; overrideApplied: boolean }> {
  const target = nativeClaudeTarget(opts.harness, opts.model);
  if (target !== undefined) {
    if (
      opts.checkedNativeTarget?.harness === target.harness &&
      opts.checkedNativeTarget.model === target.model
    ) {
      return { refuse: false, overrideApplied: false };
    }
    const availability = await getNativeClaudeAvailability(
      target,
      opts.readClaude,
    );
    const gate = nativeClaudeGateResult({
      name: opts.name,
      resuming: opts.resuming,
      availability,
      bypassZeroQuota: opts.bypassZeroQuota,
    });
    return {
      refuse: gate.kind === "refuse",
      ...(gate.message === undefined ? {} : { message: gate.message }),
      overrideApplied:
        availability.status === "exhausted" && opts.bypassZeroQuota,
    };
  }
  if (!isGptModel(opts.model)) {
    return { refuse: false, overrideApplied: false };
  }
  const payload = await opts.readCodex();
  const gate = codexQuotaGateResult({
    name: opts.name,
    resuming: opts.resuming,
    payload,
    bypassZeroQuota: opts.bypassZeroQuota,
  });
  return {
    refuse: gate.kind === "refuse",
    ...(gate.message === undefined ? {} : { message: gate.message }),
    overrideApplied:
      payload.source === "api" &&
      payload.stale !== true &&
      payload.windows?.some((window) => window.remaining_pct === 0) === true &&
      opts.bypassZeroQuota,
  };
}
