import { configuredRegentLaunch, regentLaunchArgv } from "../../src/regent-state/regent-launch-recipe.ts";

const RECORDED_REGENT_HARNESS = "claude";
const configured = configuredRegentLaunch();
process.stdout.write(JSON.stringify({ configured: configured ?? null, launch_arguments: regentLaunchArgv(configured, undefined, RECORDED_REGENT_HARNESS) }));
