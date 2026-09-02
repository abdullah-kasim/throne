import { runHerdr, type HerdrRuntimeMode } from "./herdr-client.ts";
import { DEFAULT_HERDR_RUNTIME_MODE } from "./herdr-client.ts";
import type {
  StartCallerContext,
  StartCallerContextDeps,
} from "./herdr-create.contracts.ts";
import { START_CONTEXT_ENV_ALLOWLIST } from "./herdr-agent-recovery.ts";
import { THRONE_HERDR_SESSION } from "./herdr-client.ts";
import { HerdrCommandError } from "./herdr-client.ts";
import type { StartFailureAnnotation } from "./herdr-create.contracts.ts";

export async function collectStartCallerContext(
  deps: StartCallerContextDeps = {
    runHerdr,
    cwd: () => process.cwd(),
    env: process.env,
    runtimeMode: DEFAULT_HERDR_RUNTIME_MODE,
  },
): Promise<StartCallerContext> {
  const env: Record<string, string> = {};
  for (const key of START_CONTEXT_ENV_ALLOWLIST) {
    const value = deps.env[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }
  const context: StartCallerContext = {
    callerCwd: deps.cwd(),
    herdrSession: deps.runtimeMode.herdrDecouple ? THRONE_HERDR_SESSION : null,
    herdrDecouple: deps.runtimeMode.herdrDecouple,
    env,
  };
  try {
    const { stdout } = await deps.runHerdr(["pane", "current"]);
    const pane = (
      JSON.parse(stdout) as {
        result?: { pane?: { pane_id?: unknown; tab_id?: unknown } };
      } | null
    )?.result?.pane;
    if (typeof pane?.pane_id === "string") {
      context.focusedPane = {
        paneId: pane.pane_id,
        tabId: typeof pane.tab_id === "string" ? pane.tab_id : undefined,
      };
    }
  } catch {}
  return context;
}

const START_FAILURE_ANNOTATION = Symbol.for("throne.startFailureAnnotation");

export function annotateStartFailure(
  error: unknown,
  annotation: StartFailureAnnotation,
): void {
  if (typeof error !== "object" || error === null) {
    return;
  }
  Object.defineProperty(error, START_FAILURE_ANNOTATION, {
    value: annotation,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

export function readStartFailureAnnotation(
  error: unknown,
): StartFailureAnnotation | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  return (error as Record<symbol, StartFailureAnnotation | undefined>)[
    START_FAILURE_ANNOTATION
  ];
}

export function isTransientPaneBusyStartError(
  error: unknown,
): error is HerdrCommandError {
  return error instanceof HerdrCommandError && error.code === "agent_pane_busy";
}
