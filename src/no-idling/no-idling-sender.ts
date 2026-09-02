// The no-idling sweep's outbound sender identity -- a leaf constant with no
// imports of its own, so any no-idling module can depend on it without
// closing an import cycle back through no-idling-notify-guard.ts or
// no-idling-dependencies.types.ts.
export const NO_IDLING_SENDER = '';
