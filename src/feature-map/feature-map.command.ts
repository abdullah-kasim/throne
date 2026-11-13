import { extname } from "node:path";
import { Command } from "nest-commander";
import { OwnHelpCommandRunner } from "../shared-policy/own-help-command-runner.ts";
import { runFeatureMap } from "./feature-map.ts";

const commandRegistryUrl = new URL(
  `../shared-policy/command-registry${extname(new URL(import.meta.url).pathname)}`,
  import.meta.url,
);

@Command({
  name: "feature-map",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class FeatureMapCommand extends OwnHelpCommandRunner {
  protected exitCodeOf(commandArguments: readonly string[]): Promise<number> {
    return runFeatureMap(commandArguments, {
      throneRegistry: async () => (await import(commandRegistryUrl.href)).publicCommandNames(),
      writeStdout: (text) => process.stdout.write(text),
      writeStderr: (text) => process.stderr.write(text),
    });
  }
}
