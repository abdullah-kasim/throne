import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const throneCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "throne-cli");
const REMOVED_NAME = "claudeModDelivery";
const REMOVED_KEY = `features.${REMOVED_NAME}`;

async function checkConfig(harness, label, configSource) {
  const configFolder = path.join(harness.dataHome, "config");
  await mkdir(configFolder, { recursive: true });
  await writeFile(path.join(configFolder, "package.json"), '{"type":"module"}\n');
  await writeFile(path.join(configFolder, "config.user.ts"), configSource);
  const rootWithoutCheckoutConfig = path.join(harness.root, "throne-root");
  await mkdir(rootWithoutCheckoutConfig, { recursive: true });
  const environment = { ...harness.environment, THRONE_LIVE_ROOT: rootWithoutCheckoutConfig };
  const result = await run(throneCli, ["check-config"], { env: environment }).then((finished) => ({ ...finished, code: 0 }), (error) => error);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  await harness.saveText(`check-config-${label}`, output);
  return { output, refused: result.code !== 0 };
}

export async function check(harness) {
  const named = await checkConfig(harness, "key-named", `export default { features: { ${REMOVED_NAME}: true } };\n`);
  const absent = await checkConfig(harness, "key-absent", "export default {};\n");
  const namesKey = named.output.includes(REMOVED_KEY);
  const featureLines = absent.output.split("\n").filter((line) => line.startsWith("feature ") && line.includes(REMOVED_NAME));
  const pass = named.refused && namesKey && featureLines.length === 0;
  return {
    verdict: pass ? "PASS" : "FAIL",
    observed: `real throne check-config with a config.user.ts naming ${REMOVED_KEY}: refused ${named.refused}, output names the key ${namesKey}; with the key absent: exit refused ${absent.refused}, feature lines naming it ${featureLines.length}`,
  };
}
