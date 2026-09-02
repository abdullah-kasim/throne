export const FORECAST_EVIDENCE = {
  INSUFFICIENT: 'insufficient',
  MEASURED_ZERO_BURN: 'measured_zero_burn',
  MEASURED_BURN: 'measured_burn',
} as const;

export type ForecastEvidence = typeof FORECAST_EVIDENCE[keyof typeof FORECAST_EVIDENCE];

export const FORECAST_FALLBACK_REASON = {
  INVALID_NOW: 'invalid_now',
  INVALID_RESET_TIME: 'invalid_reset_time',
  NO_VALID_SAMPLES: 'no_valid_samples',
  RESET_REACHED: 'reset_reached',
  STALE_LATEST_SAMPLE: 'stale_latest_sample',
  INSUFFICIENT_INTERVALS: 'insufficient_intervals',
  INSUFFICIENT_OBSERVATION_SPAN: 'insufficient_observation_span',
} as const;

export type ForecastFallbackReason =
  typeof FORECAST_FALLBACK_REASON[keyof typeof FORECAST_FALLBACK_REASON];

export interface UsageForecastSample {
  recorded_at: string;
  remaining_pct: number;
  reset_time: string | null;
}

export interface UsageForecastInput {
  now: string;
  reset_time: string;
  samples: readonly UsageForecastSample[];
}

export interface UsageForecastResult {
  current_remaining_pct: number | null;
  projected_remaining_pct: number | null;
  evidence: ForecastEvidence;
  fallback_reason: ForecastFallbackReason | null;
  sample_count: number;
  interval_count: number;
  ignored_interval_count: number;
  observation_span_hours: number;
}

interface Reading {
  recordedAt: number;
  remainingPct: number;
  resetAt: number | null;
  order: number;
}

interface BurnInterval {
  elapsedHours: number;
  observedBurn: number;
}

const MS_PER_HOUR = 3_600_000;
const MIN_OBSERVATION_SPAN_MS = 30 * 60_000;
const MAX_LATEST_SAMPLE_AGE_MS = 6 * MS_PER_HOUR;
const RESET_INSTANT_JITTER_TOLERANCE_MS = 60_000;
const MIN_INTERVAL_COUNT = 1;

function parseReadings(
  samples: readonly UsageForecastSample[],
  now: number,
): { readings: Reading[]; ignoredSampleCount: number } {
  const readings: Reading[] = [];
  let ignoredSampleCount = 0;
  samples.forEach((sample, order) => {
    const recordedAt = Date.parse(sample.recorded_at);
    const resetAt = sample.reset_time === null ? null : Date.parse(sample.reset_time);
    if (
      !Number.isFinite(recordedAt) ||
      recordedAt > now ||
      !Number.isFinite(sample.remaining_pct) ||
      sample.remaining_pct < 0 ||
      sample.remaining_pct > 100 ||
      (sample.reset_time !== null && !Number.isFinite(resetAt))
    ) {
      ignoredSampleCount += 1;
      return;
    }
    readings.push({
      recordedAt,
      remainingPct: sample.remaining_pct,
      resetAt,
      order,
    });
  });
  readings.sort((left, right) => left.recordedAt - right.recordedAt || left.order - right.order);
  return { readings, ignoredSampleCount };
}

function isSegmentBoundary(previous: Reading, current: Reading): boolean {
  if (
    previous.resetAt !== null &&
    current.resetAt !== null &&
    Math.abs(current.resetAt - previous.resetAt) > RESET_INSTANT_JITTER_TOLERANCE_MS
  ) {
    return true;
  }
  return current.remainingPct > previous.remainingPct;
}

function latestSegment(readings: readonly Reading[]): Reading[] {
  let segmentStart = 0;
  for (let index = 1; index < readings.length; index += 1) {
    if (isSegmentBoundary(readings[index - 1], readings[index])) segmentStart = index;
  }
  return readings.slice(segmentStart);
}

function burnIntervals(readings: readonly Reading[]): {
  intervals: BurnInterval[];
  ignoredIntervalCount: number;
} {
  const intervals: BurnInterval[] = [];
  let ignoredIntervalCount = 0;
  for (let index = 1; index < readings.length; index += 1) {
    const previous = readings[index - 1];
    const current = readings[index];
    const elapsedHours = (current.recordedAt - previous.recordedAt) / MS_PER_HOUR;
    if (elapsedHours <= 0) {
      ignoredIntervalCount += 1;
      continue;
    }
    const observedBurn = Math.max(0, previous.remainingPct - current.remainingPct);
    intervals.push({ elapsedHours, observedBurn });
  }
  return { intervals, ignoredIntervalCount };
}

function aggregateBurnRate(intervals: readonly BurnInterval[]): number {
  const elapsedHours = intervals.reduce((total, interval) => total + interval.elapsedHours, 0);
  const observedBurn = intervals.reduce((total, interval) => total + interval.observedBurn, 0);
  return observedBurn / elapsedHours;
}

function insufficientResult(
  fallbackReason: ForecastFallbackReason,
  currentRemainingPct: number | null,
  sampleCount: number,
  intervalCount: number,
  ignoredIntervalCount: number,
  observationSpanHours = 0,
): UsageForecastResult {
  return {
    current_remaining_pct: currentRemainingPct,
    projected_remaining_pct: null,
    evidence: FORECAST_EVIDENCE.INSUFFICIENT,
    fallback_reason: fallbackReason,
    sample_count: sampleCount,
    interval_count: intervalCount,
    ignored_interval_count: ignoredIntervalCount,
    observation_span_hours: observationSpanHours,
  };
}

export function forecastUsageAtReset(input: UsageForecastInput): UsageForecastResult {
  const now = Date.parse(input.now);
  if (!Number.isFinite(now)) {
    return insufficientResult(FORECAST_FALLBACK_REASON.INVALID_NOW, null, 0, 0, 0);
  }
  const resetAt = Date.parse(input.reset_time);
  if (!Number.isFinite(resetAt)) {
    return insufficientResult(FORECAST_FALLBACK_REASON.INVALID_RESET_TIME, null, 0, 0, 0);
  }

  const parsed = parseReadings(input.samples, now);
  if (parsed.readings.length === 0) {
    return insufficientResult(
      FORECAST_FALLBACK_REASON.NO_VALID_SAMPLES,
      null,
      0,
      0,
      parsed.ignoredSampleCount,
    );
  }

  const segment = latestSegment(parsed.readings);
  const latest = segment[segment.length - 1];
  const currentRemainingPct = latest.remainingPct;
  if (now >= resetAt) {
    return insufficientResult(
      FORECAST_FALLBACK_REASON.RESET_REACHED,
      currentRemainingPct,
      segment.length,
      0,
      parsed.ignoredSampleCount,
    );
  }
  if (now - latest.recordedAt > MAX_LATEST_SAMPLE_AGE_MS) {
    return insufficientResult(
      FORECAST_FALLBACK_REASON.STALE_LATEST_SAMPLE,
      currentRemainingPct,
      segment.length,
      0,
      parsed.ignoredSampleCount,
    );
  }

  const burn = burnIntervals(segment);
  const ignoredIntervalCount = parsed.ignoredSampleCount + burn.ignoredIntervalCount;
  if (burn.intervals.length < MIN_INTERVAL_COUNT) {
    return insufficientResult(
      FORECAST_FALLBACK_REASON.INSUFFICIENT_INTERVALS,
      currentRemainingPct,
      segment.length,
      burn.intervals.length,
      ignoredIntervalCount,
      (latest.recordedAt - segment[0].recordedAt) / MS_PER_HOUR,
    );
  }
  const observationSpan = latest.recordedAt - segment[0].recordedAt;
  if (observationSpan < MIN_OBSERVATION_SPAN_MS) {
    return insufficientResult(
      FORECAST_FALLBACK_REASON.INSUFFICIENT_OBSERVATION_SPAN,
      currentRemainingPct,
      segment.length,
      burn.intervals.length,
      ignoredIntervalCount,
    );
  }

  const burnRate = aggregateBurnRate(burn.intervals);
  const hoursUntilReset = (resetAt - latest.recordedAt) / MS_PER_HOUR;
  const projected = currentRemainingPct - burnRate * hoursUntilReset;
  const measuredZeroBurn = burn.intervals.every((interval) => interval.observedBurn === 0);

  return {
    current_remaining_pct: currentRemainingPct,
    projected_remaining_pct: projected,
    evidence: measuredZeroBurn
      ? FORECAST_EVIDENCE.MEASURED_ZERO_BURN
      : FORECAST_EVIDENCE.MEASURED_BURN,
    fallback_reason: null,
    sample_count: segment.length,
    interval_count: burn.intervals.length,
    ignored_interval_count: ignoredIntervalCount,
    observation_span_hours: observationSpan / MS_PER_HOUR,
  };
}
