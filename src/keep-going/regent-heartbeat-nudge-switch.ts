import { loadUserConfigFile } from '../user-config-loader.ts';

let cacheBustSequence = 0;

export async function readRegentHeartbeatNudgeEnabledInUserConfig(
  configPath?: string,
): Promise<boolean> {
  let file;
  try {
    file = await loadUserConfigFile(configPath, `${Date.now()}-${++cacheBustSequence}`);
  } catch {
    return false;
  }
  return file?.steering['regentHeartbeatNudgeEnabled'] === true;
}
