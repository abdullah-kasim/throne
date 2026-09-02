export const AUTOREAP_REFUSAL_COOLDOWN_MS = 5 * 60_000;

/** Process-lifetime, per-agent suppression matching the hosted-worker tracker shape. */
export class AutoreapRefusalCooldown {
  private readonly attemptedAt = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  isCoolingDown(agent: string): boolean {
    const attemptedAt = this.attemptedAt.get(agent);
    return attemptedAt !== undefined && this.now() - attemptedAt < AUTOREAP_REFUSAL_COOLDOWN_MS;
  }

  record(agent: string): void {
    this.attemptedAt.set(agent, this.now());
  }

  clear(agent: string): void {
    this.attemptedAt.delete(agent);
  }
}
