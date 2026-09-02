import { Injectable } from "@nestjs/common";
import { access } from "node:fs/promises";
import path from "node:path";
import { RUNTIME_THRONE_ROOT } from "../shared-policy/runtime-throne-root.ts";
import { RUNTIME_DATA_DIR } from "../shared-policy/runtime-data-home.ts";
import { errorText } from "../shared-policy/error-text.ts";
import type { HerdrAgent } from "../herdr/herdr-inventory.service.ts";
import { listAgents as listLiveAgents } from "../herdr/herdr-runtime.service.ts";
import { sameAgentName } from "../herdr/herdr-identity-contracts.ts";
import { sleep } from "../herdr/herdr-screen.service.ts";
import {
  REGENT_NAME,
  REGENT_RESURRECTION_COMPOSER_WAIT_MS,
} from "../regent-state/regent-state.service.ts";
import { REAP_REASON, type ReapReason } from "../agent-timings/reap-reason.ts";
import { runReapAgent } from "../reap-agent/reap-agent-runtime.ts";
import { hasDeliveryCommit } from "../git-lifecycle/delivery-commit-proof.ts";
import {
  HARNESS_NAMES,
  MODEL_NAMES,
  buildCustomLaunchArgv,
  buildLaunchArgv,
  buildResumeArgv,
  resolveModel,
  type Harness,
} from "../harness-routing/harness.ts";
import { SessionService } from "../session/session.service.ts";
import {
  readSpawnSpec,
  type SpawnSpec,
} from "../agentdata/spawn-data-contracts.ts";
import { resumeRegisteredAgentInRestoredTab } from "../herdr/herdr-create.service.ts";
import { deliverOpeningPrompt } from "../herdr/herdr-opening-prompt.ts";
import { PERSONA_CONFIG } from "../application-config.service.ts";
import { LedgerDataService } from "../agentdata/ledger-data.service.ts";
import {
  clearBlockedMarker,
  readBlockedMarker,
} from "../agentdata/blocked-marker.service.ts";
import { flagLiveCwdOrphans } from "./throne-startup-cwd-guard.ts";

export type StartupOrphanAction = "resume" | "reap" | "skip" | "flag-missing-cwd";

export interface StartupOrphanOutcome {
  name: string;
  action: StartupOrphanAction;
  reason: string;
  ok: boolean;
  error?: string;
}

export interface StartupReconciliationContract {
  listRegisteredAgents: () => Promise<string[]>;
  listCompletedAgents: () => Promise<string[]>;
  hasResumableWork: (name: string) => Promise<boolean>;
  /** A second, independent completion signal alongside REPORT.md: true when a
   *  `Deliver <name>` commit (stamped by `mergeBack`, see
   *  `git-lifecycle/merge.ts`) is reachable in the throne's own branch
   *  history. A DEAD orphan with no REPORT.md but a landed delivery commit
   *  died after finishing, not mid-work. */
  hasDeliveryCommit: (name: string) => Promise<boolean>;
  listLiveAgents: () => Promise<HerdrAgent[]>;
  readSpawnSpec: (name: string) => Promise<SpawnSpec | null>;
  resume: (name: string) => Promise<void>;
  reap: (name: string, reason: ReapReason) => Promise<void>;
  readBlockedMarker: (name: string) => Promise<{ blockedAt: string } | null>;
  clearBlockedMarker: (name: string) => Promise<void>;
  /** Whether `target` still exists on disk. Backs the LIVE-agent cwd-occupancy
   *  check below — a LIVE agent whose recorded cwd is gone is the CWD
   *  campaign's defining symptom (its tree was removed out from under it,
   *  e.g. by a reap of a DIFFERENT agent's worktree it was occupying). */
  pathExists: (target: string) => Promise<boolean>;
  log: (message: string) => void;
  warn: (message: string) => void;
}

const THRONE_ROOT = RUNTIME_THRONE_ROOT;

// A candidate absent from reconciliation's up-front live-agent snapshot is not
// yet death-evidenced — harness visibility legitimately lags registration.
// AGENT_DETECTION_TIMEOUT_MS (src/herdr/herdr-launch-command.ts:26) is the
// throne's own already-encoded worst-case bound for a just-launched agent's
// pane to become visible in `herdr agent list`; the recheck below samples
// across that same window (3 samples, 5s apart) before treating absence as
// durable.
const RECHECK_SAMPLE_COUNT = 3;
const RECHECK_INTERVAL_MS = 5_000;

// A registered agent's age must clear this floor before reap may ever be
// selected, regardless of what the recheck shows — margin beyond the recheck
// window itself, for the case where reconciliation's initial snapshot fires
// partway through herdr's own 15s detection window, plus scheduling/query
// jitter between throne-startup's up-front listAgents() call and
// reconciliation actually running. Twice the recheck ceiling
// (RECHECK_SAMPLE_COUNT * RECHECK_INTERVAL_MS, itself derived from
// AGENT_DETECTION_TIMEOUT_MS above).
const MIN_AGE_FLOOR_MS = 2 * RECHECK_SAMPLE_COUNT * RECHECK_INTERVAL_MS;
const DEFAULT_MODELS: Readonly<Record<Harness, string>> = {
  [HARNESS_NAMES.CLAUDE]: MODEL_NAMES.OPUS,
  [HARNESS_NAMES.CODEX]: MODEL_NAMES.GPT_5_6_SOL,
  [HARNESS_NAMES.OPENCODE]: MODEL_NAMES.DEEPSEEK_V4_FLASH,
  [HARNESS_NAMES.CLAUDEY_ALL_OMNI]: MODEL_NAMES.GPT_5_6_SOL,
  [HARNESS_NAMES.CODEXY_ALL_OMNI]: MODEL_NAMES.GPT_5_6_SOL,
  // Mechanical typecheck fix only: omp is not activated by any preset yet
  // (00_overview.md), so this default is never reached by a live
  // reconciliation today. Mirrors the claude row's default model.
  [HARNESS_NAMES.OMP]: MODEL_NAMES.OPUS,
};

export interface StartupResumeContract {
  readSpawnSpec: (name: string) => Promise<SpawnSpec | null>;
  resumeRegisteredAgentInRestoredTab: typeof resumeRegisteredAgentInRestoredTab;
  deliverOpeningPrompt: typeof deliverOpeningPrompt;
  pathExists: (path: string) => Promise<boolean>;
  throneRoot: string;
  log: (message: string) => void;
  warn: (message: string) => void;
}

export function buildResumePrompt(name: string, throneRoot: string): string {
  const data = path.join(RUNTIME_DATA_DIR, name);
  const tools = path.join(throneRoot, "src", "tools.ts");
  return `You are \`${name}\`, a ${PERSONA_CONFIG.throneTitle.toLowerCase()} agent relaunched by startup reconciliation after your previous process died (crash/kill/reboot — the court self-heals). Re-establish yourself and RESUME your in-flight work: (1) read your identity + chain of command at ${path.join(data, "identity.md")}; (2) look under ${data} for your work — an /execute-todos bundle (a \`todo-*\` folder) or a ${PERSONA_CONFIG.tierTitles.shadow} ASSIGNMENT.md — and continue it where it left off; (3) drive all tooling through ${tools} (the live throne root), report progress to your supervisor and escalate genuine blockers to the ${PERSONA_CONFIG.tierTitles.regent} via send-agent. You never put a question to the ${PERSONA_CONFIG.addressTitle} — decisions are yours.`;
}

function buildExactResumePrompt(name: string, harness: string): string {
  return `You are \`${name}\`. Your previous process died (crash/kill/reboot) and startup reconciliation relaunched you into your EXACT previous native ${harness} session, so the transcript above is your own. Re-read your last few turns and CONTINUE that in-flight work where it stopped — do not restart it and do not re-plan what you already finished. Report progress to your supervisor and escalate genuine blockers to the ${PERSONA_CONFIG.tierTitles.regent} via send-agent. You never put a question to the ${PERSONA_CONFIG.addressTitle} — decisions are yours.`;
}

function pathExists(target: string): Promise<boolean> {
  return access(target).then(
    () => true,
    () => false,
  );
}

export function normalizeSpec(
  spec: SpawnSpec | null,
  throneRoot: string,
  sessions = new SessionService(),
) {
  const harness: Harness =
    spec?.harness === HARNESS_NAMES.CODEX
      ? HARNESS_NAMES.CODEX
      : HARNESS_NAMES.CLAUDE;
  const effort =
    typeof spec?.effort === "number" &&
    Number.isInteger(spec.effort) &&
    spec.effort >= 1 &&
    spec.effort <= 6
      ? spec.effort
      : 6;
  let model = spec?.model ?? DEFAULT_MODELS[harness];
  try {
    model = resolveModel(harness, model);
  } catch {
    model = DEFAULT_MODELS[harness];
  }
  const cwd = spec?.cwd ?? throneRoot;
  if (spec?.harness_executable !== undefined)
    return {
      harness,
      model,
      effort,
      cwd,
      custom: {
        executable: spec.harness_executable,
        passthrough: spec.passthrough_argv ?? [],
      },
    };
  return sessions.isFullSessionId(spec?.session_id)
    ? {
        harness,
        model,
        effort,
        cwd,
        sessionId: spec.session_id.trim().toLowerCase(),
      }
    : { harness, model, effort, cwd };
}

const REAL_RESUME_CONTRACT: StartupResumeContract = {
  readSpawnSpec,
  resumeRegisteredAgentInRestoredTab,
  deliverOpeningPrompt,
  pathExists,
  throneRoot: THRONE_ROOT,
  log: (message) => process.stdout.write(message),
  warn: (message) => process.stderr.write(message),
};

export async function resumeOrphan(
  name: string,
  contract: StartupResumeContract = REAL_RESUME_CONTRACT,
): Promise<void> {
  const spec = normalizeSpec(
    await contract.readSpawnSpec(name),
    contract.throneRoot,
  );
  let cwd = spec.cwd;
  let sessionId = spec.sessionId;
  if (!(await contract.pathExists(cwd))) {
    contract.log(
      `throne-startup: resume "${name}" — recorded cwd "${cwd}" is gone; relaunching in the throne root instead\n`,
    );
    cwd = contract.throneRoot;
    sessionId = undefined;
  }
  const recipe = {
    harness: spec.harness,
    model: spec.model,
    effort: spec.effort,
  };
  const argv =
    spec.custom !== undefined
      ? buildCustomLaunchArgv(spec.custom.executable, spec.custom.passthrough)
      : sessionId !== undefined
        ? buildResumeArgv(recipe, sessionId)
        : buildLaunchArgv(recipe);
  const result = await contract.resumeRegisteredAgentInRestoredTab(name, {
    cwd,
    argv,
  });
  if (result.kind === "already-live") return;
  const harness = spec.harness === HARNESS_NAMES.CLAUDE ? "Claude" : "Codex";
  if (sessionId !== undefined) {
    contract.log(
      `throne-startup: resume "${name}" — relaunched into its exact native ${harness} session ${sessionId}; its own transcript is intact\n`,
    );
    // Bounded composer wait, same reasoning as `resurrectRegent`'s own
    // `deliverOpeningPrompt` call (see `REGENT_RESURRECTION_COMPOSER_WAIT_MS`'s
    // doc comment): this reconciliation pass can itself be resuming `Regent`,
    // and a concurrent, independent `resurrectRegent` attempt racing against
    // the SAME name only has `RESURRECT_LOCK_STALE_MS` (5 minutes) of
    // patience — a 15-minute resident-draft wait here would let that lock go
    // stale and get reclaimed mid-resume, spawning a genuine duplicate.
    await contract.deliverOpeningPrompt(name, buildExactResumePrompt(name, harness), {
      composerWaitMilliseconds: REGENT_RESURRECTION_COMPOSER_WAIT_MS,
      forceSubmitResidentDraftOnTimeout: false,
    });
    return;
  }
  contract.warn(
    `throne-startup: resume "${name}" — durable spawn state has no native ${harness} session identity, so native ${harness} conversation state cannot be resumed; the absolute ledger-rebrief prompt was used instead\n`,
  );
  await contract.deliverOpeningPrompt(name, buildResumePrompt(name, contract.throneRoot), {
    composerWaitMilliseconds: REGENT_RESURRECTION_COMPOSER_WAIT_MS,
    forceSubmitResidentDraftOnTimeout: false,
  });
}

/** Names live agents are addressed by, per the same convention `reconcile()` diffs against. */
function extractLiveNames(agents: HerdrAgent[]): string[] {
  return agents
    .map((agent) => agent.tabLabel ?? agent.name)
    .filter((name): name is string => name !== undefined);
}

/**
 * Durable death evidence for `name`: true only if every sample across a
 * bounded recheck shows it absent from the live roster. A candidate that
 * reappears on any sample is not death-evidenced — harness visibility
 * legitimately lags registration, so one absent snapshot is not proof.
 */
export async function confirmGenuinelyAbsent(
  name: string,
  listLive: () => Promise<HerdrAgent[]>,
): Promise<boolean> {
  for (let sample = 0; sample < RECHECK_SAMPLE_COUNT; sample++) {
    if (sample > 0) await sleep(RECHECK_INTERVAL_MS);
    const live = extractLiveNames(await listLive());
    if (live.some((liveName) => sameAgentName(liveName, name))) return false;
  }
  return true;
}

/**
 * Milliseconds since `name` was registered (`spawn.json`'s `spawned_at`), or
 * `null` when unmeasurable (missing/unparseable) — an agent this feature
 * cannot measure falls through to being governed by death evidence alone,
 * gaining no unbounded protection it never asked for.
 */
async function computeRegistrationAgeMs(
  name: string,
  readSpawn: (name: string) => Promise<SpawnSpec | null>,
): Promise<number | null> {
  const spec = await readSpawn(name);
  if (spec?.spawned_at === undefined) return null;
  const spawnedAtMs = Date.parse(spec.spawned_at);
  return Number.isNaN(spawnedAtMs) ? null : Date.now() - spawnedAtMs;
}

function classify(
  complete: boolean,
  resumable: boolean,
  deathEvidence: boolean,
  ageMs: number | null,
): { action: StartupOrphanAction; reason: string } {
  if (!complete && resumable)
    return { action: "resume", reason: "in-flight work to continue" };
  // Every remaining path is a reap candidate (complete, or inert-and-not-
  // resumable) — both require durable death evidence AND a sufficient age
  // before reap may be selected at all.
  if (!deathEvidence)
    return {
      action: "skip",
      reason: "reappeared live during the bounded recheck; not death-evidenced",
    };
  if (ageMs !== null && ageMs < MIN_AGE_FLOOR_MS)
    return {
      action: "skip",
      reason: `age ${ageMs}ms is below the ${MIN_AGE_FLOOR_MS}ms minimum-age floor; deferring to a later reconciliation pass`,
    };
  return {
    action: "reap",
    reason: complete
      ? "complete (REPORT.md landed or a Deliver commit proves it)"
      : "inert (no bundle/assignment to resume)",
  };
}

const REAL_CONTRACT: StartupReconciliationContract = {
  listRegisteredAgents: () => new LedgerDataService().listRegisteredAgents(),
  listCompletedAgents: () => new LedgerDataService().listCompletedAgents(),
  hasResumableWork: (name) => new LedgerDataService().hasResumableWork(name),
  hasDeliveryCommit: (name) => hasDeliveryCommit(name),
  listLiveAgents: () => listLiveAgents(),
  readSpawnSpec: (name) => readSpawnSpec(name),
  resume: (name) => resumeOrphan(name),
  reap: async (name, reason) => {
    const code = await runReapAgent([name, "--reason", reason]);
    if (code !== 0) throw new Error(`reap-agent exited ${code}`);
  },
  readBlockedMarker: (name) => readBlockedMarker(name),
  clearBlockedMarker: (name) => clearBlockedMarker(name),
  pathExists,
  log: (message) => process.stdout.write(message),
  warn: (message) => process.stderr.write(message),
};

/**
 * A `skip`-classified agent (not confirmed dead-and-reapable by the reap
 * gates) may still be genuinely dead while a stale `blocked.json` excludes
 * it from `no-idling` forever. Reuses `confirmGenuinelyAbsent` directly — no
 * second staleness/sampling mechanism — and, if death is re-confirmed, lifts
 * only the blocked exclusion; the rest of the agent's ledger state is
 * untouched since SRR did not decide to reap it.
 */
async function clearBlockedMarkerIfDeadWhileSkipped(
  name: string,
  contract: StartupReconciliationContract,
): Promise<void> {
  const marker = await contract.readBlockedMarker(name);
  if (marker === null) return;
  const stillDeathEvidenced = await confirmGenuinelyAbsent(
    name,
    contract.listLiveAgents,
  );
  if (!stillDeathEvidenced) return;
  await contract.clearBlockedMarker(name);
  contract.log(
    `throne-startup: reconciliation — cleared stale blocked marker for "${name}" (confirmed dead while skip-classified)\n`,
  );
}

@Injectable()
export class ThroneStartupReconciliationService {
  private readonly contract: StartupReconciliationContract;

  constructor(contract: StartupReconciliationContract = REAL_CONTRACT) {
    this.contract = contract;
  }

  async reconcile(liveAgents: HerdrAgent[]): Promise<StartupOrphanOutcome[]> {
    // Runs first and independently of the orphan resume/reap loop below: it
    // inspects LIVE agents (the loop below only ever looks at agents ALREADY
    // absent from the roster), so it is the one pass that catches the CWD
    // campaign's defining shape — a registered agent still reporting in whose
    // recorded cwd was deleted out from under it.
    const cwdFlags = await flagLiveCwdOrphans(liveAgents, this.contract);
    const [registered, completedList] = await Promise.all([
      this.contract.listRegisteredAgents(),
      this.contract.listCompletedAgents(),
    ]);
    const completed = new Set(completedList);
    const live = extractLiveNames(liveAgents);
    const orphans = registered.filter(
      (name) =>
        !live.some((liveName) => sameAgentName(liveName, name)) &&
        !sameAgentName(name, REGENT_NAME),
    );
    if (orphans.length === 0) {
      this.contract.log(
        "throne-startup: reconciliation — no orphaned agents; the court is clean\n",
      );
      return cwdFlags;
    }

    this.contract.log(
      `throne-startup: reconciliation — ${orphans.length} orphaned agent(s) ` +
        "(dead but registered); applying resume-or-reap policy\n",
    );
    const outcomes: StartupOrphanOutcome[] = [];
    for (const name of orphans) {
      let action: StartupOrphanAction | undefined;
      let reason = "classification errored before an action was chosen";
      try {
        const isComplete =
          completed.has(name) || (await this.contract.hasDeliveryCommit(name));
        const resumable = await this.contract.hasResumableWork(name);
        // Death evidence and age are only needed to authorize a reap; a
        // resumable-and-not-complete candidate resumes without either check.
        const isReapCandidate = isComplete || !resumable;
        const deathEvidence = isReapCandidate
          ? await confirmGenuinelyAbsent(name, this.contract.listLiveAgents)
          : true;
        const ageMs = isReapCandidate
          ? await computeRegistrationAgeMs(name, this.contract.readSpawnSpec)
          : null;
        ({ action, reason } = classify(
          isComplete,
          resumable,
          deathEvidence,
          ageMs,
        ));
        if (action === "resume") await this.contract.resume(name);
        else if (action === "reap")
          await this.contract.reap(
            name,
            isComplete ? REAP_REASON.COMPLETED : REAP_REASON.ORPHAN,
          );
        else await clearBlockedMarkerIfDeadWhileSkipped(name, this.contract);
        this.contract.log(
          `throne-startup: reconciliation — ${action} "${name}" (${reason})\n`,
        );
        outcomes.push({ name, action, reason, ok: true });
      } catch (error) {
        const message = errorText(error);
        this.contract.warn(
          `throne-startup: reconciliation — ${action ? `${action} ` : ""}"${name}" (${reason}) ` +
            `FAILED (${message}); continuing\n`,
        );
        outcomes.push({
          name,
          action: action ?? "reap",
          reason,
          ok: false,
          error: message,
        });
      }
    }
    return [...cwdFlags, ...outcomes];
  }
}
