import { realWhereIStandDependencies, runWhereIStand } from "./where-i-stand-runtime.ts";

const [dataHome = "", holderName = "", checksum = ""] = process.argv.slice(2);

process.exitCode = await runWhereIStand(["lock", "--checksum", checksum, "--ttl", "1m"], {
  ...realWhereIStandDependencies({ THRONE_DATA_HOME: dataHome }),
  currentAgentName: async () => holderName,
  tellRegent: async (message) => void process.stderr.write(`notice for the Regent: ${message}`),
});
