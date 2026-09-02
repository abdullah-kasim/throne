import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import { RegentQueueItemStatus } from "../regent-queue/regent-queue-item-state.ts";
import type {
  RegentQueueItemRow,
  RegentQueueStore,
} from "../regent-queue/regent-queue.store.ts";
import type {
  CreateAgentDeps,
  RegistrationResolution,
} from "./create.types.ts";
import { writeModelAllowlist } from "./model-allowlist.ts";

export const SUPERVISOR_NAME = "alpha-brg-model-allowlist";
export const SHADOW_NAME = "shadow-brg-test-01";

export function fakeQueueStoreWithOpenItem(
  objectiveCode: string,
): () => RegentQueueStore {
  const item: RegentQueueItemRow = {
    id: objectiveCode,
    objectiveCode,
    status: RegentQueueItemStatus.Open,
    body: "test fixture queue item",
    prBranch: null,
    agentName: null,
    targetRepo: null,
    baseCommit: null,
    deliveryCommit: null,
    deliveryMirror: {
      verdict: "unknown",
      deliveryCommit: null,
      targetRepo: null,
      targetBranch: null,
      treeIdentity: null,
      checkedAt: null,
      reason: null,
    },
    absorption: null,
    deferral: null,
    priority: 0,
    createdAt: 0,
    updatedAt: 0,
  };
  return () =>
    ({
      insertItem: () => item,
      readItem: (id: string) => (id === item.id ? item : undefined),
      readAll: () => ({ state: "items", items: [item] }),
      transitionStatus: () => item,
      archiveItems: () => ({ operationId: "test", operatedAt: 1, rowCount: 0 }),
      close: () => {},
    }) as unknown as RegentQueueStore;
}

export function baseRequest(
  overrides: Partial<RegistrationResolution> = {},
): RegistrationResolution {
  return {
    flags: { supervisor: SUPERVISOR_NAME, "bypass-usage": true },
    oneShot: false,
    harness: HARNESS_NAMES.CLAUDE,
    model: "sonnet",
    role: "Shadow",
    requestedName: SHADOW_NAME,
    name: SHADOW_NAME,
    requestedCwd: `/tmp/${SHADOW_NAME}`,
    launchHarness: HARNESS_NAMES.CLAUDE,
    launchModel: "sonnet",
    cwd: `/tmp/${SHADOW_NAME}`,
    resuming: false,
    customPassthrough: [],
    ...overrides,
  };
}

export function baseDeps(
  overrides: Partial<CreateAgentDeps> = {},
): CreateAgentDeps {
  return {
    resolveAgent: (() => {}) as unknown as CreateAgentDeps["resolveAgent"],
    startAgent: (() => {}) as unknown as CreateAgentDeps["startAgent"],
    resumeRegisteredAgentInRestoredTab:
      (() => {}) as unknown as CreateAgentDeps["resumeRegisteredAgentInRestoredTab"],
    closeAgentTab: (() => {}) as unknown as CreateAgentDeps["closeAgentTab"],
    ensureCodexTrust:
      (() => {}) as unknown as CreateAgentDeps["ensureCodexTrust"],
    probeCodexTrustPrompt:
      (() => {}) as unknown as CreateAgentDeps["probeCodexTrustPrompt"],
    writeIdentity: (() => {}) as unknown as CreateAgentDeps["writeIdentity"],
    writeOpeningPrompt:
      (() => {}) as unknown as CreateAgentDeps["writeOpeningPrompt"],
    writeSpawnSpec: (() => {}) as unknown as CreateAgentDeps["writeSpawnSpec"],
    writeModelAllowlist,
    readSpawnSpec: (async (name: string) =>
      name === SUPERVISOR_NAME
        ? {
            harness: HARNESS_NAMES.CLAUDE,
            model: "sonnet",
            effort: 1,
            cwd: "/tmp/alpha-brg-model-allowlist",
            objective_code: "brg",
          }
        : null) as unknown as CreateAgentDeps["readSpawnSpec"],
    registrationExists:
      (() => {}) as unknown as CreateAgentDeps["registrationExists"],
    removeRegistration: async () => {},
    getClaudeUsage: (() => {}) as unknown as CreateAgentDeps["getClaudeUsage"],
    getCodexUsage: (async () => ({
      source: "api",
      harness: "codex",
      as_of: "2026-08-10T00:00:00.000Z",
      windows: [
        { cap_window: "weekly", used_pct: 0, remaining_pct: 100 },
        { cap_window: "5h", used_pct: 0, remaining_pct: 100 },
      ],
    })) as unknown as CreateAgentDeps["getCodexUsage"],
    getOpenCodeGoUsage:
      (() => {}) as unknown as CreateAgentDeps["getOpenCodeGoUsage"],
    sleep: async () => {},
    now: () => "2026-08-10T00:00:00.000Z",
    planPresetName: "AnthropicOnly",
    targetEffort: 1,
    readModelAllowlist: async () => undefined,
    openQueueStore: fakeQueueStoreWithOpenItem("brg"),
    readUsageBypassAuthorizations: async () => ({
      version: 1,
      authorizations: [
        {
          authorizer: "Regent",
          objective_code: "brg",
          recipient: SHADOW_NAME,
          evidence_locator: "test-usage-bypass",
          expires_at: "2030-01-01T00:00:00.000Z",
        },
      ],
    }),
    ...overrides,
  };
}
