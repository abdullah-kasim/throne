export const PANE_LOCK_MAXIMUM_HOLD_MS = 60_000;

export class PaneLockTakenOverError extends Error {
  override readonly name = 'PaneLockTakenOverError';

  constructor(paneId: string) {
    super(`recipient pane lock for ${paneId} was taken over after a minute`);
  }
}
