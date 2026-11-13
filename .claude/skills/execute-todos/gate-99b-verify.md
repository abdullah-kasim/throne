# The 99b verify gate

### Hybrid duplicate detection — the `99b` static-analysis contract

This is the single owning contract for duplicate detection. `99b` applies it as
part of its static-analysis run; planners and generated terminal todos point
here instead of restating a drifting copy.

**Stage 1 runs first: invoke deterministic clone detection.** Resolve the local
command before running the gate with `throne check-jscpd`. If it fails, run the
remedy it prints, then run the check again. Invoke `jscpd`, which resolves to
throne's `bin/jscpd` over the vendored copy, as `jscpd --reporters json`; never
use `npx`, including its offline mode, and do not add jscpd to throne's own
`package.json`: jscpd lives in `vendor/package.json`, which only the installer
writes. Believe a clone count only when every file passed is in the report's
analyzed-file total or explained: a file over `--max-size` (1mb by default) is
skipped without an error, so raise `--max-size` for it, and a file shorter than
`--min-tokens` is not counted as analyzed. (Proven live,
2026-08-11: `campaign-evidence`'s
duplicates section parses the report via `JSON.parse`, so `--reporters ai` cannot
work as documented — if the `ai` reporter's richer shape was the original intent,
`campaign-evidence` still needs to learn it; this line records only what is
proven to work today.) Obtain
the pre-campaign base from the campaign's recorded base commit, verify that it
is an ancestor of the assembled HEAD, and run the detector on baseline and HEAD
with the same configuration and campaign-relevant code-file scope. Compare
stable quoted site pairs, not aggregate totals; feed the two detector reports to
the evidence command's `duplicates` section
(`--baseline-duplicates <path> --head-duplicates <path>`) and record its exit
code rather than summarizing the reports by hand. If the detector cannot run,
record `UNVERIFIED`, the command and error, and do not report a clean duplicate
check.

The tuned starting configuration uses minimums of 8 lines and 70 tokens. Scan
source and test code that the campaign changed or that forms the other side of a
reported clone. Exclude generated and build output, dependency and vendored
trees, dedicated fixture and snapshot trees, lockfiles, and ephemeral throne
ledger/worktree data: those are generated, third-party, deliberately repetitive
test data, machine-maintained metadata, or orchestration state rather than
maintained implementation. Record the actual command, version, paths,
exclusions, thresholds, exit code, and report in `99b`; any adjustment must state
which false positive or missed candidate justified it. Do not add jscpd to
throne's own `package.json` or introduce a network requirement into `bun run test`;
the vendored install is setup performed by the installer before the gate, not
part of the test command.

**Only after Stage 1 has produced its report may Stage 2 begin.** Stage 2 reviews
only the functions touched by the campaign diff and the exact site pairs Stage
1 reported. Whole-repository AI ingestion is forbidden. Use the semantic-function
map's existing predicates, transformations, decisions, and effects vocabulary
to judge differently shaped implementations of the same domain rule. Every
deterministic or semantic finding quotes both sites and classifies the pair as
**genuine duplication to fix, deliberate and justified, or trivial and exempt**
under the anti-cargo-cult boundary.

Clones present in the baseline report are report-only debt. Only a clone or
duplicated semantic decision introduced by the campaign fails `99b`; an
unchanged baseline pair cannot fail merely because the detector found it again.
Never use the aggregate duplicated-line or duplicated-token percentage as a
PASS/FAIL threshold. A new duplicated semantic decision fails however small its
percentage contribution, while a large non-duplicated change does not fail for
moving a repository-wide ratio.

### Responsibility-oriented decomposition — the shape of a terminal-gate corrective refactor

This is the single owning contract for how a terminal-gate finding's corrective
refactor must be shaped. It applies whenever a terminal-gate finding returns work that reshapes
files or modules: a genuine duplicate to fix, a module that has accumulated
unrelated work, or a home that changes for several unrelated reasons. Generated
terminal todos and planners point here instead of restating a drifting copy.

The required shape is **responsibility-oriented decomposition** — the
module-level and recursive application of the **Single Responsibility
Principle**. A module has exactly **one reason to change**. Split by independent
reasons to change, considering these axes in order:

1. **Public API or orchestration** — the entry point callers bind to. It
   composes the other modules and owns no lower-level detail itself.
2. **Platform-, harness-, or backend-specific handling** — each variant that
   changes for its own vendor, protocol, or environment reason gets its own home.
3. **Major effects** — send/deliver, create/spawn, and persistence/IO. Each
   effect family changes for its own reason and is its own module.
4. **Shared semantic predicates and transformations** — extracted last and only
   when genuinely reused; a one-call-site wrapper is not a responsibility.

**Recursive** means the same test is re-applied to every module the split
produces: a module that still carries two reasons to change is split again.
Stop when each module has one reason to change and a further split would only
add trivial indirection.

`99b` **rejects**, as not-decomposed and regardless of the resulting line
counts: arbitrary size-balanced chunks; numbered or lettered parts (`<name>2`,
`<name>-part2`, `<name>-extra`, `<name>-misc`); layers that still mix change
axes inside each layer; an unchanged monolith relocated or renamed; and a
re-export barrel that restores the monolith as the only consumer surface. File
size or line count is a symptom that prompts the question — it never defines the
split, and no size target is the acceptance criterion.

Where substantial type or interface declarations obscure the implementation
they describe, a responsibility slice may also split along **companions that
share one responsibility stem** — implementation, contract, and proof, named
like `create.ts`, `create.types.ts`, and `create.spec.ts` — subject to the
repository's own file-naming conventions, which win over these illustrative
suffixes. Companions are optional: never create an empty or otherwise
unnecessary companion, and a slice whose declarations do not obscure anything
stays one file. `99b` **rejects** as not-decomposed: a generic `types.ts` junk
drawer collecting declarations of unrelated owners; type-only extraction used to
game a size target; a duplicate interface declared beside the one it copies; and
any companion that introduces a new import cycle. Each companion is admitted
only when it carries the **semantic ownership** of its stem — the same one
reason to change — and preserves the **public compatibility** of the surface its
callers already bind to.

Worked example, deliberately path-free: one module owning a terminal
workspace-manager integration's entire surface decomposes into an
orchestration/public-API module, one module per harness-specific behaviour, one
module per major effect (send a message, create a workspace entry, persist the
registry), and — only where a rule genuinely decides behaviour at several sites
— one small shared-predicate module. Reproduce the reasoning, not those names.

The planning/execution boundary still holds. `write-todos` names **hypothesized
responsibility modules** at high level, by their reason to change and at file
granularity; the executing Shadow refines their names, boundaries, and count
after recon. A planner's hypothesis is never the acceptance criterion, and a
deviation from a hypothesized module name is never a terminal-gate finding.

#### `99b` — run the tests and lint, and fix what fails

`99b_verify_<topic>.md` runs second, only after `99a` returns an explicit
`**Conformance outcome:** PASS`. It runs the bundle's verification commands against the
assembled candidate — the test suite, the linter, type/static analysis, and any
repository contract check the project already owns — records each command with
its exit code and relevant output, and **fixes every failure it finds**, on the
campaign branch, re-running until the whole set is clean.
Follow the spec file's "How to reach it and prove it works" section where one exists (`throne spec-location <repository>` says where the spec is).

It runs the small checks before the big one, in rising tiers A, B, C, D.
Each tier is run, and what it finds fixed and committed, until it is green;
only then does the next tier start. A bigger tier never starts beside a
smaller one, because a fix the smaller one forces throws that run away (Lord,
2026-10-15: "1 small test and 1 big test beats 2 big tests."). Build,
type/static analysis, the linters and the diff sweep run with Tier A. The
tiers are the same in every repository; each repository's own commands are
found at run time.

- **Tier A — the tests nearest the change.** First the test files the
  campaign added or changed; then the test files that test the source files
  it touched, found by the repository's own convention (a same-name spec or
  test beside the file, or a test folder mirror); then the test files a grep
  finds importing the touched files. Run them with the runner's own file
  selection: `node --test <files>`, `jest <files>` or
  `jest --findRelatedTests <files>`, `vitest related <files>`,
  `go test ./pkg/...`, `pytest <files>`.
- **Tier B — the tests coverage says reach the change.** Run the suite once
  with the runner's coverage on, or read the repository's recorded coverage
  map when it keeps one, to learn which test files execute the changed
  lines; then run exactly those. Use the runner's built-in: `jest
  --findRelatedTests` or `jest --coverage`, `vitest related`,
  `node --test --experimental-test-coverage`, `go test -coverprofile`,
  coverage.py. When the repository has no cheap way to map tests to files,
  say so and skip to Tier C. Never fake the mapping.
- **Tier C — the full suite without slow tests.** The repository's default
  test command, which leaves out its slow tier when it has one; with no slow
  or fast split, Tier C is the plain full suite. Here that is `bun run test`.
  When the project compares against a base suite, it compares at Tier C.
  The base suite runs through `bun scripts/shared-base-suite.mjs
  <base-directory>` and may be a cached result, named in the `99b` file by
  key and path; the candidate suite is never cached.
  This is the single assembled full-suite run of "Three verification
  layers".
- **Tier D — slow tests and container tests, only by the gate's decision.**
  These are two separate opt-in choices, the slow tier and container tests,
  and each is off by default. A test that starts a container (podman or
  docker) is presumed slow. The gate decides each one on its own merits from
  the assembled diff, and runs a group only when the change reaches what it
  covers: a bakery app's change to its payment client runs its slow payment
  tests, while a wording change in its README runs neither. It records one
  line per decision, either way, with its reason, for example
  `container tests: not run; the change is skill text only`. A repository
  that does not separate its container tests is said to be so, and they are
  treated as part of its slow or default tier. Here the slow tier is
  `THRONE_SLOW_TESTS=1` (`bun run test:slow`). The heavy tier
  (`THRONE_HEAVY_TESTS`) is never part of this decision: it runs only on the
  Lord's direct order, and no agent ever chooses it.

The slow-test and container-test decisions are made in `99b`, and nowhere
else. Ordinary slices and `99a` never run slow or container tests; `99c`
carries `99b`'s decisions and results forward and does not decide again. The `99b` file records, for each
tier, the command, the files it selected, the exit code and the duration,
and the two Tier D decision lines. /write-todos' verify template holds the
checklist.

Once the set is green it runs a bug hunt: it reads the whole assembled diff
against the campaign base as a reviewer who did not write it, lists every piece
of state and every contract the diff adds or changes, tries to break each,
confirms each suspected bug with a failing test (or, for UI behaviour, a
recorded browser sequence) before fixing it, and reports the list it hunted,
one line each, even when it found nothing. /write-todos' verify template holds
the full block.

`00_overview.md`'s front-end stamps decide what else it runs; /write-todos'
"Front-end bundles" owns what they mean:

- **`frontend: true` with no `frontend_row:`** (a /gauntlet row among them): the
  `## Front-end critique` block.
- **`frontend_row: builder`:** the `## Browser function check` block instead,
  which performs each `## Done when` behaviour in Chromium. It runs no
  `/frontend-critic` review and no accessibility review, including
  `/screen-reader-check`. A builder delivers as soon as its gates pass, and the
  critic row does the rest.
- **`frontend_row: critic`:** the `## Front-end critique` block, widened to
  `/screen-reader-check`, finishing on empty reports. The bundle's slice `01`
  has already run both and fixed what they raised, before `99a`.

This is a fixing gate, not a verdict gate. A failing test, a lint violation, a
type error, or a broken build is corrective work `99b` does itself; it does not
hand findings back and wait.

**`99b` owns the fixing outright. It does not punt to the Alpha.** Reporting a
failure upward and waiting for someone else to repair it is not an available
move, and neither is a FAIL whose stated blocker is "this needs a code change."
Making the code change IS the assignment. The old chain returned findings to the
owning Alpha for a corrective iteration; that route is closed for anything `99b`
can repair itself, which is nearly everything a suite or a linter reports.
`99b` escalates only when repair is genuinely impossible for it — a requirement
nobody wrote, two slices whose designs contradict, an environment it cannot fix
— and it names that precise blocker rather than forwarding the raw failure.

It commits those repairs like any other worker, so
its branch legitimately carries a diff — and equally legitimately carries none
when the candidate was already green.

When its run includes the suite, exit 0 alone never credits a PASS: read
`run-suite-container.mjs`'s own stdout to its end and record the
`run-suite-container: tests executed: N` line it prints for every real run. A
truncated log, a signal death, a `tests executed: 0`, or a `tests executed:
unknown` line is a FAIL regardless of the exit code.

It ends with exactly one `**Verify outcome:** PASS` or `**Verify outcome:**
FAIL`. FAIL is reserved for a failure genuinely beyond the gate's reach — a
missing requirement, a design conflict between slices, an environment it cannot
repair — and must name precisely what blocked it. It performs no merge, invokes
no delivery tooling, and never touches the target branch.
