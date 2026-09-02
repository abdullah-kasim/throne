/**
 * In-memory, process-lifetime tracker of how long the live-Alpha floor has
 * been continuously breached -- same durability class as
 * `alphaAutoscaleScheduleDedupeTracker` in `alpha-autoscale-schedule-dedupe.ts`:
 * no persistence across a worker restart, one instance per hosted worker.
 */
export class AlphaFloorBreachTracker {
  private breachStartedAtMs: number | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Records this tick's breach state and returns how long the breach has
   * persisted so far, in milliseconds. A tick that reads not breached
   * resets the clock to zero immediately, in memory only.
   */
  recordTick(breached: boolean): number {
    if (!breached) {
      this.breachStartedAtMs = undefined;
      return 0;
    }
    if (this.breachStartedAtMs === undefined) {
      this.breachStartedAtMs = this.now();
    }
    return this.now() - this.breachStartedAtMs;
  }

  /** Test-only escape hatch for clearing process-lifetime state. */
  resetForTest(): void {
    this.breachStartedAtMs = undefined;
  }
}

/** One tracker instance, owned solely by `AlphaAutoscaleHostedWorker`. */
export const alphaFloorBreachTracker = new AlphaFloorBreachTracker();
