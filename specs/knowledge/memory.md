# Memory and skill extensions
Summary: Finds each project's memory directory, recalls memories for a task, and prints operator skill extensions.
Code: src/memory-dir, src/memory-recall, src/skill-extension
Search words: memory-dir, recall, skill-extension, memory

## What it does

`memory-dir` prints the durable memory directory for the project containing a directory, deferring to a convention the project declares. `recall` prints the memories that apply to a task, most relevant first, when asked by hand; no hook runs it on prompts any more, and `recall --hook` is an unknown flag (exit 2, nothing printed). `recall --report` prints one line saying the prompt-submit hook was removed and there is nothing more to report, and exits 0. `skill-extension` prints the operator's extension to a skill from the throne home, or nothing.

## Sub-features

- ME-DIR: A project-declared convention outranks the default.
- ME-RECALL: Recall output is capped in size.
- ME-NO-HOOK: recall runs only by hand; --hook is refused and --report prints one line.
- ME-EXTENSION: A skill with no extension prints nothing.

## How to reach it and prove it works

```
throne memory-dir --json .
```

Prints one JSON object with `mode`, `path` and `repoRoot`; `repoRoot` is the main checkout even from a worktree. Exit 0.

## Gotchas

Worktrees of one project share one memory directory.
