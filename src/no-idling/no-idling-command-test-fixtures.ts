import type { HerdrAgent } from '../herdr/herdr-inventory.service.ts';
import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import type { NoIdlingDependencies } from '../no-idling/no-idling-run.ts';
import {
  IdentityLineReadStatus,
  type IdentityLineRead,
} from '../agentdata/identity-data.service.ts';

/** A fixture-shaped `IdentityLineRead` carrying a found supervisor name. */
export function identityFound(value: string): IdentityLineRead {
  return { status: IdentityLineReadStatus.Found, value };
}

/** A fixture-shaped `IdentityLineRead` for a genuinely fieldless read -- the
 *  pre-existing test-fixture default every caller here used before this
 *  module's read contract distinguished it from an unresolved read. */
export const IDENTITY_FIELD_ABSENT: IdentityLineRead = {
  status: IdentityLineReadStatus.FieldAbsent,
};
import type {
  KeyedSubmissionOutcome,
  KeyedSubmissionWindowPayload,
  KeyedSubmissionWindowStore,
} from '../herdr/keyed-submission-token.ts';
import type { SubmitToAgentDeps } from '../herdr/herdr-send.types.ts';

export interface SubmitCall {
  readonly target: HerdrAgent;
  readonly sender: string;
  readonly prompt: string;
  readonly options?: { readonly key?: string };
}

export function fakeAgent(name: string, status: 'idle' | 'working'): HerdrAgent {
  return {
    agent: 'claude',
    name,
    agentStatus: status,
    cwd: `/throne/${name}`,
    focused: false,
    paneId: `pane-${name}`,
    tabId: `tab-${name}`,
    terminalId: `term-${name}`,
  };
}

export function rosterEntry(
  name: string,
  role: string,
  status: 'idle' | 'working',
): AgentStatusesRosterEntry {
  return {
    name,
    lifecycle: 'live',
    liveStatus: status,
    reportLanded: false,
    role,
    cwd: `/throne/${name}`,
    paneId: `pane-${name}`,
    focused: false,
  };
}

export function liveEntry(
  name: string,
  role: string,
  status: 'idle' | 'working',
): AgentStatusesRosterEntry {
  return rosterEntry(name, role, status);
}

export function deps(overrides: Partial<NoIdlingDependencies> = {}): {
  readonly dependencies: NoIdlingDependencies;
  readonly submitCalls: SubmitCall[];
} {
  const submitCalls: SubmitCall[] = [];
  return {
    submitCalls,
    dependencies: {
      resolveLiveRoot: async () => '/live/throne',
      getRoster: async () => [],
      readAgentSupervisor: async () => IDENTITY_FIELD_ABSENT,
      resolveAgent: async (name) => fakeAgent(name, 'idle'),
      submitToAgent: async (target, sender, prompt, options) => {
        submitCalls.push({ target, sender, prompt, options });
      },
      readAgent: async () => '',
      blockedMarkerLedger: {
        readBlockedMarker: async () => null,
        writeBlockedMarker: async () => {},
        clearBlockedMarker: async () => {},
      },
      readSpawnSpec: async () => null,
      // Default false: existing tests assume no child carries the
      // idle-by-design marker unless a test explicitly exercises the
      // marked-canary path.
      isIdleByDesign: async () => false,
      detectStaleTabs: async () => [],
      detectStrandedSpawns: async () => [],
      // Default no-op success: existing tests never exercise recovery
      // outcomes unless they explicitly override this and pass stranded
      // spawns through `detectStrandedSpawns`.
      recoverStrandedSpawn: async (agentName, classification) => ({
        agentName,
        classification,
        remedy: 'unused',
        outcome: 'redelivered',
      }),
      // Default true: existing tests use fixture `cwd`s that were never
      // meant to be real paths, so a fixed cwd never counts as "missing"
      // unless a test explicitly exercises the deleted-cwd path.
      checkCwdExists: async () => true,
      // Default false: existing tests assume no agent carries durable
      // completion/archival ledger evidence unless a test explicitly
      // exercises the accounted-for path.
      isDurablyAccountedFor: async () => false,
      // Default false: existing tests assume no supervisor needs the ledger
      // fallback unless a test explicitly exercises the SPAWN RACE path.
      isRegisteredAgent: async () => false,
      // Default false: existing tests assume no Alpha has proven delivery
      // (delivery-evidence.json + landed commit) unless a test explicitly
      // exercises the genuine-completion path.
      hasProvenDelivery: async () => false,
      ...overrides,
    },
  };
}

/**
 * A fake in-memory window store mirroring the real file-backed contract used
 * by `src/herdr/keyed-submission-token.ts`: one pending payload per tuple, an
 * exclusive attempt marker deciding ownership.
 */
export function fakeWindowStore(): KeyedSubmissionWindowStore & {
  markOwnerDead(recipient: string, key: string): void;
} {
  interface Window {
    version: number;
    token: string;
    payload: KeyedSubmissionWindowPayload;
    outcome?: KeyedSubmissionOutcome;
  }
  const windows = new Map<string, Window>();
  const attempts = new Map<string, { alive: boolean }>();
  const tupleKey = (recipient: string, key: string) => `${recipient} ${key}`;
  let sequence = 0;

  return {
    async claim(recipient, key, payload, now) {
      const tuple = tupleKey(recipient, key);
      const existing = windows.get(tuple);
      const version = (existing?.version ?? 0) + 1;
      const token = `${now}-${++sequence}`;
      windows.set(tuple, { version, token, payload });
      const hasLiveAttempt = attempts.get(tuple)?.alive === true;
      const owner = !hasLiveAttempt;
      if (owner) attempts.set(tuple, { alive: true });
      return { version, token, owner };
    },
    async reread(recipient, key) {
      return windows.get(tupleKey(recipient, key));
    },
    async attemptIsAbandoned(recipient, key) {
      const attempt = attempts.get(tupleKey(recipient, key));
      return attempt === undefined || !attempt.alive;
    },
    async takeOverAttempt(recipient, key) {
      const tuple = tupleKey(recipient, key);
      const attempt = attempts.get(tuple);
      if (attempt !== undefined && attempt.alive) return false;
      attempts.set(tuple, { alive: true });
      return true;
    },
    async publishOutcome(recipient, key, outcome) {
      const tuple = tupleKey(recipient, key);
      const existing = windows.get(tuple);
      if (existing !== undefined) windows.set(tuple, { ...existing, outcome });
      attempts.delete(tuple);
    },
    markOwnerDead(recipient, key) {
      const attempt = attempts.get(tupleKey(recipient, key));
      if (attempt !== undefined) attempt.alive = false;
    },
  };
}

export function fakeSubmitToAgentDeps(sent: string[]): SubmitToAgentDeps {
  return {
    sendText: async (_pane: string, text: string) => {
      sent.push(text);
    },
    deliverToOmp: async () => ({ kind: "delivered" }) as const,
    pressEnter: async () => {},
    pressPaneKey: async () => {},
    // The fake target's harness ('unknown') never reaches a composer-clearance
    // wait that would need real process info.
    getPaneProcessInfo: async () => undefined as never,
    readVisibleAgentAnsi: async () => '',
    readRecentAgentAnsi: async () => '',
    // A real (short) timer, not a synchronous no-op: a joined waiter's poll
    // loop must actually yield to the event loop so the owner's in-flight
    // publish-then-clear-attempt sequence lands between polls, exactly as it
    // would across real processes on the production ~1s poll interval.
    sleep: (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now: Date.now,
    refreshRecipientIdentity: async (_name: string, initial: HerdrAgent) => initial,
    withRecipientPaneLock: async (_pane: string, action: () => Promise<void>) => action(),
    stagePayload: async () => ({ path: 'unused', byteLength: 0, sha256: '' }),
    keyedSubmissionWindowStore: fakeWindowStore(),
  } as SubmitToAgentDeps;
}
