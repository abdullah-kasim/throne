import { runHerdrInSession, writeToPaneHoldingItsLock, type HerdrProcessBoundary } from './herdr-client.ts';

export function sendTextInSession(
  sessionName: string,
  target: string,
  text: string,
  processBoundary?: HerdrProcessBoundary,
): Promise<void> {
  return writeToPaneHoldingItsLock(target, () =>
    runHerdrInSession(sessionName, ['pane', 'send-text', target, text], processBoundary),
  );
}

export function pressEnterInSession(
  sessionName: string,
  pane: string,
  processBoundary?: HerdrProcessBoundary,
): Promise<void> {
  return writeToPaneHoldingItsLock(pane, () =>
    runHerdrInSession(sessionName, ['pane', 'send-keys', pane, 'Enter'], processBoundary),
  );
}

export function pressPaneKeyInSession(
  sessionName: string,
  pane: string,
  key: string,
  processBoundary?: HerdrProcessBoundary,
): Promise<void> {
  return writeToPaneHoldingItsLock(pane, () =>
    runHerdrInSession(sessionName, ['pane', 'send-keys', pane, key], processBoundary),
  );
}
