import type { SupportedAgentScreenSnapshot } from "../codex-screen/composer/composer.types.ts";

export function unresolvedComposerDeadlineMessage(
  activeComposer: Exclude<
    SupportedAgentScreenSnapshot["activeComposer"],
    { state: "empty" }
  >,
): string {
  switch (activeComposer.state) {
    case "draft":
      return (
        `a resident draft (${activeComposer.text.length} characters) did ` +
        "not clear before the composer deadline; nothing was overwritten"
      );
    case "modal":
      return (
        "the pane is parked at its own interactive menu and did not clear " +
        "before the composer deadline; nothing was overwritten"
      );
    case "unavailable":
      return (
        "the active bottom composer could not be identified before the " +
        "composer deadline; nothing was written"
      );
  }
}
