import {
  AGENT_LIFECYCLE_STATES,
  type AgentStatusesRosterEntry,
} from "../agent-statuses/agent-statuses.types.ts";
import { isLiveStager } from "../alpha-autoscale/stager-floor.ts";
import { sameAgentName } from "../herdr/herdr-identity-contracts.ts";
import { REGENT_NAME } from "../regent-state/regent-liveness.ts";
import {
  DESIRED_STATES,
  type DesiredState,
} from "../regent-state/regent-state.service.ts";

export const COURT_ROLE_LIVENESS = {
  LIVE: "live",
  MISSING: "missing",
  STAY_DOWN: "stay-down",
  UNKNOWN: "unknown",
} as const;

export type CourtRoleLiveness =
  (typeof COURT_ROLE_LIVENESS)[keyof typeof COURT_ROLE_LIVENESS];

export interface CourtLivenessInput {
  readonly desiredState: DesiredState;
  readonly rosterEntries: readonly AgentStatusesRosterEntry[];
  readonly rosterReadThrew: boolean;
  readonly forkedAgentNames: ReadonlySet<string>;
}

export interface CourtLiveness {
  readonly regent: CourtRoleLiveness;
  readonly stager: CourtRoleLiveness;
}

function isLiveRegent(entry: AgentStatusesRosterEntry): boolean {
  return (
    entry.lifecycle === AGENT_LIFECYCLE_STATES.LIVE &&
    sameAgentName(entry.name, REGENT_NAME)
  );
}

function liveOrMissing(roleIsLive: boolean): CourtRoleLiveness {
  return roleIsLive ? COURT_ROLE_LIVENESS.LIVE : COURT_ROLE_LIVENESS.MISSING;
}

export function decideCourtLiveness(input: CourtLivenessInput): CourtLiveness {
  if (input.desiredState === DESIRED_STATES.DISMISSED) {
    return {
      regent: COURT_ROLE_LIVENESS.STAY_DOWN,
      stager: COURT_ROLE_LIVENESS.STAY_DOWN,
    };
  }
  if (input.rosterReadThrew) {
    return {
      regent: COURT_ROLE_LIVENESS.UNKNOWN,
      stager: COURT_ROLE_LIVENESS.UNKNOWN,
    };
  }
  return {
    regent: liveOrMissing(input.rosterEntries.some(isLiveRegent)),
    stager: liveOrMissing(
      input.rosterEntries.some((entry) =>
        isLiveStager(entry, input.forkedAgentNames),
      ),
    ),
  };
}
