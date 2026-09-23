import type { ClassifierBackend } from './classifier.types.ts';
import {
  PRODUCTION_JEV_DEPENDENCIES,
  createJevBackend,
  type JevBackendDependencies,
} from './jev-backend.ts';
import {
  PRODUCTION_JEV_SWITCH_DEPENDENCIES,
  readJevSwitch,
  type JevSwitchDependencies,
} from './jev-switch.ts';
import type { RecallConfig } from './recall-user-config.ts';
import { RULES_BACKEND } from './rules-backend.ts';

export interface BackendChoiceDependencies {
  readonly jevSwitch: JevSwitchDependencies;
  readonly jevBackend: JevBackendDependencies;
  writeStderr(text: string): void;
}

export const PRODUCTION_BACKEND_CHOICE_DEPENDENCIES: BackendChoiceDependencies = {
  jevSwitch: PRODUCTION_JEV_SWITCH_DEPENDENCIES,
  jevBackend: PRODUCTION_JEV_DEPENDENCIES,
  writeStderr: (text) => process.stderr.write(text),
};

export async function chooseClassifierBackend(
  config: Pick<RecallConfig, 'jevEnabled' | 'jevKeyFile'>,
  dependencies: BackendChoiceDependencies = PRODUCTION_BACKEND_CHOICE_DEPENDENCIES,
): Promise<ClassifierBackend> {
  const jevSwitch = await readJevSwitch(config, dependencies.jevSwitch);
  if (jevSwitch.keyFile === 'unavailable') {
    dependencies.writeStderr(
      `relevance-classifier: Jev is switched on but its key file ${jevSwitch.keyFilePath} is missing, unreadable or empty, so the rules answer instead.\n`,
    );
  }
  return jevSwitch.on
    ? createJevBackend(jevSwitch.keyFilePath, dependencies.jevBackend)
    : RULES_BACKEND;
}
