import type { ReactNode } from "react";

const THRONE_AND_DOTFILES_WORDS = "Throne and dotfiles";

function spoilerSummary(needsYouFlags: readonly boolean[], everyRowIsKnown: boolean): string {
  const needsYouCount = needsYouFlags.filter(Boolean).length;
  const counts = [everyRowIsKnown ? `${needsYouFlags.length}` : "", needsYouCount > 0 ? `${needsYouCount} needs you` : ""].filter(Boolean);
  return counts.length === 0 ? THRONE_AND_DOTFILES_WORDS : `${THRONE_AND_DOTFILES_WORDS} (${counts.join(", ")})`;
}

interface ThroneAndDotfilesSpoilerProps {
  readonly needsYouFlags: readonly boolean[];
  readonly everyRowIsKnown: boolean;
  readonly children: ReactNode;
}

export function ThroneAndDotfilesSpoiler({ needsYouFlags, everyRowIsKnown, children }: ThroneAndDotfilesSpoilerProps) {
  if (needsYouFlags.length === 0) return null;
  return (
    <details>
      <summary>{spoilerSummary(needsYouFlags, everyRowIsKnown)}</summary>
      {children}
    </details>
  );
}
