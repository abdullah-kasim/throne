export interface StartOptions {
  cwd?: string;
  argv: string[];
  /** The exact label to hand to `herdr agent rename` for a NEW spawn's tab.
   *  Defaults to the canonical agent name when absent — resumes and any
   *  caller that doesn't compute a persona label keep today's behaviour. */
  tabLabel?: string;
}
export type StartEvidencePhase =
  | "tab-created"
  | "pane-output-observed"
  | "sentinel-executed"
  | "agent-start-accepted";
export interface ShellReadyEvidence {
  paneId: string;
  phase: StartEvidencePhase;
  sentinel: string;
  sentinelExecuted: boolean;
  outputBytes: number;
  probeWrites: number;
  observations: number;
  elapsedMs: number;
}
export interface AgentStartEvidence {
  phase: StartEvidencePhase;
  tabId: string;
  rootPaneId: string;
  agentPaneId?: string;
  startAttempts: number;
  shell: ShellReadyEvidence;
}
export interface StartCallerContext {
  callerCwd: string;
  herdrSession: string | null;
  herdrDecouple: boolean;
  focusedPane?: { paneId: string; tabId?: string };
  env: Record<string, string>;
}
export interface StartCallerContextDeps {
  runHerdr: typeof import("./herdr-client.ts").runHerdr;
  cwd: () => string;
  env: Record<string, string | undefined>;
  runtimeMode: import("./herdr-client.ts").HerdrRuntimeMode;
}
export interface StartInTabDeps {
  runHerdr: typeof import('./herdr-client.ts').runHerdr;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}
export interface StartFailureAnnotation {
  phase: StartEvidencePhase;
  ownership: "determinate" | "indeterminate";
  tabId: string;
  rootPaneId: string;
  startAttempts: number;
  context: StartCallerContext;
}
export interface RestoredTabSnapshot {
  panes: import("./herdr-inventory.service.ts").HerdrPane[];
  owners: import("./herdr-inventory.service.ts").HerdrNameOwner[];
  liveHarnessPaneIds: Set<string>;
  processInfos: import("./herdr-inventory.service.ts").HerdrPaneProcessInfo[];
}
export type RestoredOwnerSnapshotState =
  | {
      kind: "already-live";
      result: Extract<
        ResumeRegisteredAgentInRestoredTabResult,
        { kind: "already-live" }
      >;
    }
  | { kind: "unowned" }
  | {
      kind: "unowned-live";
      pane: import("./herdr-inventory.service.ts").HerdrPane;
    }
  | {
      kind: "owner-shell-only";
      owner: import("./herdr-inventory.service.ts").HerdrNameOwner;
    }
  | {
      kind: "owner-unavailable";
      owner: import("./herdr-inventory.service.ts").HerdrNameOwner;
    };
export type RestoredOwnerRecheckResult =
  | {
      kind: "already-live";
      result: Extract<
        ResumeRegisteredAgentInRestoredTabResult,
        { kind: "already-live" }
      >;
    }
  | {
      kind: "ready-for-takeover";
      snapshot: RestoredTabSnapshot;
      owner?: import("./herdr-inventory.service.ts").HerdrNameOwner;
    };
export interface ResumeRegisteredAgentInRestoredTabDeps {
  listTabs: () => Promise<import("./herdr-inventory.service.ts").HerdrTab[]>;
  listPanes: () => Promise<import("./herdr-inventory.service.ts").HerdrPane[]>;
  listNameOwners: () => Promise<
    import("./herdr-inventory.service.ts").HerdrNameOwner[]
  >;
  getPaneProcessInfo: (
    paneId: string,
  ) => Promise<import("./herdr-inventory.service.ts").HerdrPaneProcessInfo>;
  renameAgent: (target: string, name: string) => Promise<void>;
  startInTab: (
    name: string,
    paneId: string,
    opts: StartOptions,
  ) => Promise<string | undefined>;
  startAgent: (name: string, opts: StartOptions) => Promise<AgentStartEvidence>;
  closePane: (paneId: string) => Promise<void>;
  sleep: (milliseconds: number) => Promise<void>;
}
export type ResumeRegisteredAgentInRestoredTabResult =
  | { kind: "new-tab-launched" }
  | {
      kind: "restored-tab-takeover";
      tabId: string;
      paneId?: string;
      quarantinedOwnerName?: string;
    }
  | { kind: "already-live"; tabId: string; paneId: string };
export type ReconcileIndeterminateAgentStartResult =
  | Extract<ResumeRegisteredAgentInRestoredTabResult, { kind: "already-live" }>
  | { kind: "proven-dead" };
export const RESTORED_TAB_RACE_RECHECK_ATTEMPTS = 20;
export const RESTORED_TAB_RACE_RECHECK_MS = 100;
