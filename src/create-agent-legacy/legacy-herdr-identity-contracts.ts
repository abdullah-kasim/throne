export interface HerdrAgent {
  agent: string;
  model?: string;
  name?: string;
  tabLabel?: string;
  agentStatus: "unknown" | "idle" | "working" | "blocked" | "done";
  cwd: string;
  focused: boolean;
  paneId: string;
  tabId: string;
  terminalId: string;
}

export class AgentResolutionError extends Error {
  readonly name = "AgentResolutionError";
  readonly requestedName: string;
  readonly matchCount: number;
  constructor(requestedName: string, matchCount: number) {
    super(
      matchCount === 0
        ? `no herdr agent named "${requestedName}" — it may have gone COMPLETE/DEAD ` +
            "or never existed; if you expected it to be live (e.g. reporting DONE to a " +
            "supervisor), escalate to the Regent instead of retrying this name."
        : `${matchCount} herdr agents match "${requestedName}" — name is ambiguous`,
    );
    this.requestedName = requestedName;
    this.matchCount = matchCount;
  }
}

export function sameAgentName(
  left: string | undefined,
  right: string | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.toLowerCase() === right.toLowerCase()
  );
}
