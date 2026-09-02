// CLI argument parsing and usage text for suite-container-cleanup.mjs.

export const USAGE = `Usage: suite-container-cleanup.mjs [--help] [--apply] [--dry-run] [--container <name>] [--max-entries <n>]

  --help, -h          Print this usage and exit. Removes nothing.
  --dry-run           Print what would be removed, without removing it.
                       This is also the default when no arguments are given.
  --apply             Actually remove the containers verdicted REMOVE.
  --container <name>  Restrict classification and removal to exactly the
                       named container.
  --max-entries <n>   Bound how many REMOVE-verdict containers a single
                       apply run will act on before stopping and reporting
                       what was and was not processed.
`;

export function printUsage() {
  process.stdout.write(USAGE);
}

/**
 * Renders a command-entry refusal in the shape every throne command-entry
 * refusal uses: WHY the invocation was refused, the bypass if one exists,
 * and the human route.
 */
function renderEntranceRefusal(reason) {
  return `${reason} No bypass is available for this refusal. Ask your supervisor for an allowed alternative invocation.`;
}

/**
 * Allowlist-based CLI argument parser. Pure: never throws, never touches
 * argv beyond reading it. Any token outside the recognized flag set yields
 * the `{ error }` shape rather than falling through to a destructive
 * default.
 *
 * @param {string[]} argv
 * @returns {
 *   | { mode: "help" }
 *   | { mode: "dry-run" | "apply", containerFilter: string | null, maxEntries: number | null }
 *   | { error: string }
 * }
 */
export function parseCliArgs(argv) {
  let mode = "dry-run";
  let containerFilter = null;
  let maxEntries = null;

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    switch (token) {
      case "--help":
      case "-h":
        return { mode: "help" };
      case "--apply":
        mode = "apply";
        break;
      case "--dry-run":
        break;
      case "--container": {
        const name = argv[index + 1];
        if (name === undefined) {
          return {
            error: renderEntranceRefusal(
              "--container requires a container name argument.",
            ),
          };
        }
        containerFilter = name;
        index++;
        break;
      }
      case "--max-entries":
      case "--budget": {
        const rawValue = argv[index + 1];
        const parsedValue = Number(rawValue);
        if (
          rawValue === undefined ||
          !Number.isInteger(parsedValue) ||
          parsedValue < 0
        ) {
          return {
            error: renderEntranceRefusal(
              `${token} requires a non-negative integer argument.`,
            ),
          };
        }
        maxEntries = parsedValue;
        index++;
        break;
      }
      default:
        return {
          error: renderEntranceRefusal(
            `Unrecognized argument "${token}" — refusing to guess whether it means dry-run or apply.`,
          ),
        };
    }
  }

  return { mode, containerFilter, maxEntries };
}
