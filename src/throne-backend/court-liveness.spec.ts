import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_LIFECYCLE_STATES,
  type AgentStatusesRosterEntry,
} from "../agent-statuses/agent-statuses.types.ts";
import { DESIRED_STATES } from "../regent-state/regent-state.service.ts";
import {
  COURT_ROLE_LIVENESS,
  decideCourtLiveness,
  type CourtLiveness,
  type CourtLivenessInput,
} from "./court-liveness.ts";

const liveRegent: AgentStatusesRosterEntry = {
  name: "Regent",
  lifecycle: AGENT_LIFECYCLE_STATES.LIVE,
  reportLanded: false,
  role: "Regent",
  focused: false,
};

const liveStager: AgentStatusesRosterEntry = {
  name: "stager-floor",
  lifecycle: AGENT_LIFECYCLE_STATES.LIVE,
  reportLanded: false,
  role: "Stager",
  focused: false,
};

const deadRegentLedgerEntry: AgentStatusesRosterEntry = {
  ...liveRegent,
  name: "regent",
  lifecycle: AGENT_LIFECYCLE_STATES.DEAD,
};

const deadStagerLedgerEntry: AgentStatusesRosterEntry = {
  ...liveStager,
  name: "stager-ninth",
  lifecycle: AGENT_LIFECYCLE_STATES.DEAD,
};

const forkedStager: AgentStatusesRosterEntry = {
  ...liveStager,
  name: "stager-floor-fork",
};

const nobodyForked: ReadonlySet<string> = new Set();

interface CourtSituation {
  readonly name: string;
  readonly input: CourtLivenessInput;
  readonly expected: CourtLiveness;
}

const courtSituations: readonly CourtSituation[] = [
  {
    name: "a court with a live Regent and a live Stager needs nothing",
    input: {
      desiredState: DESIRED_STATES.RUNNING,
      rosterEntries: [liveRegent, liveStager],
      rosterReadThrew: false,
      forkedAgentNames: nobodyForked,
    },
    expected: {
      regent: COURT_ROLE_LIVENESS.LIVE,
      stager: COURT_ROLE_LIVENESS.LIVE,
    },
  },
  {
    name: "a court with no Regent reports the Regent missing",
    input: {
      desiredState: DESIRED_STATES.RUNNING,
      rosterEntries: [liveStager],
      rosterReadThrew: false,
      forkedAgentNames: nobodyForked,
    },
    expected: {
      regent: COURT_ROLE_LIVENESS.MISSING,
      stager: COURT_ROLE_LIVENESS.LIVE,
    },
  },
  {
    name: "a court with a live Regent and no Stager reports the Stager missing",
    input: {
      desiredState: DESIRED_STATES.RUNNING,
      rosterEntries: [liveRegent],
      rosterReadThrew: false,
      forkedAgentNames: nobodyForked,
    },
    expected: {
      regent: COURT_ROLE_LIVENESS.LIVE,
      stager: COURT_ROLE_LIVENESS.MISSING,
    },
  },
  {
    name: "a court with neither reports both missing",
    input: {
      desiredState: DESIRED_STATES.RUNNING,
      rosterEntries: [],
      rosterReadThrew: false,
      forkedAgentNames: nobodyForked,
    },
    expected: {
      regent: COURT_ROLE_LIVENESS.MISSING,
      stager: COURT_ROLE_LIVENESS.MISSING,
    },
  },
  {
    name: "a dismissed court stays down even when nobody is live",
    input: {
      desiredState: DESIRED_STATES.DISMISSED,
      rosterEntries: [],
      rosterReadThrew: false,
      forkedAgentNames: nobodyForked,
    },
    expected: {
      regent: COURT_ROLE_LIVENESS.STAY_DOWN,
      stager: COURT_ROLE_LIVENESS.STAY_DOWN,
    },
  },
  {
    name: "a dismissed court stays down even when everybody is live",
    input: {
      desiredState: DESIRED_STATES.DISMISSED,
      rosterEntries: [liveRegent, liveStager],
      rosterReadThrew: false,
      forkedAgentNames: nobodyForked,
    },
    expected: {
      regent: COURT_ROLE_LIVENESS.STAY_DOWN,
      stager: COURT_ROLE_LIVENESS.STAY_DOWN,
    },
  },
  {
    name: "a court whose roster could not be read is unknown for both",
    input: {
      desiredState: DESIRED_STATES.RUNNING,
      rosterEntries: [],
      rosterReadThrew: true,
      forkedAgentNames: nobodyForked,
    },
    expected: {
      regent: COURT_ROLE_LIVENESS.UNKNOWN,
      stager: COURT_ROLE_LIVENESS.UNKNOWN,
    },
  },
  {
    name: "a dead Stager ledger entry does not count as a live Stager",
    input: {
      desiredState: DESIRED_STATES.RUNNING,
      rosterEntries: [liveRegent, deadStagerLedgerEntry],
      rosterReadThrew: false,
      forkedAgentNames: nobodyForked,
    },
    expected: {
      regent: COURT_ROLE_LIVENESS.LIVE,
      stager: COURT_ROLE_LIVENESS.MISSING,
    },
  },
  {
    name: "a dead Regent ledger entry does not count as a live Regent",
    input: {
      desiredState: DESIRED_STATES.RUNNING,
      rosterEntries: [deadRegentLedgerEntry, liveStager],
      rosterReadThrew: false,
      forkedAgentNames: nobodyForked,
    },
    expected: {
      regent: COURT_ROLE_LIVENESS.MISSING,
      stager: COURT_ROLE_LIVENESS.LIVE,
    },
  },
  {
    name: "a forked Stager does not count as a live Stager",
    input: {
      desiredState: DESIRED_STATES.RUNNING,
      rosterEntries: [liveRegent, forkedStager],
      rosterReadThrew: false,
      forkedAgentNames: new Set([forkedStager.name]),
    },
    expected: {
      regent: COURT_ROLE_LIVENESS.LIVE,
      stager: COURT_ROLE_LIVENESS.MISSING,
    },
  },
];

for (const situation of courtSituations) {
  test(situation.name, () => {
    assert.deepEqual(decideCourtLiveness(situation.input), situation.expected);
  });
}
