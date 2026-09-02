# Suppressing Claude Code's first-run modals for a throne-scoped spawn

> **SUPERSEDED IN PART — 2026-08-16. THE MEASUREMENTS BELOW STILL HOLD; THE
> CHOSEN MECHANISM DOES NOT.**
>
> This document's analysis of the three modals and what gates each one remains
> accurate and was re-confirmed. **What changed is the delivery mechanism.**
>
> **Throne no longer sets `CLAUDE_CONFIG_DIR` and no longer builds a per-spawn
> config seed.** Each seed presented to the account as a separate client
> installation on one credential, which expired logins aggressively — three
> agents wedged on `Login expired` in a single evening, seven seed directories
> live at once. A throne-spawned agent now runs against the account's REAL
> config, exactly as a human session does.
>
> The two permission modals (1 and 2 below) are already suppressed by the
> account's own `~/.claude/settings.json`, which carries
> `skipDangerousModePermissionPrompt` and `skipAutoPermissionPrompt`.
>
> The untrusted-folder modal (3 below) is still gated per project path, and is
> now granted by writing `projects.<path>.hasTrustDialogAccepted` into the real
> `~/.claude.json` at launch — see `src/claude-spawn-trust/claude-worktree-trust.ts`.
> That write is locked, atomic (write-then-rename), idempotent, and refuses
> rather than launching an agent into a modal nobody can see.
>
> **Sections below describing a seeded `CLAUDE_CONFIG_DIR` as the remedy
> describe history, not current behaviour.** Read them for what they establish
> about the modals, not for what throne does.

Claude Code v2.1.232 shows up to three distinct startup modals the first time
it runs against a given account/config state or a given project path. Each
one steals pane focus before the composer exists, so a queued opening prompt
has nowhere to land. Measured against the real `claude` 2.1.232 binary in a
scratch git worktree under `~/tmp`, never against the Lord's own checkout.

## The three modals, and what actually gates each one

1. **"WARNING: Claude Code running in Bypass Permissions mode."** Gated by
   the boolean setting `skipDangerousModePermissionPrompt` in
   `<config dir>/settings.json`. `--dangerously-skip-permissions` and
   `--allow-dangerously-skip-permissions` (what the launcher already passes)
   do **not** suppress it — they only select bypass mode, which is exactly
   what makes this modal fire. `--permission-mode bypassPermissions` doesn't
   suppress it either; same modal, same gate.
2. **"Make auto mode your default permission mode?"** Gated by a sibling
   boolean, `skipAutoPermissionPrompt`, in the same `settings.json`.
3. **Untrusted-folder trust prompt** ("Is this a project you created or one
   you trust?"). Gated per-project-path by `hasTrustDialogAccepted: true`
   inside `<config dir>/.claude.json`'s `projects["<absolute worktree
   path>"]` entry. A worktree path with no entry in `projects` always shows
   this modal regardless of any global setting.

None of the three is controlled by a CLI flag. `--permission-mode
bypassPermissions` is not sufficient on its own for any of them.

## `CLAUDE_CONFIG_DIR` relocates the entire config surface, not just settings

Setting `CLAUDE_CONFIG_DIR` does not layer on top of `$HOME/.claude.json` —
it moves the read/write location for **all** of it: `settings.json`,
`.claude.json` (onboarding state, `oauthAccount`, the `projects` map), and
`.credentials.json` (the OAuth token file; confirmed file-based here, not
keychain-only) all resolve under `<CLAUDE_CONFIG_DIR>/` instead of `$HOME/`.
Pointing `CLAUDE_CONFIG_DIR` at an empty throne-owned directory with `HOME`
otherwise real reproduces the **normal first-run installer flow** (theme
picker, then login method selection) — worse than either named modal, since
it has no queued-prompt landing point at all and additionally can't
authenticate non-interactively. The throne-scoped directory must be seeded,
not empty.

## The confirmed throne-scoped mechanism

Launch with the Lord's real `HOME` (so nothing about auth or account state
changes) and set `CLAUDE_CONFIG_DIR` to a **throne-owned directory, scoped to
that one spawn's worktree**, pre-seeded with:

- `settings.json`: `{"skipDangerousModePermissionPrompt": true,
  "skipAutoPermissionPrompt": true}`.
- `.claude.json`: the account-level fields copied from the Lord's own
  `~/.claude.json` (`oauthAccount`, `hasCompletedOnboarding`, `userID`, and
  siblings — copied values, never a live reference to the Lord's file) plus
  a `projects` map containing exactly one entry, keyed by the new worktree's
  absolute path, with `hasTrustDialogAccepted: true` and the other
  project-onboarding booleans set true.
- `.credentials.json`: copied byte-for-byte from the Lord's own
  `~/.claude/.credentials.json`.

Verified command and result — a brand-new git worktree Claude Code has never
seen, seeded `CLAUDE_CONFIG_DIR` pointed at a directory built as above,
`HOME` unchanged:

```
$ HOME="$HOME" CLAUDE_CONFIG_DIR="<seeded throne-owned dir>" \
    claude --dangerously-skip-permissions --allow-dangerously-skip-permissions
```

Pane content immediately after startup: the normal welcome banner and an
empty composer (`❯ Try "how does <filepath> work?"`) — no theme picker, no
login prompt, no bypass-mode warning, no auto-mode-default prompt, no trust
prompt. Contrast with the same worktree launched against the Lord's real,
unseeded `CLAUDE_CONFIG_DIR` (i.e. today's actual launch path): the trust
prompt appears immediately and blocks the pane until answered.

## Confirmation this touches nothing of the Lord's own

- The seed directory is a fresh throne-owned path, never `$HOME/.claude` and
  never `$HOME/.claude.json`.
- Every seed value is a **copy** taken once from the Lord's real files;
  nothing in the launch path writes back into `~/.claude.json`,
  `~/.claude/settings.json`, or `~/.claude/.credentials.json`.
- One probe in this recon deliberately used the Lord's real,
  un-redirected `CLAUDE_CONFIG_DIR` to reproduce the incident's exact
  conditions (confirming the trust modal fires today); that probe added one
  throwaway `projects` entry to the real `~/.claude.json`, pointing at a
  scratch worktree that no longer exists. That entry was removed by hand
  after the probe, and the file's project count and every other entry were
  left untouched.

## What this unblocks

Wiring this seed into the actual launch path — computing the worktree's
absolute path, building the seed directory once per spawn, and passing
`CLAUDE_CONFIG_DIR` through to the `claude` invocation — is separate work.
This document only pins the mechanism and its evidence.
