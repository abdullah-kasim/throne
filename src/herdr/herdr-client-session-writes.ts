import { runHerdrInSession, type HerdrProcessBoundary } from './herdr-client.ts';

export function sendTextInSession(
  sessionName: string,
  target: string,
  text: string,
  processBoundary?: HerdrProcessBoundary,
): Promise<void> {
  return runHerdrInSession(
    sessionName,
    ['pane', 'send-text', target, text],
    processBoundary,
  ).then(() => undefined);
}

export function pressEnterInSession(
  sessionName: string,
  pane: string,
  processBoundary?: HerdrProcessBoundary,
): Promise<void> {
  return runHerdrInSession(
    sessionName,
    ['pane', 'send-keys', pane, 'Enter'],
    processBoundary,
  ).then(() => undefined);
}

export function pressPaneKeyInSession(
  sessionName: string,
  pane: string,
  key: string,
  processBoundary?: HerdrProcessBoundary,
): Promise<void> {
  return runHerdrInSession(
    sessionName,
    ['pane', 'send-keys', pane, key],
    processBoundary,
  ).then(() => undefined);
}
