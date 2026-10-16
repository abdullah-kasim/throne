import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import { REGENT_TAB_LABEL } from "../regent-state/regent-liveness.ts";
import {
  correctionsFor,
  desiredAgentSettings,
  harnessCommandFor,
} from "./agent-settings-decision.ts";
import {
  DEFAULT_AGENT_SETTINGS_CONFIG,
  loadAgentSettingsConfig,
} from "./agent-settings-user-config.ts";
import {
  AGENT_ROLES,
  AGENT_ROLE_NAMES,
  AGENT_SETTING_CORRECTION_KINDS,
  type ActualAgentSettings,
  type AgentColourByRole,
  type DesiredAgentSettings,
  type RecordedAgent,
} from "./agent-settings.types.ts";

const DEFAULT_COLOURS = DEFAULT_AGENT_SETTINGS_CONFIG.colourByRole;

function recordedAgent(overrides: Partial<RecordedAgent> = {}): RecordedAgent {
  return {
    agentName: "shadow-tidy-01",
    role: AGENT_ROLES.SHADOW,
    tabName: "shadow-tidy-01",
    harness: HARNESS_NAMES.CLAUDE,
    ...overrides,
  };
}

function desiredFor(
  overrides: Partial<RecordedAgent> = {},
  colourByRole: AgentColourByRole = DEFAULT_COLOURS,
): DesiredAgentSettings {
  const desired = desiredAgentSettings(recordedAgent(overrides), colourByRole);
  assert.ok(desired);
  return desired;
}

function actualShowing(
  overrides: Partial<ActualAgentSettings> = {},
): ActualAgentSettings {
  return {
    alive: true,
    colour: "purple",
    sessionName: "shadow-tidy-01",
    ...overrides,
  };
}

function emptyConfigDirectory(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agent-settings-config-"));
}

async function configFileContaining(source: string): Promise<string> {
  const directory = await emptyConfigDirectory();
  const configPath = path.join(directory, "config.user.ts");
  await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
  await writeFile(configPath, source);
  return configPath;
}

test("every kind of agent has exactly one colour", () => {
  const coloursByRole = AGENT_ROLE_NAMES.map((role) => [
    role,
    desiredFor({ role }).colour,
  ]);
  assert.deepEqual(coloursByRole, [
    ["Regent", "red"],
    ["Stager", "green"],
    ["Alpha", "blue"],
    ["Shadow", "purple"],
  ]);
  assert.equal(
    desiredAgentSettings(recordedAgent({ role: "Visitor" }), DEFAULT_COLOURS),
    undefined,
  );
  assert.equal(
    desiredAgentSettings(recordedAgent({ role: undefined }), DEFAULT_COLOURS),
    undefined,
  );
});

test("the Regent should always be red", () => {
  assert.equal(
    desiredFor({ agentName: "Regent", role: "Regent" }).colour,
    "red",
  );
  assert.equal(
    desiredFor({ agentName: "Regent", role: "regent" }).colour,
    "red",
  );
});

test("a Claude Code session should carry the same name as its herdr tab", () => {
  const desired = desiredFor({
    agentName: "alpha-tidy-01",
    role: "alpha",
    tabName: "alpha-tidy-01-as-its-tab-spells-it",
  });
  assert.deepEqual(desired, {
    agentName: "alpha-tidy-01",
    role: AGENT_ROLES.ALPHA,
    tabName: "alpha-tidy-01-as-its-tab-spells-it",
    harness: HARNESS_NAMES.CLAUDE,
    colour: "blue",
    sessionName: "alpha-tidy-01-as-its-tab-spells-it",
  });
});

test("the Regent's session is named after the Regent's tab", () => {
  const desired = desiredFor({
    agentName: "Regent",
    role: AGENT_ROLES.REGENT,
    tabName: "Regent",
  });
  assert.equal(desired.tabName, REGENT_TAB_LABEL);
  assert.equal(desired.sessionName, REGENT_TAB_LABEL);
});

test("an agent whose colour and name are already right gets no corrections", () => {
  assert.deepEqual(correctionsFor(desiredFor(), actualShowing()), []);
});

test("an agent showing the wrong colour is told to set the right colour", () => {
  assert.deepEqual(
    correctionsFor(desiredFor(), actualShowing({ colour: "red" })),
    [{ kind: AGENT_SETTING_CORRECTION_KINDS.SET_COLOUR, name: "purple" }],
  );
  assert.deepEqual(
    correctionsFor(desiredFor(), actualShowing({ colour: undefined })),
    [{ kind: AGENT_SETTING_CORRECTION_KINDS.SET_COLOUR, name: "purple" }],
  );
});

test("an agent whose session name is unknown is told to take its tab's name", () => {
  assert.deepEqual(
    correctionsFor(desiredFor(), actualShowing({ sessionName: undefined })),
    [
      {
        kind: AGENT_SETTING_CORRECTION_KINDS.SET_SESSION_NAME,
        name: "shadow-tidy-01",
      },
    ],
  );
  assert.deepEqual(
    correctionsFor(desiredFor(), actualShowing({ sessionName: "old-name" })),
    [
      {
        kind: AGENT_SETTING_CORRECTION_KINDS.SET_SESSION_NAME,
        name: "shadow-tidy-01",
      },
    ],
  );
});

test("an agent whose harness is not Claude Code gets no corrections", () => {
  const everythingWrong = actualShowing({
    colour: undefined,
    sessionName: undefined,
  });
  for (const harness of [HARNESS_NAMES.CODEX, HARNESS_NAMES.OPENCODE]) {
    assert.deepEqual(
      correctionsFor(desiredFor({ harness }), everythingWrong),
      [],
    );
  }
  assert.equal(correctionsFor(desiredFor(), everythingWrong).length, 2);
});

test("a dead agent gets no corrections", () => {
  assert.deepEqual(
    correctionsFor(
      desiredFor(),
      actualShowing({ alive: false, colour: undefined, sessionName: undefined }),
    ),
    [],
  );
});

test("a role with no colour in the table gets no colour correction", () => {
  const desired = desiredFor({}, { [AGENT_ROLES.REGENT]: "red" });
  assert.equal(desired.colour, undefined);
  assert.deepEqual(
    correctionsFor(
      desired,
      actualShowing({ colour: "red", sessionName: undefined }),
    ),
    [
      {
        kind: AGENT_SETTING_CORRECTION_KINDS.SET_SESSION_NAME,
        name: "shadow-tidy-01",
      },
    ],
  );
});

test("a colour correction is the harness command /color with the colour name", () => {
  const [correction] = correctionsFor(
    desiredFor(),
    actualShowing({ colour: "red" }),
  );
  assert.ok(correction);
  assert.equal(harnessCommandFor(correction), "/color purple");
});

test("a name correction is the harness command /rename with the tab name", () => {
  const [correction] = correctionsFor(
    desiredFor(),
    actualShowing({ sessionName: undefined }),
  );
  assert.ok(correction);
  assert.equal(harnessCommandFor(correction), "/rename shadow-tidy-01");
});

test("a user can override one role's colour in the user config", async () => {
  const config = await loadAgentSettingsConfig(
    await configFileContaining(
      "export default { agentSettings: { colourByRole: { Shadow: 'cyan' } } };",
    ),
  );
  assert.deepEqual(config.colourByRole, {
    Regent: "red",
    Stager: "green",
    Alpha: "blue",
    Shadow: "cyan",
  });
  assert.equal(desiredFor({}, config.colourByRole).colour, "cyan");
});

test("a user config that names an unknown role for a colour is refused", async () => {
  await assert.rejects(
    loadAgentSettingsConfig(
      await configFileContaining(
        "export default { agentSettings: { colourByRole: { Visitor: 'cyan' } } };",
      ),
    ),
    /`colourByRole.Visitor` is not a known role \(expected one of: Regent, Stager, Alpha, Shadow\)/,
  );
  for (const colourThatIsNotOneWord of ["''", "'light blue'", "7"]) {
    await assert.rejects(
      loadAgentSettingsConfig(
        await configFileContaining(
          `export default { agentSettings: { colourByRole: { Shadow: ${colourThatIsNotOneWord} } } };`,
        ),
      ),
      /`colourByRole.Shadow` must be a colour name of one word/,
    );
  }
  await assert.rejects(
    loadAgentSettingsConfig(
      await configFileContaining(
        "export default { agentSettings: { colours: { Shadow: 'cyan' } } };",
      ),
    ),
    /`agentSettings.colours` is not a known field/,
  );
});

test("the agent settings check is on unless the config turns it off", async () => {
  const absentConfigPath = path.join(
    await emptyConfigDirectory(),
    "config.user.ts",
  );
  assert.equal((await loadAgentSettingsConfig(absentConfigPath)).checkEnabled, true);
  assert.equal(
    (
      await loadAgentSettingsConfig(
        await configFileContaining("export default { steering: {} };"),
      )
    ).checkEnabled,
    true,
  );
  const switchedOff = await loadAgentSettingsConfig(
    await configFileContaining(
      "export default { agentSettings: { checkEnabled: false } };",
    ),
  );
  assert.equal(switchedOff.checkEnabled, false);
  assert.deepEqual(switchedOff.colourByRole, DEFAULT_COLOURS);
  await assert.rejects(
    loadAgentSettingsConfig(
      await configFileContaining(
        "export default { agentSettings: { checkEnabled: 'no' } };",
      ),
    ),
    /`checkEnabled` must be a boolean/,
  );
});
