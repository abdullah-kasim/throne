export interface EntranceRefusalGuidance {
  readonly reason: string;
  readonly bypass: string | undefined;
  readonly supervisorRoute: string;
}

export type EntranceRefusalBypass =
  | { readonly available: false }
  | { readonly available: true; readonly guidance: string };

function requireGuidanceText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`entrance refusal ${field} must not be empty`);
  }
  return normalized;
}

export function renderEntranceRefusal(
  guidance: EntranceRefusalGuidance,
): string {
  const reason = requireGuidanceText(guidance.reason, "reason");
  const supervisorRoute = requireGuidanceText(
    guidance.supervisorRoute,
    "supervisor route",
  );
  const bypass =
    guidance.bypass === undefined
      ? "No bypass is available for this refusal."
      : requireGuidanceText(guidance.bypass, "bypass");
  return `${reason} ${bypass} ${supervisorRoute}`;
}

export function renderFrameworkEntranceRefusal(
  commandName: string,
  diagnostic: string,
  bypass: EntranceRefusalBypass,
): string {
  const normalizedDiagnostic = requireGuidanceText(diagnostic, "diagnostic");
  return renderEntranceRefusal({
    reason: `${commandName} entrance validation refused the invocation: ${normalizedDiagnostic}`,
    bypass: bypass.available ? bypass.guidance : undefined,
    supervisorRoute:
      "Ask your supervisor for an allowed alternative invocation.",
  });
}
