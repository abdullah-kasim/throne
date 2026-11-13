import type { AgentStatusesRosterEntry } from "../agent-statuses/agent-statuses.types.ts";
import {
  appendBlockedPageLedgerEntry,
  DEFAULT_BLOCKED_PAGE_LEDGER_PATH,
  readBlockedPageLedger,
  type BlockedPageLedgerEntry,
} from "../blocked-paging/blocked-agent-escalation-ledger.ts";
import { recordClaimSeen } from "../supervisor-wait/claim-seen.ts";
import { THRONE_DATA_DIR } from "../shared-policy/throne-home.ts";
import {
  readSupervisorWait,
  SUPERVISOR_WAIT_STEPS,
  type SupervisorWaitStep,
} from "../supervisor-wait/read-supervisor-wait.ts";

export const SUPERVISOR_WAIT_GRACE_MS = 10 * 60 * 1000;
export const SUPERVISOR_WAIT_PAGE_WINDOW_MS = 30 * 60 * 1000;
export const ALPHA_PAGES_BEFORE_REGENT = 2;

const ALPHA_STATUSES_THAT_CANNOT_ACT_ON_THEIR_OWN = new Set(["idle", "done", "blocked"]);

export interface SupervisorWaitPage {
  readonly recipient: string;
  readonly shadow: string;
  readonly step: SupervisorWaitStep;
  readonly text: string;
  readonly key: string;
}

export interface SupervisorWaitMonitorInputs {
  readonly roster: readonly AgentStatusesRosterEntry[];
  readonly now: Date;
  readonly regentName: string;
  readonly page: (page: SupervisorWaitPage) => Promise<void>;
  readonly dataDir?: string;
  readonly ledgerPath?: string;
}

interface Stall {
  readonly shadow: string;
  readonly alpha: string;
  readonly step: SupervisorWaitStep;
  readonly since: Date;
}

export function alphaActionFor(step: SupervisorWaitStep, shadow: string): string | undefined {
  switch (step) {
    case SUPERVISOR_WAIT_STEPS.DONE_AWAITING_ACCEPTANCE:
      return `merge or accept ${shadow}`;
    case SUPERVISOR_WAIT_STEPS.ACCEPTED_AWAITING_GO_AHEAD:
      return `send ${shadow} its go-ahead (accept-slice / resend "you may publish your reapability claim")`;
    case SUPERVISOR_WAIT_STEPS.CLAIMED_AWAITING_REAP:
      return `reap ${shadow} (throne reap-agent ${shadow} --reason completed)`;
    default:
      return undefined;
  }
}

export async function pageSupervisorWaitStalls(
  inputs: SupervisorWaitMonitorInputs,
): Promise<SupervisorWaitPage[]> {
  const ledgerPath = inputs.ledgerPath ?? DEFAULT_BLOCKED_PAGE_LEDGER_PATH;
  const ledger = await readBlockedPageLedger(ledgerPath);
  const window = Math.floor(inputs.now.getTime() / SUPERVISOR_WAIT_PAGE_WINDOW_MS);
  const sent: SupervisorWaitPage[] = [];
  for (const stall of await findStalls(inputs)) {
    for (const page of pagesFor(stall, ledger, window, inputs.regentName)) {
      await inputs.page(page);
      await appendBlockedPageLedgerEntry(
        {
          agentName: ledgerSubject(stall.shadow),
          observedAt: inputs.now.toISOString(),
          kind: "page-enqueued",
          pageKey: page.key,
        },
        ledgerPath,
      );
      sent.push(page);
    }
  }
  return sent;
}

async function findStalls(inputs: SupervisorWaitMonitorInputs): Promise<Stall[]> {
  const dataDir = inputs.dataDir ?? THRONE_DATA_DIR;
  const liveAlphas = new Map(
    inputs.roster
      .filter((entry) => entry.role === "Alpha" && entry.lifecycle === "live")
      .map((entry) => [entry.name, entry] as const),
  );
  const stalls: Stall[] = [];
  for (const entry of inputs.roster) {
    if (entry.role !== "Shadow" || entry.lifecycle !== "live") continue;
    const wait = await readSupervisorWait({ agentName: entry.name, dataDir });
    if (!wait.waiting) continue;
    const alpha = liveAlphas.get(wait.supervisor);
    if (alpha === undefined) continue;
    if (
      wait.step === SUPERVISOR_WAIT_STEPS.DONE_AWAITING_ACCEPTANCE &&
      !ALPHA_STATUSES_THAT_CANNOT_ACT_ON_THEIR_OWN.has(alpha.liveStatus ?? "")
    ) {
      continue;
    }
    const since =
      wait.step === SUPERVISOR_WAIT_STEPS.CLAIMED_AWAITING_REAP
        ? await recordClaimSeen(entry.name, dataDir, inputs.now)
        : wait.since;
    if (inputs.now.getTime() - since.getTime() < SUPERVISOR_WAIT_GRACE_MS) continue;
    stalls.push({ shadow: entry.name, alpha: alpha.name, step: wait.step, since });
  }
  return stalls;
}

function pagesFor(
  stall: Stall,
  ledger: readonly BlockedPageLedgerEntry[],
  window: number,
  regentName: string,
): SupervisorWaitPage[] {
  const action = alphaActionFor(stall.step, stall.shadow);
  if (action === undefined) return [];
  const stallKey = `supervisor-wait:${stall.shadow}:${stall.step}:${stall.since.toISOString()}`;
  const alphaKey = `${stallKey}:alpha:${window}`;
  const regentKey = `${stallKey}:regent`;
  const credits = new Set(
    ledger
      .filter((entry) => entry.agentName === ledgerSubject(stall.shadow) && entry.kind === "page-enqueued")
      .map((entry) => entry.pageKey ?? ""),
  );
  if (credits.has(alphaKey)) return [];
  const pages: SupervisorWaitPage[] = [
    {
      recipient: stall.alpha,
      shadow: stall.shadow,
      step: stall.step,
      key: alphaKey,
      text:
        `${stall.shadow} has waited on you since ${stall.since.toISOString()} (${stall.step}). ` +
        `Action: ${action}.`,
    },
  ];
  const earlierAlphaPages = [...credits].filter((key) => key.startsWith(`${stallKey}:alpha:`)).length;
  if (earlierAlphaPages >= ALPHA_PAGES_BEFORE_REGENT && !credits.has(regentKey)) {
    pages.push({
      recipient: regentName,
      shadow: stall.shadow,
      step: stall.step,
      key: regentKey,
      text:
        `${stall.alpha} has been paged ${earlierAlphaPages} times and has not acted: ` +
        `${stall.shadow} has waited since ${stall.since.toISOString()} (${stall.step}). ` +
        `${stall.alpha} needs to ${action}.`,
    });
  }
  return pages;
}

function ledgerSubject(shadow: string): string {
  return `supervisor-wait/${shadow}`;
}
