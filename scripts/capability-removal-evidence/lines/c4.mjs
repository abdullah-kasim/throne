import { legacySpecsPass } from "./legacy.mjs";
import { COMMITTED_DEFAULT_CONFIG, compareWithBefore, liveUserConfigPath } from "../support.mjs";

const CHECK_CONFIG = "check-config";
const LISTING_COMMANDS = ["list-harnesses-and-models", CHECK_CONFIG];
const EXIT_CODE_FOLLOWS_NTFY_HEALTH = "<follows the ntfy health check>";

async function keptHelpersAnswerAsBefore(workspace, options) {
  const answers = await workspace.probe("kept-helpers.ts");
  return compareWithBefore("C4.1", answers, workspace, options);
}

async function listingsPrintAsBefore(workspace, options) {
  const configurations = [
    { name: "committed default", source: COMMITTED_DEFAULT_CONFIG },
    { name: "live config.user.ts (read-only copy)", source: await liveUserConfigPath() },
  ];
  const answers = [];
  for (const configuration of configurations) {
    await workspace.useConfig(configuration.source);
    const printed = await Promise.all(LISTING_COMMANDS.map((command) => workspace.throneCli([command])));
    LISTING_COMMANDS.forEach((command, index) => {
      const result = printed[index];
      answers.push({ configuration: configuration.name, command, ...result, code: command === CHECK_CONFIG ? EXIT_CODE_FOLLOWS_NTFY_HEALTH : result.code });
    });
  }
  return compareWithBefore("C4.2", answers, workspace, options);
}

export const lines = [
  { id: "C4.1", run: keptHelpersAnswerAsBefore, restsOn: ["src/harness-routing/policy/model-effort-and-equivalents.ts", "src/harness-routing/model-registry.ts", "scripts/capability-removal-evidence/kept-helpers.ts"] },
  { id: "C4.2", run: listingsPrintAsBefore, restsOn: ["src/shared-policy/harness-registry.service.ts", "config.user.example.ts", "<main checkout>/config.user.ts"] },
  { id: "C4.3", run: legacySpecsPass, restsOn: ["src/create-agent-legacy/", "test/"] },
];
