import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildAndPublishDist } from "../../scripts/build-and-publish-dist.mjs";

// Stand-in for the real `nest`/`tsc` compile steps: the object under test is
// `buildAndPublishDist`'s publish/prune/concurrency mechanics, not the
// compilers. Creates the generation directory immediately (so a sibling
// process can observe it mid-build), then waits `artifactDelayMs` before
// writing the exact artifacts `verifyPublishedGenerationComplete` expects.
function populateStagingDirWithDelayedFakeArtifacts(stagingDir, artifactDelayMs) {
  return async () => {
    mkdirSync(path.join(stagingDir, "src"), { recursive: true });
    mkdirSync(path.join(stagingDir, "test", "fixtures"), { recursive: true });
    mkdirSync(path.join(stagingDir, "systemd"), { recursive: true });
    await delay(artifactDelayMs);
    writeFileSync(path.join(stagingDir, "src", "tools.js"), "// fake build output\n");
    writeFileSync(
      path.join(stagingDir, "test", "fixtures", "send-agent-process-mutex-runner.js"),
      "// fake build output\n",
    );
  };
}

const artifactDelayMs = Number(process.argv[2] ?? 0);

await buildAndPublishDist((stagingDir) =>
  populateStagingDirWithDelayedFakeArtifacts(stagingDir, artifactDelayMs)(),
);
