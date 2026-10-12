import {
  NOTIFY_CONFIG,
  postNtfyMessage,
  type NotificationTransport,
} from "../notify-lord/notification.service.ts";

export const COURT_LIVENESS_ALERT_STREAK_LENGTH = 3;

const COURT_LIVENESS_ALERT_TITLE = "Throne court liveness check is failing";

export interface CourtLivenessAlertDependencies {
  readonly postMessage: NotificationTransport;
  readonly log: (line: string) => void;
}

export type ReportCourtLivenessTick = (
  failure: string | undefined,
) => Promise<void>;

const DEFAULT_DEPENDENCIES: CourtLivenessAlertDependencies = {
  postMessage: postNtfyMessage,
  log: (line) => console.error(line),
};

function repeatedFailureMessage(failure: string): string {
  return `The court liveness check has failed ${COURT_LIVENESS_ALERT_STREAK_LENGTH} times in a row: ${failure}`;
}

async function tellTheLord(
  message: string,
  dependencies: CourtLivenessAlertDependencies,
): Promise<void> {
  try {
    await dependencies.postMessage(message, NOTIFY_CONFIG, {
      title: COURT_LIVENESS_ALERT_TITLE,
    });
  } catch (error) {
    dependencies.log(`${message} (ntfy post failed: ${String(error)})`);
  }
}

export function createCourtLivenessAlert(
  dependencies: CourtLivenessAlertDependencies = DEFAULT_DEPENDENCIES,
): ReportCourtLivenessTick {
  let streakFailure: string | undefined;
  let streakLength = 0;

  return async (failure) => {
    streakLength = failure === streakFailure ? streakLength + 1 : 1;
    streakFailure = failure;
    if (failure === undefined) return;
    if (streakLength !== COURT_LIVENESS_ALERT_STREAK_LENGTH) return;
    await tellTheLord(repeatedFailureMessage(failure), dependencies);
  };
}
