import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { RUNTIME_THRONE_ROOT } from "../shared-policy/runtime-throne-root.ts";
import { RUNTIME_DATA_DIR } from "../shared-policy/runtime-data-home.ts";
import { randomUUID } from "node:crypto";
import {
  ALPHA_INSPECTION_CONTEXTS,
  type AlphaInspectionAdmission,
  type AlphaInspectionCaller,
  type AlphaInspectionContext,
  type AlphaInspectionDecision,
  type AlphaInspectionRequest,
  type AlphaInspectionState,
} from "./alpha-monitoring.types.ts";
import { acquireAtomicMkdirLock } from "./atomic-mkdir-lock.ts";

export const ALPHA_INSPECTION_MINIMUM_INTERVAL_MS = 30 * 60 * 1000;
const INSPECTION_CONTEXT_FLAG = "--inspection-context";
const INSPECTION_EVENT_FLAG = "--inspection-event";
const AGENT_STATUSES_TARGET = "roster";
const ALPHA_ROLE = "Alpha";
const THRONE_ROOT = RUNTIME_THRONE_ROOT;
const STATE_DIRECTORY = path.join(
  RUNTIME_DATA_DIR,
  ".runtime",
  "alpha-monitoring",
);
const STATE_PATH = path.join(STATE_DIRECTORY, "admission.json");
const LOCK_PATH = path.join(STATE_DIRECTORY, "admission.lock");

export interface AlphaMonitoringDependencies {
  readonly resolveCaller: () => Promise<AlphaInspectionCaller | null>;
  readonly now: () => number;
  readonly statePath: string;
  readonly lockPath: string;
}

const EMPTY_STATE: AlphaInspectionState = { ordinary: {}, trustedEvents: {} };

function isInspectionContext(value: string): value is AlphaInspectionContext {
  return (ALPHA_INSPECTION_CONTEXTS as readonly string[]).includes(value);
}

function inspectionRequestKey(
  caller: AlphaInspectionCaller,
  request: AlphaInspectionRequest,
): string {
  return JSON.stringify([caller.name, request.command, request.target]);
}

function requiresEventIdentity(context: AlphaInspectionContext): boolean {
  return (
    context === "blocker" ||
    context === "completion" ||
    context === "lord-status"
  );
}

export function parseAlphaInspectionRequest(argv: readonly string[]): {
  readonly request: AlphaInspectionRequest | null;
  readonly argv: readonly string[];
  readonly error?: string;
} {
  const command = argv[2];
  if (command !== "agent-logs" && command !== "agent-statuses") {
    return { request: null, argv };
  }

  const forwarded = argv.slice(0, 3);
  let context: AlphaInspectionContext = "ordinary";
  let eventId: string | undefined;
  for (let index = 3; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === INSPECTION_CONTEXT_FLAG) {
      const value = argv[index + 1];
      if (value === undefined || !isInspectionContext(value)) {
        return {
          request: null,
          argv,
          error: `${INSPECTION_CONTEXT_FLAG} requires one of ${ALPHA_INSPECTION_CONTEXTS.join("|")}`,
        };
      }
      context = value;
      index += 1;
    } else if (argument === INSPECTION_EVENT_FLAG) {
      const value = argv[index + 1];
      if (value === undefined || value.trim() === "") {
        return {
          request: null,
          argv,
          error: `${INSPECTION_EVENT_FLAG} requires a non-empty identity`,
        };
      }
      eventId = value;
      index += 1;
    } else {
      forwarded.push(argument);
    }
  }

  if (eventId !== undefined) {
    return {
      request: null,
      argv,
      error: `${INSPECTION_EVENT_FLAG} is not accepted; event identity comes from delivered messages`,
    };
  }

  const target =
    command === "agent-statuses" ? AGENT_STATUSES_TARGET : forwarded[3];
  if (target === undefined) {
    return { request: null, argv: forwarded };
  }
  return { request: { command, target, context, eventId }, argv: forwarded };
}

export function decideAlphaInspectionAdmission(
  caller: AlphaInspectionCaller,
  request: AlphaInspectionRequest,
  state: AlphaInspectionState,
  now: number,
): AlphaInspectionDecision {
  if (caller.role !== ALPHA_ROLE) {
    return { admitted: true, state };
  }
  if (request.context === "regent-diagnostic") {
    return {
      admitted: false,
      diagnostic:
        "regent-diagnostic inspection requires a proven Regent caller",
    };
  }
  if (requiresEventIdentity(request.context)) {
    const pending = Object.entries(state.trustedEvents)
      .filter(
        ([, event]) =>
          event.recipient === caller.name &&
          event.context === request.context &&
          event.target === request.target &&
          event.consumedAt === undefined,
      )
      .sort((left, right) => left[1].deliveredAt - right[1].deliveredAt)[0];
    const eventId = pending?.[0];
    const event = pending?.[1];
    if (event === undefined || eventId === undefined) {
      return {
        admitted: false,
        diagnostic: `${request.context} inspection requires a matching delivered event`,
      };
    }
    return {
      admitted: true,
      state: {
        ordinary: state.ordinary,
        trustedEvents: {
          ...state.trustedEvents,
          [eventId]: { ...event, consumedAt: now },
        },
      },
    };
  }

  const ordinaryKey = inspectionRequestKey(caller, request);
  const previous = state.ordinary[ordinaryKey];
  if (
    previous !== undefined &&
    now - previous < ALPHA_INSPECTION_MINIMUM_INTERVAL_MS
  ) {
    return {
      admitted: false,
      diagnostic:
        "Alpha supervision inspection refused inside the 30-minute minimum interval",
    };
  }
  return {
    admitted: true,
    state: {
      ordinary: { ...state.ordinary, [ordinaryKey]: now },
      trustedEvents: state.trustedEvents,
    },
  };
}

function isAlphaInspectionState(value: unknown): value is AlphaInspectionState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.ordinary === "object" &&
    candidate.ordinary !== null &&
    typeof candidate.trustedEvents === "object" &&
    candidate.trustedEvents !== null &&
    Object.values(candidate.ordinary).every(
      (item) => typeof item === "number",
    ) &&
    Object.values(candidate.trustedEvents).every((item) => {
      if (typeof item !== "object" || item === null) return false;
      const event = item as Record<string, unknown>;
      return (
        typeof event.recipient === "string" &&
        (event.context === "blocker" ||
          event.context === "completion" ||
          event.context === "lord-status") &&
        typeof event.target === "string" &&
        typeof event.deliveredAt === "number" &&
        (event.consumedAt === undefined || typeof event.consumedAt === "number")
      );
    })
  );
}

async function readState(statePath: string): Promise<AlphaInspectionState> {
  try {
    const value: unknown = JSON.parse(await readFile(statePath, "utf8"));
    if (isAlphaInspectionState(value)) return value;
    if (typeof value === "object" && value !== null) {
      const legacy = value as Record<string, unknown>;
      if (
        typeof legacy.ordinary === "object" &&
        legacy.ordinary !== null &&
        Object.values(legacy.ordinary).every(
          (item) => typeof item === "number",
        ) &&
        typeof legacy.reviewedEvents === "object" &&
        legacy.reviewedEvents !== null
      ) {
        return {
          ordinary: legacy.ordinary as Readonly<Record<string, number>>,
          trustedEvents: {},
        };
      }
    }
    throw new Error("malformed Alpha inspection state");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_STATE;
    throw error;
  }
}

async function decideWithPersistedState(
  caller: AlphaInspectionCaller,
  request: AlphaInspectionRequest,
  dependencies: AlphaMonitoringDependencies,
): Promise<AlphaInspectionDecision> {
  const release = await acquireAtomicMkdirLock({
    lockPath: dependencies.lockPath,
    holder: caller.name,
  });
  try {
    const state = await readState(dependencies.statePath);
    const decision = decideAlphaInspectionAdmission(
      caller,
      request,
      state,
      dependencies.now(),
    );
    if (decision.admitted) {
      await writeFile(
        dependencies.statePath,
        JSON.stringify(decision.state),
        "utf8",
      );
    }
    return decision;
  } finally {
    await release();
  }
}

export interface DeliveredSupervisionEvent {
  readonly sender: string;
  readonly senderRole: string;
  readonly senderSupervisor: string;
  readonly recipient: string;
  readonly recipientRole: string;
  readonly prompt: string;
}

export async function recordDeliveredSupervisionEvent(
  delivery: DeliveredSupervisionEvent,
  dependencies: AlphaMonitoringDependencies,
): Promise<string | null> {
  if (delivery.recipientRole !== ALPHA_ROLE) return null;
  let context: "blocker" | "completion" | "lord-status" | null = null;
  let target = delivery.sender;
  if (
    delivery.senderRole === "Shadow" &&
    delivery.senderSupervisor === delivery.recipient
  ) {
    if (/^\s*DONE\b/i.test(delivery.prompt)) context = "completion";
    else if (/\bblock(?:ed|er|ing)?\b/i.test(delivery.prompt))
      context = "blocker";
  } else if (
    delivery.senderRole === "Regent" &&
    /\bLord\b[\s\S]{0,80}\bstatus(?: request)?\b/i.test(delivery.prompt)
  ) {
    context = "lord-status";
    target = AGENT_STATUSES_TARGET;
  }
  if (context === null) return null;

  const release = await acquireAtomicMkdirLock({
    lockPath: dependencies.lockPath,
    holder: delivery.recipient,
  });
  try {
    const state = await readState(dependencies.statePath);
    const eventId = randomUUID();
    await writeFile(
      dependencies.statePath,
      JSON.stringify({
        ordinary: state.ordinary,
        trustedEvents: {
          ...state.trustedEvents,
          [eventId]: {
            recipient: delivery.recipient,
            context,
            target,
            deliveredAt: dependencies.now(),
          },
        },
      }),
      "utf8",
    );
    return eventId;
  } finally {
    await release();
  }
}

export async function admitAlphaInspection(
  argv: readonly string[],
  dependencies: AlphaMonitoringDependencies,
): Promise<AlphaInspectionAdmission> {
  const parsed = parseAlphaInspectionRequest(argv);
  if (parsed.error !== undefined) {
    return { admitted: false, argv: parsed.argv, diagnostic: parsed.error };
  }
  if (parsed.request === null) return { admitted: true, argv: parsed.argv };

  const caller = await dependencies.resolveCaller();
  if (caller === null || caller.role !== ALPHA_ROLE) {
    return { admitted: true, argv: parsed.argv };
  }
  let decision: AlphaInspectionDecision;
  try {
    decision = await decideWithPersistedState(
      caller,
      parsed.request,
      dependencies,
    );
  } catch (error) {
    return {
      admitted: false,
      argv: parsed.argv,
      diagnostic: `Alpha inspection admission state unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return decision.admitted
    ? { admitted: true, argv: parsed.argv }
    : { admitted: false, argv: parsed.argv, diagnostic: decision.diagnostic };
}

export function productionAlphaMonitoringDependencies(
  resolveCaller: () => Promise<AlphaInspectionCaller | null>,
): AlphaMonitoringDependencies {
  return {
    resolveCaller,
    now: Date.now,
    statePath: STATE_PATH,
    lockPath: LOCK_PATH,
  };
}
