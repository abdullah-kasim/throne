// The SessionStart-hook entry point: self-configures a freshly launched throne
// harness so the court works with no manual steps. It renames the top-level
// throne harness to `Regent` (only when that is unambiguously correct), and —
// for the confirmed Regent only — runs startup reconciliation to resume-or-reap
// agents orphaned by a crash or reboot (through the Nest-owned reconciliation
// service). It self-guards on cwd so firing from a broad/global SessionStart
// hook is harmless for every session that is NOT the genuine throne top-level
// harness.
//
// Ist campaign (2026-08-14): this used to also unconditionally call
// `ensureHeartbeat`, which re-enabled `throne-keep-going.timer` via
// `systemctl --user enable --now` on every session start — including on a box
// where `install-services` had just RETIRED that exact timer, since
// `throne-backend`'s hosted `KeepGoingHostedWorker` now owns keep-going.
// Every session start was silently undoing the retirement. `ensure-heartbeat`
// and its no-idling counterpart `ensure-no-idling` are retired along with this
// call — see `src/throne-backend/keep-going.hosted-worker.ts` /
// `no-idling.hosted-worker.ts` for where that job actually lives now, and
// `test/systemd-startup-invariant.test.ts` for the encoded invariant: the
// startup path must never `enable --now` any unit outside
// throne-herdr/throne-backend.
//
// SAFETY: a wrong rename branch would re-label a LIVE agent, so the rename only
// fires when the pane is confirmed to be the throne-root harness AND is unnamed
// AND no `Regent` already exists. Every failure path is caught and logged; the
// command ALWAYS returns 0 so it can never disrupt harness launch.

import path from "node:path";
import {
  describeOmpExtensionInstall,
  installOmpDeliveryExtension,
  INSTALLED_EXTENSION_NAME,
  type OmpExtensionInstallOutcome,
} from "../herdr/omp-extension-install.ts";
import { RUNTIME_THRONE_ROOT } from "../shared-policy/runtime-throne-root.ts";
import {
  LIVE_QUEUE_ITEM_STATUSES,
  renderRegentQueueAsMarkdown,
} from "../regent-queue/regent-queue-render.ts";
import { openRegentQueueStore } from "../regent-queue/regent-queue.store.ts";
import { currentPaneId } from "../herdr/herdr-session.service.ts";
import { renameTab } from "../herdr/herdr-tab.service.ts";
import { listAgents, renameAgent } from "../herdr/herdr-runtime.service.ts";
import { sameAgentName } from "../herdr/herdr-identity-contracts.ts";
import type { HerdrAgent } from "../herdr/herdr-inventory.service.ts";
import {
  readDesiredState,
  describeDesiredState,
  REGENT_NAME,
  writeRegentRoute,
  writeRegentHarness,
} from "../regent-state/regent-state.service.ts";
import { HARNESS_NAMES, type Harness } from "../harness-routing/harness.ts";
import { pathsResolveEqual } from "../shared-policy/path-equivalence.ts";
import { ensureLiveStager } from "../alpha-autoscale/stager-floor.ts";

/**
 * Root of the throne project (three levels up from this file:
 * src/throne-startup/ -> src/ -> throne/), resolved from the
 * module location — NEVER cwd, since the
 * hook may fire from anywhere. Mirrors keep-going.ts.
 */
const THRONE_ROOT = RUNTIME_THRONE_ROOT;

/**
 * Injectable seam over the herdr layer, the heartbeat core, and the throne-root
 * path — defaults to REAL_DEPS. Tests supply fakes (including a `throneRoot`
 * that differs from any live pane cwd) to drive every guard branch without
 * shelling out to real herdr/systemd or touching the live court.
 */
export interface ThroneStartupDeps {
  currentPaneId: typeof currentPaneId;
  listAgents: typeof listAgents;
  renameAgent: typeof renameAgent;
  renameTab: typeof renameTab;
  throneRoot: string;
  /** Keeps omp's copy of the throne delivery extension pointing at this
   *  checkout. Injected so tests never touch a real ~/.omp. */
  installOmpExtension: () => Promise<OmpExtensionInstallOutcome>;
  /**
   * The live-items-only queue view, rendered from the SQLite store. Rejects
   * when the store is unreadable.
   */
  renderQueueDigest: () => Promise<string>;
  /**
   * Read the Regent's declared desired-state (running|dismissed) via J's
   * regentstate seam, so the boot digest surfaces the self-heal mode. Fails safe
   * internally (absent/garbage ⇒ running, never throws).
   */
  readDesiredState: typeof readDesiredState;
  writeRegentHarness?: (harness: Harness) => Promise<void>;
  writeRegentRoute?: (route: { harness: Harness; model: string }) => Promise<void>;
  /**
   * Startup reconciliation: resume-or-reap the orphaned agents (registered but
   * dead) against the live roster (objective D2). Given the roster this run
   * already fetched, so it needs no second `listAgents`. Runs ONLY for the
   * confirmed Regent (see `run`). OPTIONAL: absent ⇒ reconciliation is skipped
   * (the pre-D2 behaviour, and what guard-only tests want); REAL_DEPS wires the
   * real reconciler. Its own failures are swallowed — see `reconcileSafely`.
   */
  reconcile?: (liveAgents: HerdrAgent[]) => Promise<unknown>;
  /** Shared Stager-floor effect. Runs only for the confirmed Regent. */
  ensureStagerFloor?: () => Promise<unknown>;
}

export const REAL_DEPS: ThroneStartupDeps = {
  currentPaneId,
  listAgents,
  renameAgent,
  renameTab,
  throneRoot: THRONE_ROOT,
  installOmpExtension: () =>
    installOmpDeliveryExtension({
      source: path.join(
        THRONE_ROOT,
        "extensions",
        "omp",
        INSTALLED_EXTENSION_NAME,
      ),
    }),
  renderQueueDigest: async () => {
    const store = openRegentQueueStore();
    try {
      return renderRegentQueueAsMarkdown(store.readAll(), {
        statuses: LIVE_QUEUE_ITEM_STATUSES,
      });
    } finally {
      store.close();
    }
  },
  readDesiredState,
  writeRegentHarness,
  writeRegentRoute,
  reconcile: async () => [],
  ensureStagerFloor: ensureLiveStager,
};

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function recordRegentHarnessSafely(
  own: HerdrAgent,
  deps: ThroneStartupDeps,
): Promise<void> {
  if (
    deps.writeRegentHarness === undefined ||
    (own.agent !== HARNESS_NAMES.CLAUDE && own.agent !== HARNESS_NAMES.CODEX)
  ) {
    return;
  }
  try {
    await deps.writeRegentHarness(own.agent);
  } catch (err) {
    process.stderr.write(
      `throne-startup: could not record Regent harness (${errText(err)}); continuing\n`,
    );
  }
}

async function recordRegentRouteSafely(
  own: HerdrAgent,
  deps: ThroneStartupDeps,
): Promise<void> {
  const model = own.model?.trim();
  if (
    model === undefined ||
    deps.writeRegentRoute === undefined ||
    (own.agent !== HARNESS_NAMES.CLAUDE && own.agent !== HARNESS_NAMES.CODEX)
  ) {
    return;
  }
  try {
    await deps.writeRegentRoute({ harness: own.agent, model });
  } catch (err) {
    process.stderr.write(
      `throne-startup: could not record Regent route (${errText(err)}); continuing\n`,
    );
  }
}

/**
 * Decide + apply the self-rename for a confirmed throne-root pane, and report
 * whether this harness IS the Regent (so the caller can also claim its tab).
 * Renames to `Regent` ONLY when the pane is unnamed AND no agent already holds
 * the `Regent` name (`!own.name` covers both an absent field and an empty
 * string; the second clause prevents a duplicate Regent and makes re-runs
 * idempotent — once renamed, `own.name` is `Regent`). Returns `true` iff this
 * harness is (or just became) the Regent: an already-`Regent` pane (self-heal),
 * or a successful fresh rename. Returns `false` for a pane named something else,
 * a skip because another Regent exists, or a rename that failed. Any skip logs
 * its specific reason; a rename that itself fails is caught and logged, never
 * aborting.
 */
async function maybeRenameSelf(
  own: HerdrAgent,
  agents: HerdrAgent[],
  deps: ThroneStartupDeps,
): Promise<boolean> {
  if (own.name) {
    process.stdout.write(
      `throne-startup: harness already named "${own.name}"; skipping self-rename\n`,
    );
    return sameAgentName(own.name, REGENT_NAME);
  }
  if (agents.some((agent) => sameAgentName(agent.name, REGENT_NAME))) {
    process.stdout.write(
      `throne-startup: a "${REGENT_NAME}" already exists; skipping self-rename\n`,
    );
    return false;
  }
  try {
    await deps.renameAgent(own.paneId, REGENT_NAME);
    process.stdout.write(`throne-startup: renamed self to "${REGENT_NAME}"\n`);
    return true;
  } catch (err) {
    process.stderr.write(
      `throne-startup: self-rename to "${REGENT_NAME}" failed (${errText(err)}); continuing\n`,
    );
    return false;
  }
}

/**
 * The Regent's herdr TAB label is deliberately lowercase while the agent
 * identity remains `Regent`; identity comparisons are case-insensitive.
 */
const REGENT_TAB_LABEL = "regent";

/**
 * Claim the Regent's herdr TAB by relabelling it `regent`, so the tab reflects
 * the Regent durably on every launch — the agent rename alone leaves the tab
 * showing whatever label it launched with, which does NOT survive a restart.
 * Idempotent (relabelling to the same label is harmless), so it also self-heals
 * an already-`regent`-tabbed harness whose tab is stale. Best-effort and non-fatal: a
 * missing tab id or a failing rename is logged and never aborts startup.
 */
async function ensureRegentTab(
  own: HerdrAgent,
  deps: ThroneStartupDeps,
): Promise<void> {
  if (!own.tabId) {
    process.stdout.write(
      `throne-startup: own agent record has no tab id; cannot claim the "${REGENT_TAB_LABEL}" tab\n`,
    );
    return;
  }
  try {
    await deps.renameTab(own.tabId, REGENT_TAB_LABEL);
    process.stdout.write(
      `throne-startup: ensured tab "${own.tabId}" is labelled "${REGENT_TAB_LABEL}"\n`,
    );
  } catch (err) {
    process.stderr.write(
      `throne-startup: tab rename to "${REGENT_TAB_LABEL}" failed (${errText(err)}); continuing\n`,
    );
  }
}

/**
 * Read + print the live-items-only QUEUE digest to stdout, so a booting
 * Regent's opening context already contains the queue. On any failure (the
 * store is absent or unreadable — e.g. in a fresh worktree) it prints a
 * single fallback line and returns. Surfacing the queue must never abort a
 * launch, so every path here is non-fatal.
 */
async function printQueueDigest(deps: ThroneStartupDeps): Promise<void> {
  try {
    const digest = await deps.renderQueueDigest();
    process.stdout.write(`throne-startup: QUEUE digest\n\n${digest}`);
  } catch (err) {
    process.stdout.write(
      `throne-startup: regent queue store unreadable; continuing (${errText(err)})\n`,
    );
  }
}

/**
 * Surface the Regent's declared desired-state (running|dismissed) in the boot
 * digest, so a booting Regent's opening context shows whether the court is meant
 * to self-heal or has been stood down — the mode is never hidden. Reads via J's
 * regentstate seam (never a hand-rolled marker parse). `readDesiredState` fails
 * safe internally, but this is still wrapped so nothing here can abort a launch.
 */
async function printDesiredState(deps: ThroneStartupDeps): Promise<void> {
  try {
    const state = await deps.readDesiredState();
    process.stdout.write(
      `throne-startup: Regent desired-state: ${describeDesiredState(state)}\n`,
    );
  } catch (err) {
    process.stdout.write(
      `throne-startup: could not read Regent desired-state; continuing (${errText(err)})\n`,
    );
  }
}

/**
 * Run startup reconciliation (resume-or-reap the orphaned agents), swallowing
 * any throw. This is gated to the confirmed Regent by the caller — an ordinary
 * Alpha booting in the throne root must NEVER reconcile (i.e. reap/resume) its
 * siblings. A failure here (a bad registry read, a spawn error) must never abort
 * the Regent's launch, so it is caught and logged. When no reconciler is wired
 * (guard-only tests that predate D2), it is silently skipped.
 */
async function reconcileSafely(
  deps: ThroneStartupDeps,
  agents: HerdrAgent[],
): Promise<void> {
  if (!deps.reconcile) {
    return;
  }
  try {
    await deps.reconcile(agents);
  } catch (err) {
    process.stderr.write(
      `throne-startup: startup reconciliation threw (${errText(err)}); continuing\n`,
    );
  }
}

async function ensureStagerFloorSafely(deps: ThroneStartupDeps): Promise<void> {
  if (!deps.ensureStagerFloor) return;
  try {
    await deps.ensureStagerFloor();
  } catch (err) {
    process.stderr.write(
      `throne-startup: Stager-floor reconciliation threw (${errText(err)}); continuing\n`,
    );
  }
}

/**
 * Idempotent SessionStart self-configuration. See the file header for the guard
 * contract. Always resolves to 0 — a wrong branch here would mis-rename a live
 * agent or disrupt a launch, so every path is guarded and non-fatal.
 */
export async function run(
  _args: string[],
  deps: ThroneStartupDeps = REAL_DEPS,
): Promise<number> {
  // Step 0 — keep the omp delivery extension current, before anything that
  // might send a message. It is a symlink into this checkout, so this is
  // normally a no-op that confirms the link still points here; it matters on
  // a fresh clone, after a checkout move, and on a host where omp was
  // installed but never run. Never fatal: a throne that cannot install an
  // extension still has a court to bring up.
  try {
    const outcome = await deps.installOmpExtension();
    process.stderr.write(`throne-startup: ${describeOmpExtensionInstall(outcome)}\n`);
  } catch (err) {
    process.stderr.write(
      `throne-startup: omp delivery extension install failed (${errText(err)}); continuing\n`,
    );
  }

  // Step 1 — resolve our own pane. Not being inside herdr is not the throne
  // top-level harness's failure mode, but there is nothing left to rename or
  // arm from outside a session, so this is a full no-op.
  let ownPaneId: string;
  try {
    ownPaneId = await deps.currentPaneId();
  } catch (err) {
    process.stderr.write(
      `throne-startup: not inside a herdr session (${errText(err)}); skipping self-rename\n`,
    );
    return 0;
  }

  // Step 2 — enumerate agents and locate our own record. If enumeration fails
  // we cannot confirm this is the throne root, so we take the same conservative
  // FULL no-op as a failed cwd guard: no rename.
  let agents: HerdrAgent[];
  try {
    agents = await deps.listAgents();
  } catch (err) {
    process.stderr.write(
      `throne-startup: could not list herdr agents (${errText(err)}); ` +
        "cannot confirm throne session — full no-op\n",
    );
    return 0;
  }
  const own = agents.find((a) => a.paneId === ownPaneId);

  // Step 3, cwd GUARD. Own pane absent from the roster, or its cwd is some
  // OTHER project, means this is not the throne top-level harness. A
  // broad/global hook can fire for unrelated sessions, so do a FULL no-op.
  if (own === undefined) {
    process.stdout.write(
      `throne-startup: own pane "${ownPaneId}" not in the herdr roster; not the throne harness — full no-op\n`,
    );
    return 0;
  }
  if (!pathsResolveEqual(own.cwd, deps.throneRoot)) {
    process.stdout.write(
      `throne-startup: session cwd "${own.cwd}" is not the throne root "${deps.throneRoot}"; ` +
        "throne-startup is skipping its own reconciliation; this does not restrict the agent's assignment.\n",
    );
    return 0;
  }

  // Confirmed throne top-level harness. Steps 4 (rename agent), 4b (claim the
  // Regent tab, only when this harness IS the Regent), 4c (surface the Regent's
  // desired-state so the self-heal mode is never hidden), 4d (surface the QUEUE
  // digest so a booting Regent's opening context holds the backlog), and 5
  // (startup reconciliation, Regent-only) run from here; no rename DECISION
  // gates 4c/4d. Both banners print for ANY confirmed throne-root pane, never
  // for a no-op session.
  const isRegent = await maybeRenameSelf(own, agents, deps);
  if (isRegent) {
    await ensureRegentTab(own, deps);
    await recordRegentHarnessSafely(own, deps);
    await recordRegentRouteSafely(own, deps);
  }
  await printDesiredState(deps);
  await printQueueDigest(deps);
  // Step 5 — reconcile orphaned agents, but ONLY when this harness IS the
  // Regent. A create-agent-spawned Alpha also boots with cwd == throne root and
  // reaches this branch; gating on `isRegent` is what stops it from reaping or
  // resuming its sibling agents.
  if (isRegent) {
    await reconcileSafely(deps, agents);
    await ensureStagerFloorSafely(deps);
  }
  return 0;
}
