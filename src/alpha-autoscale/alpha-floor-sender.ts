// The alpha-floor breach notifier's outbound sender identity -- a leaf
// constant with no imports of its own, so any alpha-floor module can depend
// on it without closing an import cycle back through
// alpha-autoscale.hosted-worker.ts or alpha-floor-notify.ts.
export const ALPHA_FLOOR_CRON_SENDER = 'alpha-autoscale';
