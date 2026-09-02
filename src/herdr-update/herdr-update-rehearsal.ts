import { OWNED_HERDR_CLIENT_RELEASE_TAG } from '../herdr/herdr-client.ts';
import {
  DEFAULT_HERDR_UPDATE_PROCESS_BOUNDARY,
  downloadAndVerifyHerdrRelease,
  type HerdrUpdateProcessBoundary,
} from './herdr-update-release.ts';
import {
  type HerdrUpdateSweepResult,
  launchIsolatedHerdrSession,
  readIsolatedSessionStatus,
  resolveIsolatedHerdrUpdateSessionName,
  sweepHerdrDependentCommands,
} from './herdr-update-session.ts';
import {
  compareLiveProtocolToPinned,
  type HerdrUpdateProtocolComparison,
} from './herdr-update-protocol.ts';

export interface HerdrUpdateRehearsalEvidence {
  readonly tag: string;
  readonly sessionName: string;
  readonly download: {
    readonly artifactPath: string;
    readonly hashMatched: boolean;
    readonly expectedSha256: string;
    readonly computedSha256: string;
  };
  readonly sweep: HerdrUpdateSweepResult[];
  readonly protocol: HerdrUpdateProtocolComparison;
}

/** Runs the full herdr-update build-capability: download+verify against real
 *  GitHub release metadata, isolated-session launch, command sweep, live
 *  protocol re-read, and teardown — whether it passes or fails. Never moves
 *  `OWNED_HERDR_CLIENT_RELEASE_TAG` or `THRONE_HERDR_PROTOCOL`; this proves
 *  the machinery against the tag it is called with. */
export async function rehearseHerdrUpdate(
  tag: string = OWNED_HERDR_CLIENT_RELEASE_TAG,
  env: NodeJS.ProcessEnv = process.env,
  boundary: HerdrUpdateProcessBoundary = DEFAULT_HERDR_UPDATE_PROCESS_BOUNDARY,
): Promise<HerdrUpdateRehearsalEvidence> {
  const sessionName = resolveIsolatedHerdrUpdateSessionName(env);
  const download = await downloadAndVerifyHerdrRelease(tag, boundary);
  try {
    if (!download.hashMatched) {
      throw new Error(
        `herdr-update: downloaded artifact hash ${download.computedSha256} did not match ` +
          `the release metadata hash ${download.expectedSha256}; rejecting the artifact`,
      );
    }
    const session = await launchIsolatedHerdrSession(download.artifactPath, sessionName);
    try {
      const sweep = await sweepHerdrDependentCommands(download.artifactPath, sessionName);
      const status = await readIsolatedSessionStatus(download.artifactPath, sessionName);
      const protocol = compareLiveProtocolToPinned(status.protocol);
      return {
        tag,
        sessionName,
        download: {
          artifactPath: download.artifactPath,
          hashMatched: download.hashMatched,
          expectedSha256: download.expectedSha256,
          computedSha256: download.computedSha256,
        },
        sweep,
        protocol,
      };
    } finally {
      await session.cleanup();
    }
  } finally {
    await download.cleanup();
  }
}
