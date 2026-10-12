---
name: pr-open
description: 'Open a pull request (Forgejo, github.com or GitHub Enterprise) in the user''s editor with `throne forge open`. Invoked by /pr-open <pull request url, number or branch> (alias: /open-pr), or when the user says "open PR <url> in vscode", "open this PR in my editor", "open pull request N" or "open this PR in vscode <url>".'
user-invocable: true
---

# Open a pull request in the editor

Run the one command with the pull request the user named, then report the
path it prints:

```bash
throne forge open <pull request url, number or branch>
```

Add `--editor <command>` only when the user names an editor other than their
default, and `--print` only when they want the path without an editor.

## Example

The user says "open https://github.com/example-bakery/recipe-box/pull/58 in
vscode". Run:

```bash
throne forge open https://github.com/example-bakery/recipe-box/pull/58 --editor code
```

and answer with the path it printed: a review worktree beside the local
clone, such as `recipe-box-pr-58`.
