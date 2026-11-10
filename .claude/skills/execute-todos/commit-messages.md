# Commit messages

## Task-focused commit-message contract — single owner

This section is the one owning policy for every commit created by this workflow.
Planning skills, chained workflows, terminal gates, correction passes, reports,
checkpoints, and aliases inherit it by reference; they must not copy or weaken it.

A commit is signed with the Lord's identity (`config.user.ts` `identity`,
applied by the `bin/git` shim); a **STOP RIGHT THERE** from the shim means the
identity is unset or machine-local — report it upward and wait, never guess,
never set a global, never `--author` around it (AGENTS.md, "Git identity").
A commit message describes the repository change, never the machinery that caused
it. Apply the contract to the complete subject and body before every commit:

- Write a concise imperative subject naming the shipped task-domain behavior. An
  optional body may preserve useful technical detail: rationale, important
  implementation choices, compatibility effects, and concrete validation.
- Reject provenance or orchestration narration anywhere in the subject or body:
  todo-skill execution, workflow/campaign mechanics, Herdr, terminal tabs, agents,
  or the role names Alpha and Shadow. Do not mention assignment files, execution
  logs, slice/gate ceremony, supervisor messages, merge choreography, or who did
  the work.
- Reject campaign/objective identifiers and their abbreviations as commit scopes,
  tags, or prose (for example `BUD`, `CMG`, `docs(bud)`, or `checkpoint(cmg)`). A
  product acronym is allowed only when it is independently meaningful in the
  repository's task domain rather than provenance for this run.
- Do not erase technical specificity to satisfy the rule. `Fix retry backoff after
quota refresh` is better than `Update code`; `Validate retry timing with fake
timers` is valid detail. The forbidden axis is internal provenance, not precise
  engineering language.

The same check applies to every commit class: implementation, validation-only,
delivery/integration, corrective repair, report/documentation, checkpoint, and
all chained or aliased workflow commits. Examples:

| Class           | Accept                                         | Reject                             |
| --------------- | ---------------------------------------------- | ---------------------------------- |
| implementation  | `Enforce task-focused commit messages`         | `Run todo 01 commit-message work`  |
| validation      | `Cover commit-message rejection cases`         | `Record Shadow validation gate`    |
| delivery        | `Publish commit-message safeguards`            | `Deliver CMG campaign`             |
| correction      | `Preserve technical detail in commit subjects` | `Fix Alpha review finding`         |
| report          | `Document commit-message policy evidence`      | `Report Herdr execution results`   |
| checkpoint      | `Save commit-message policy baseline`          | `checkpoint(cmg): finish slice`    |
| chained / alias | `Apply commit-message policy across workflows` | `Run plan-and-execute agent chain` |

Before committing, inspect the final message exactly as Git will receive it. If
any rejected-axis term appears, rewrite the message around the shipped repository
behavior. A message that cannot explain the task-domain change without workflow
provenance is not ready to commit.
