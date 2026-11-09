import { Command } from "nest-commander";
import { OwnHelpCommandRunner } from "../shared-policy/own-help-command-runner.ts";

function loadPreviewRuntime(): Promise<typeof import("./preview-runtime.ts")> {
  return import("./preview-runtime.ts");
}

@Command({
  name: "preview",
  description:
    "Add, remove or list the tailnet previews in config.user.ts. A preview is a tailnet path or port showing a local address or a folder, on the tailnet only and never through funnel.",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class PreviewCommand extends OwnHelpCommandRunner {
  protected async exitCodeOf(commandArguments: readonly string[]): Promise<number> {
    const { runPreview } = await loadPreviewRuntime();
    return runPreview(commandArguments);
  }
}
