import {
  buildCustomLaunchArgv,
  buildLaunchArgv,
} from "../harness-routing/harness.ts";
import {
  AgentStartIndeterminateError,
  derivePersonaTabLabel,
  reconcileIndeterminateAgentStart,
} from "../herdr/herdr-create.service.ts";
import { PERSONA_CONFIG } from "../application-config.service.ts";
import { REGENT_NAME } from "../regent-state/regent-state.service.ts";
import {
  type CreateAgentDeps,
  type PolicyResolution,
  type StageResult,
} from "./create.types.ts";
import { stderrWriter, stdoutWriter } from "./command-context.ts";
import {
  createAgentIdentity,
  createAgentOpeningPrompts,
  persistNewAgentRecord,
} from "./agent-record.ts";
import {
  prepareCodexLaunchTrust,
  verifyCodexLaunchTrust,
} from "./codex-launch-trust.ts";
import { deliverAgentOpeningPrompt } from "./opening-prompt.ts";

function launchArgv(request: PolicyResolution): string[] {
  return request.customExecutable !== undefined
    ? buildCustomLaunchArgv(request.customExecutable, request.customPassthrough)
    : buildLaunchArgv({
        harness: request.launchHarness,
        model: request.launchModel,
        effort: request.launchEffort,
      });
}

async function startOrResumeAgent(
  request: PolicyResolution,
  deps: CreateAgentDeps,
  argv: string[],
  spawnedTabLabel?: string,
): Promise<StageResult<boolean>> {
  const writeStderr = stderrWriter(deps);
  let harnessWasLaunched = true;
  try {
    if (request.resuming) {
      const result = await deps.resumeRegisteredAgentInRestoredTab(
        request.name,
        { cwd: request.cwd, argv },
      );
      harnessWasLaunched = result.kind !== "already-live";
    } else {
      await deps.startAgent(request.name, {
        cwd: request.cwd,
        argv,
        tabLabel: spawnedTabLabel,
      });
    }
  } catch (error) {
    if (!request.resuming && error instanceof AgentStartIndeterminateError) {
      try {
        const result = await (
          deps.reconcileIndeterminateAgentStart ??
          reconcileIndeterminateAgentStart
        )(request.name, error.tabId, error.paneId, { cwd: request.cwd, argv });
        if (result.kind === "already-live") {
          harnessWasLaunched = false;
        } else {
          await deps.closeAgentTab({
            tabId: error.tabId,
            paneId: error.paneId,
          });
          await deps.removeRegistration(request.name);
          writeStderr(
            `create-agent-legacy: launch of "${request.name}" timed out after Herdr issued it, ` +
              `but exact-identity reconciliation proved its tab shell-only. ` +
              `The exact launched tab was closed before its fresh registration was removed.\n`,
          );
          return { ok: false, code: 1 };
        }
      } catch (reconciliationError) {
        writeStderr(
          `create-agent-legacy: launch of "${request.name}" timed out after Herdr issued it, ` +
            `and exact-identity reconciliation remained indeterminate ` +
            `(${reconciliationError instanceof Error ? reconciliationError.message : String(reconciliationError)}). ` +
            `Registration and the exact launched tab are retained; do not create another ` +
            `agent or tab. Re-run this exact create-agent command to reconcile it ` +
            `again, or inspect it with ./bin/throne-cli agent-statuses.\n`,
        );
        return { ok: false, code: 1 };
      }
    } else if (request.resuming) {
      writeStderr(
        `create-agent-legacy: registered agent "${request.name}" could not be proven live or ` +
          `failed during bounded exact-identity reconciliation ` +
          `(${error instanceof Error ? error.message : String(error)}). ` +
          `Its registration and Herdr state were retained; do not create another ` +
          `agent or tab. Re-run this exact create-agent command to reconcile it ` +
          `again, or inspect it with ./bin/throne-cli agent-statuses.\n`,
      );
      return { ok: false, code: 1 };
    } else {
      await deps.removeRegistration(request.name).catch(() => undefined);
      throw error;
    }
  }
  return { ok: true, value: harnessWasLaunched };
}

function reportResidentAgent(
  request: PolicyResolution,
  deps: CreateAgentDeps,
): void {
  const routed =
    request.routingNote === "" ? "" : ` — routed: ${request.routingNote}`;
  const policyOverrideNote = [
    request.capabilityOverrideNote,
    request.effortOverrideNote,
    request.harnessOverrideNote,
  ]
    .filter(Boolean)
    .join("; ");
  const policy =
    policyOverrideNote === ""
      ? ""
      : ` — policy override: ${policyOverrideNote}`;
  const action = request.resuming ? "Resumed" : "Spawned";
  const supervisor = request.flags.supervisor as string;
  const escalation =
    request.flags.escalation ??
    (request.role === "Shadow" ? supervisor : REGENT_NAME);
  stdoutWriter(deps)(
    `${action} "${request.name}" (${request.role}) via ${request.launchHarness} ` +
      `[${request.launchModel} / effort ${request.launchEffort}] ` +
      `— supervisor ${supervisor}, escalation ${escalation}${routed}${policy}.\n`,
  );
}

export async function runResidentAgent(
  request: PolicyResolution,
  deps: CreateAgentDeps,
): Promise<number> {
  const spawnedTabLabel = request.resuming
    ? undefined
    : derivePersonaTabLabel(request.name, PERSONA_CONFIG);
  const identity = createAgentIdentity(
    request,
    request.role === "Shadow"
      ? (request.flags.supervisor as string)
      : REGENT_NAME,
    spawnedTabLabel,
  );
  const prompts = await createAgentOpeningPrompts(request, identity);
  const argv = launchArgv(request);
  if (!(await prepareCodexLaunchTrust(request, deps))) {
    return 1;
  }
  if (
    !(await persistNewAgentRecord(request, deps, identity, prompts.complete))
  ) {
    return 1;
  }
  const start = await startOrResumeAgent(request, deps, argv, spawnedTabLabel);
  if (!start.ok) {
    return start.code;
  }
  if (!(await verifyCodexLaunchTrust(request, deps))) {
    return 1;
  }
  if (
    !(await deliverAgentOpeningPrompt(
      request,
      deps,
      prompts.delivered,
      start.value,
    ))
  ) {
    return 1;
  }
  reportResidentAgent(request, deps);
  return 0;
}
