import { Injectable } from "@nestjs/common";
import {
  agentRegistrationExists,
  readSpawnSpec,
  writeSpawnSpec,
  spawnCapabilityEvidenceIsValid,
  type SpawnSpec,
} from "./spawn-data-contracts.ts";

@Injectable()
export class SpawnDataService {
  readonly agentRegistrationExists = agentRegistrationExists;
  readonly readSpawnSpec = readSpawnSpec;
  readonly writeSpawnSpec = writeSpawnSpec;
  readonly spawnCapabilityEvidenceIsValid = spawnCapabilityEvidenceIsValid;
}
