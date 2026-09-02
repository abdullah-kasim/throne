# Coding Principles

General coding principles that apply across all projects.

## The diagnostic: no surprises

When you read a function, the body should never surprise you given the name. If you ARE surprised, you're breaking three principles at once:

- **SRP** — the function is doing more than its name promises.
- **Self-documenting code** — the name is failing to describe what the function actually does.
- **DRY** — the surprising bit is probably hidden duplicate logic, tucked inside this function because the author didn't want to extract and reuse it.

So "no surprises" is the unified test. If a function's body matches its name with nothing extra, the three principles below are satisfied automatically. If something feels off when reading it, ask which is failing — the scope, the name, or hidden reuse — then rename, split, or extract.

Side effects are not the diagnostic. `saveUser(u)` writes to the DB and is unsurprising — that's literally what the name says. `getStatus()` writing to the DB IS surprising and must be split or renamed. The question is "did the body do what the name promised?", not "did it have side effects?". An implementation detail (e.g. a poll retry inside a deploy-status handler) is unsurprising when it's a known part of how that one job is accomplished.

## Investigate the cause before calling something a defect

Surprising behavior and blockers are investigation triggers, not verdicts. Before choosing a fix or a workaround, ask why the system behaves that way and answer it from evidence.

- **Trace before you judge.** Follow the intended design, the upstream owner of the component, the call path that produced the observation, and the invariants that path must preserve.
- **Classify what you found** as intended behavior, an environmental or provider constraint, or an actual defect. The correct fix differs for each, and choosing one before classifying is guessing.
- **Representation change is a signal, not a failure.** Intermediate representations, protocols, formats, normalization, compilation, compression, and translation stages exist to reshape data on purpose. When one is in the path, trace every stage that rewrites the data and what each stage is designed to guarantee, then judge the result by the semantics that survive end to end — not by how the data looks mid-pipeline.
- **A workaround without the cause is incomplete.** The only exception is a cause that is genuinely inaccessible; record that limitation alongside the workaround instead of leaving it implied.
- **Tests assert preserved semantics and supported boundaries**, not incidental representation identity. Cover the dimensions the system actually supports — typically messages and content, streaming, tools, usage and counting, model or component identity, and compression behavior — and let a stage change representation freely unless an explicit contract requires that exact identity.

## Name the logic before implementing it

**Before writing control flow, write the function names that describe the control flow.** Design the vocabulary first: name the predicates, transformations, decisions, and effects that the feature needs; write their signatures or a caller composed from those names; only then fill in their bodies.

The function names are the first implementation of the design. A reader should be able to understand the algorithm from the call graph without opening the functions. If the logic cannot be expressed as a short sequence of precise names, the design is not ready for nested conditions yet.

**Keep planning at a higher altitude than implementation.** A requirement or todo names the semantic decisions, invariants, reuse obligations, observable outcomes, and evidence needed for acceptance. It does not freeze exact function names, file-local mechanics, a speculative call graph, or a line-by-line algorithm before the implementing worker has inspected the code. After recon, the implementer owns the concrete function vocabulary and may refine it as evidence changes while preserving the higher-level contract. Reviewers grade semantic reuse and outcomes, not obedience to speculative planner mechanics.

- Start a non-trivial change by naming its semantic operations, such as `isTextboxEmpty()`, `pressEnterOnce()`, and `submitUntilTextboxIsEmpty()`.
- Extract a domain rule into one named predicate before using it in control flow. Reuse that predicate everywhere the same rule decides behavior; never repeat its underlying expression inline and let the meanings drift.
- Keep orchestration functions readable as a sequence of named operations. Put detail behind those names rather than growing an anonymous block of branches.
- Rename or split a function when its body cannot honestly satisfy its name. Do not preserve a misleading name and explain the mismatch with prose.
- Tests should name and exercise the same semantic boundaries. A test matrix around duplicated expressions does not repair a missing shared function.

This applies everywhere: production code, scripts, tests, CLIs, migrations, infrastructure, and glue code. Small obvious expressions may stay inline only when they carry no reusable domain meaning.

## Verify user-visible behavior end to end

For every user-visible feature or regression fix, exercise the affected journey through the real application stack before declaring the work complete. Use the global `$e2e-testing` skill for browser workflows.

- Prefer the project’s existing E2E suite. When none exists, perform the journey with `chrome-devtools-axi`.
- Verify observable behavior, not implementation details or values manufactured by test setup.
- Inspect browser console and network failures as part of the journey.
- Cover the primary success path plus a meaningful failure or boundary path when one exists.
- Unit and integration tests still provide focused coverage, but they do not replace E2E verification of user-visible behavior.
- When the application cannot run locally, report the exact blocker and the unverified journey instead of quietly substituting a mocked test.

## Functions should do one thing (SRP)

Don't merge two distinct operations into a single function just because they often appear together. Each function should have a single responsibility.

**Bad:** `checkDeployOrSchedulePoll()` — checks status AND secretly schedules a poll retry, then returns a status code that doesn't clearly communicate what happened. The caller sees logic "suddenly end" with no visible action taken on one of the branches.

**Good:** Split into `checkMetadataDeployStatus()` (returns status) and `scheduleMetadataDeployPoll()` (schedules the retry). The caller explicitly handles each status and the control flow is readable.

The test: if the function name has "And" or "Or" connecting two verbs, it's probably doing too much. `startEngine()` is fine because it's one conceptual operation even if it has internal steps. But `checkStatusAndScheduleRetry()` is two operations that the caller should control.

**Composition is fine.** `makeCar()` can call `addEngine()` and `addWheels()` internally — that's one conceptual operation built from smaller ones. What's not fine is exposing `addEngineAndWheels()` as a seam. Let callers compose primitives if that's what they need.

This is a case where DRY can go too far — collapsing two call sites into one function saves a line or two but hides control flow from the reader.

## DRY, with guardrails

Don't repeat yourself, but don't preempt either:

- **Rule of three.** Two similar code paths is a coincidence. Three is a pattern. Extract on the third occurrence, not the second.
- **Identical semantics, not just identical shape.** Two functions that look similar but mean different things should stay separate. Extract them and the helper grows flags/branches every time the meaning diverges — exactly the "more codepaths" failure mode (see Fewer codepaths below).
- **No duplicate functions with different signatures.** If two functions have the same body, one of them shouldn't exist. Don't preserve a duplicate just because existing callers use a different signature (e.g. static vs instance, extra params). Update the callers instead. "Backwards compatibility" is not an excuse for copy-pasting an entire method body and slapping `static` on it.
  .
  When in doubt, prefer three similar lines to a premature abstraction.

## Self-documenting code

The reader should know what a function does from its name alone — without opening the body, the docstring, or the call site.

- **Names use plain language.** `getActiveCustomerCount()` not `procCustData()`. `cancelSubscription()` not `handleSubCancel()`. If a comment is needed to explain what the function does, the name is wrong.
- **The name describes one thing.** Same And/Or test as SRP — `addEngineAndWheels` is two things, `makeCar` is one. Naming and SRP fail together.
- **No abbreviations** unless they're the project's domain language. `cust` saves four characters and costs every reader a half-second of decoding, every time.
- **Variables follow the same rule.** `pendingDeployIds` not `arr2`. `customersWithUnpaidInvoices` not `filtered`.
- **Never write comments or docstrings in code.** Code must read like plain English through precise names, small single-purpose functions, explicit types, named domain constants, and structure that exposes intent. If a decision, constraint, invariant, or gotcha seems to require a comment, encode it in a named function, type, test, validation rule, or module boundary instead. Do not narrate implementation, leave explanatory notes, add section banners, or preserve confusing code behind a prose apology.

## Keep hand-authored source files at 500 lines or fewer

Audit hand-authored source proactively and use recursive responsibility-oriented decomposition before a file crosses the limit. Hand-authored source files may not exceed 500 lines. Apply SOLID Single Responsibility recursively at file, module, and submodule levels, with boundaries chosen by independent reasons to change. Split by stable semantic responsibility before crossing the limit: public API/orchestration, platform-specific handling, and major effects such as send, create, and persistence belong in separate files when they are distinct concerns. Keep a thin compatibility entrypoint only when callers need it; numbered chunks, arbitrary size splits, and barrel camouflage are not compliance. Do not wait until the file is already a monolith. 500 lines is a guardrail, not the goal; the outcome is short, low-noise implementation files whose primary behavior is easy to read.

When repository conventions support it, prefer responsibility-centered companion naming such as `create.ts`, `create.types.ts`, and `create.spec.ts`; the exact test location and suffix follow the project convention. Implementation, contracts, and proof should share the same responsibility name. Extract substantial contracts into responsibility-specific type modules when inline declarations obscure implementation, but keep small local types colocated when clearer. Type/test companions and semantic modules are justified only when they reduce cognitive load and expose responsibility. Generic `types.ts` junk drawers, duplicate contracts, dependency cycles, and decomposition that adds navigation noise without improving readability are not compliance.

Generated artifacts follow their own generation contract, but they are not a loophole for hand-authored source. Moving an unchanged monolith into another file or disguising hand-written code as generated output does not satisfy this rule.

## Naming source-level identifiers (crates, modules, types)

The "Self-documenting code" rules above cover functions and variables. Coarse-grain identifiers — crate names, module names, file/folder names, type names — need extra care: they're harder to rename later (more callers, more workspace plumbing) and they shape how the next reader frames the whole subsystem. The target-in-the-name rule from "Naming user-facing actions" (see global `CLAUDE.md`) applies here too, plus four extensions:

- **Plain English over domain-theory jargon.** If a competent engineer without a CS-theory background has to pause and look the word up, pick a different word. `oracle` (test-theory term for the verdict component) → `verifier`. `factory` over `provider` when it just constructs. The bar isn't "is this technically correct?" — it's "will the next reader recognise it on first pass?".

- **Name after the subject, not the current input format.** Input producers get swapped; the format the thing happens to consume today is not what it has jurisdiction over. A crate that parses sigrok-cli output today but is structurally input-agnostic should be named after what it verifies, not after sigrok. Concrete: `bench-trace-oracle` was overspecific because the parsers are decoupled from sigrok by design — `bench-bus-verifier` correctly names the subject (the bus traffic) instead of one possible input (a trace file).

- **Smallest accurate superset for qualifiers.** If a thing covers both Modbus and CAN, the qualifier is `bus`, not `modbus-and-can` and not just `modbus`. Don't pick one member; don't enumerate all members; pick the genus. Forces the useful question: "what's the genus that covers everything I do, and only what I do?".

- **Bake the contract into the qualifier when the contract is non-obvious.** `bench` signals real-hardware-only — distinct from `e2e` which in software-land often means a pure-software stack. The qualifier should let the reader infer "what setup do I need to run this?" without opening the README. Other examples: `host-` prefix signals "host target only, not embedded"; `dev-only-` signals "do not ship".

The "no surprises" diagnostic applies here too: when you read the identifier, the thing it points at should match the name with nothing extra. Renaming early is cheap; renaming after every dependency exists is not.

## Structure reveals the domain (folder-by-feature, legible to a layman)

Self-documenting code is not just function and variable names — it's the **folder and module layout**. A newcomer with zero prior knowledge should be able to discover _what the system does_ by reading the directory tree alone, before opening a single file. If they have to already know the mechanism to find the intent, the structure has failed the same test a badly-named function fails.

**Assume a layman reads the codebase.** The visible feature layer must name things in plain language a non-specialist recognises — the reader is not assumed to know your transports, libraries, wire formats, or three-letter acronyms. Say "canbus" or "modbus" to a layman and they're lost; say "communication link" and they get it instantly. So folder-by-feature is not satisfied by _any_ decomposition — the features you name at the top must be ones a layman would name too. Jargon and mechanism terms are allowed only **down at the low-level floor** (a `transport/` folder may absolutely contain `can/` and `modbus/`), never as the entry point that a first-time reader hits.

This generalises beyond communication. It applies to any subsystem: name the top-level folders after the **feature a layman recognises** (what it does / what it's for), not the **mechanism a specialist would use to build it** (the library, protocol, algorithm, or data structure). "Comms between the picker robot and the packing station" is one instance; the same rule turns `parsers/` `validators/` `serializers/` (mechanism piles) into `checkout/` `onboarding/` `billing/` (features a layman names), and `redis/ kafka/ grpc/` into `sessions/ order-events/ inventory-sync/`.

The failure mode is **organizing by low-level mechanism** (the transport, the library, the wire format, the layer) when the reader thinks in **features and relationships** (what the thing is for, which subsystems talk). Mechanism-first layout buries the domain: it forces the reader to already know the mapping ("ah, CAN means the picker↔charging-dock link, Modbus means the picker↔packing-station link") that the structure was supposed to _teach_ them.

- **Top level names the intent; mechanism lives underneath.** The most prominent folders should answer "what relationship / feature is this?" — the transport, protocol, or library is a detail nested inside. Low-level mechanism folders may absolutely still exist (`can/`, `modbus/`, `http/`) — but as the _implementation floor under_ the high-level folders, not as the _entry point that hides them_.
- **Concrete example (the one that prompted this rule).** `warehouse-protocol/` organized as `can/ modbus/ timing/` forces you to already know that CAN carries the picker-bot↔charging-dock power-status link and Modbus carries the picker-bot↔packing-station handoff uplink. Reorganized as `picker_charging_comms/ picker_packing_comms/` (with the CAN/Modbus codecs as low-level detail underneath), the _directory tree itself_ tells a newcomer which stations talk and over what — the knowledge is discoverable, not assumed. "I shouldn't have to guess what comms the picker↔packing-station link is on" — the layout should answer it.
- **The test.** Show the folder tree (no file contents) to someone who has never seen the project. Can they name the subsystems and the relationships between them? If the top-level folders are transport/library/format names and the answer is "no, not without knowing the mapping," restructure so the high-level relationships are the visible layer.
- **One relationship can span several mechanisms.** A single high-level link may ride multiple transports at once — `picker_packing_comms/` can carry both CAN and Modbus traffic. On a system diagram you draw _one line_ ("packing station — connected to the picker bot, whatever bus") and only zoom into the transport when you're actually debugging bytes. So the relationship folder is the primary grouping and the transports are subordinate detail _inside_ it — never the reverse. Splitting `picker_packing_comms` into a `can/` pile and a `modbus/` pile would shatter one coherent relationship across two mechanism-named bins, which is exactly the failure this rule exists to prevent.
- **Cross-cutting concerns stay at the top** as their own siblings when they genuinely span several relationships (a shared data model, a clock that synchronises every link, a shared schema) — they are not "low-level," they are orthogonal, and hiding them inside one relationship's folder mislabels their scope.

This is the "no surprises" diagnostic applied to the tree: the layout should match the domain a reader carries in their head, with nothing extra to decode.

## Contract-based function design

Write functions as contracts: defined inputs, defined outputs. The function signature IS the contract — a caller should know exactly what they're getting back without reading the implementation.

**Use enums/types for return values, not magic strings.** If a function can return one of a known set of outcomes, define an enum. Strings are not contracts — they're accidents waiting to happen. `MetadataDeployStatus.PENDING` is a contract; `'PENDING'` is a string that someone will eventually typo.

**No semantic magic strings or magic variables—not even once.** When a value carries domain meaning (an identity, role, state, protocol token, path, timeout, feature flag, or comparison rule), name it once at the authoritative boundary and reuse that constant, type, or function everywhere. “It is only used here” is not an exception: the first inline spelling is how a second drifting spelling becomes possible. Normalize and compare domain values through one named function; never scatter raw `.toLowerCase()`, literal sentinels, or locally reconstructed constants across callers.

**Functions produce values, callers make decisions.** A function that checks status should RETURN the status. The caller decides what to do with it. Don't bury decision-making inside a function that's supposed to be answering a question — that's coupling disguised as convenience.

**Bad:** `getDataKitDeployStatus()` returns a status string AND logs AND queries AND handles exceptions internally, then the caller also has branching logic that partially duplicates the internal error handling.

**Good:** Query function returns a typed result. Caller handles each case explicitly. The query function's contract is: "give me the status or null" — nothing more.

This isn't the Java interfaces dance. No `IDeployStatusCheckerFactory`. Just: define what goes in, define what comes out, make the types enforce correctness, and let each function do exactly one job.

## Fewer codepaths

The fewer codepaths, the better. Always.

Normalize data to a predictable shape upfront instead of branching on edge cases:

**Good — one path:**

```
items = config.items ?? []
config.items = isArray(items) ? filter(items, fn) : []
```

**Bad — preserves ambiguity nobody needs:**

```
if config.items exists:
    if isArray(config.items):
        config.items = filter(config.items, fn)
    else:
        config.items = []
```

"What if it's not set?" → Make it set. Problem solved.

## No leaking a cohesive concern across files

A cohesive concern lives in ONE module — a single source of truth. Do not scatter one responsibility's logic across the files that happen to touch it; leakage is what happens when a concern grows a piece wherever it was locally convenient instead of in its own home.

The shape: an ENGINE module owns the logic; thin CALLERS invoke it and apply the result; CONFIG holds its data; CONSUMERS surface or respect its output and never reimplement its rules. When extending the concern, add to its module — never inline a new branch of it where you happen to be editing.

**Worked exemplar:** the spawn steering engine. `harnessrouting.ts` owns every model/usage/effort steer decision and the steering message text; `create-agent.ts` is a thin caller that fetches inputs, invokes the engine, and applies the result; `config.ts` holds only the data (allowed sets, thresholds); the todo skills surface the engine's messages to the person reading them instead of duplicating the rules that produced them.

## Apply fixes across siblings, not just the one named

When the user asks you to change one file, look for sibling/parallel files that need the same change. If `build-prod-win.sh` swaps to a baseline target, `build-prod-all.sh` almost certainly needs the same swap. If you rename a function, every doc and test that references it changes too. If you fix a config in `staging.yaml`, `production.yaml` probably needs the same fix.

Don't stop at the literal file the user named. Find every place the pattern lives and update them in lockstep — or explicitly call out anything you're deliberately leaving alone, so the user can confirm scope.

The failure mode: user asks you to fix X, you fix only X, they come back and ask you to fix Y, then Z. Each "you missed one" round costs the user more time than just doing it thoroughly the first time. It also signals that you stopped thinking the moment you handled the literal request, instead of asking "what else does this imply?".

The discipline: after making a change, grep for the old pattern across the repo. Scan sibling/parallel files. In your reply, list what you also changed and what you deliberately left alone. Default to over-applying and asking, not under-applying and waiting to be corrected.

## Naming user-facing actions

**Every user-facing action MUST state its target in the name.** This applies to: CLI commands and their `--help` text, TUI menu entries, button labels, slash commands, RPC handlers, scheduled-job names — anything a human reads to decide whether to invoke it. The reader should never have to open `--help`, the docstring, or the source to know WHAT the action operates on.

❌ Bad — target ambiguous:

- `Audit: line items must use the standard cost-center codes` (audits what?)
- `dev-cli bom-verify-values` (verifies WHERE?)
- `dev-cli paths-ensure-libtable` (ensures it on what?)

✅ Good — target baked in:

- `Audit project(s): line items must use the standard cost-center codes`
- `dev-cli verify-bom-values-in-projects`
- `dev-cli ensure-shared-library-paths-in-projects`

The pattern is `<verb>-<object>-in-<target>` for commands and `<Verb> <target>: <details>` for menu entries — adapt to the project's surrounding style, but always make the target unambiguous on first read. Exempt: actions whose target is implicit from the surrounding context (e.g. a file browser's "download" button when only one file is downloaded at a time).

## Tests never depend on a lock for isolation

**A test may TEST a lock. A test may never DEPEND on a lock for its own
isolation.** Locks are production behaviour under test, never test-harness
infrastructure.

So `recipient-pane-lock.service.spec.ts` and the `AsyncSerialGate`
serialization specs are fine and should exist — their subject IS the lock. A
box-wide guard that refuses a second test run so the suite does not trip over
itself is not.

**A lock in a test harness is always a workaround for shared state that was
never parameterised.** Every instance found in this repo resolved to the same
underlying fix — give the run its own copy of the thing:

| Shared state | The lock was standing in for |
|---|---|
| herdr tabs | `THRONE_HERDR_SESSION_NAME_OVERRIDE` — a per-run session with its own server, socket and tab namespace |
| redis | a per-suite compose project with its own network namespace and no host port publish |
| the live throne root | `THRONE_LIVE_ROOT`, already parameterised |
| scratch directories | `mkdtemp` roots, already per-run unique |
| generated systemd units | a unit name carrying `process.pid` and `Date.now()`, already unique |

When a test seems to need a lock, the question is not "how do I serialize
this?" but **"what shared thing did I fail to give this run its own copy
of?"** Serializing hides the coupling and makes it permanent; parameterising
removes it.

The cost of getting this wrong is not a slow suite. A lock that serializes
tests is load-bearing in a way nobody documents, and when it is eventually
removed the contention it was silently holding back surfaces as **renamed
failing tests in an unrelated campaign** — indistinguishable from a real
regression, debugged by someone with no idea the lock ever existed.

Exception, and it must be named explicitly rather than assumed: a resource
with **no isolation mechanism available at all** (e.g. a per-uid tmpfs quota,
which containers share because they run same-uid). Bound those with a
documented concurrency cap whose rationale lives in a comment **on the
constant** — not in a runbook, not in a queue entry. The person who raises
that number for speed will be reading the constant and nothing else.
