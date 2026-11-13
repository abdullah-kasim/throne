# Memory and skill extensions
Summary: Finds each project's memory directory, recalls memories for a task, and prints operator skill extensions.
Code: src/memory-dir, src/memory-recall, src/skill-extension
Search words: memory-dir, recall, skill-extension, memory, prompt kind

## What it does

`memory-dir` prints the durable memory directory for the project containing a directory, deferring to a convention the project declares. `recall` prints the memories that apply to a task, most relevant first, and serves the prompt hook. The hook classifies each prompt by kind; a prompt that opens with `<messageN>`, ends with `</messageN>`, or ends with the older `[message N]` is a relayed agent message, even when a paste wrapper surrounds it or its tail was cut. `skill-extension` prints the operator's extension to a skill from the throne home, or nothing.

## Sub-features

- ME-DIR: A project-declared convention outranks the default.
- ME-RECALL: Recall output is capped in size.
- ME-RELAYED: A prompt carrying a message tag or a trailing message number is classified as relayed.
- ME-EXTENSION: A skill with no extension prints nothing.

## How to reach it and prove it works

```
throne memory-dir --json .
```

Prints one JSON object with `mode`, `path` and `repoRoot`; `repoRoot` is the main checkout even from a worktree. Exit 0.

## Gotchas

Worktrees of one project share one memory directory.
