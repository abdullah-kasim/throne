# Recovering from `/tmp` tmpfs EDQUOT (every agent's Bash dies at once)

The throne hits this repeatedly. Read this before diagnosing "Bash is broken".

## Recognising it

The tell is a **silent, universal Bash failure**: every call — including
`echo hello` — returns **exit 1 with no stdout and no stderr**. Alongside it,
any `Write` under `/tmp` returns `EDQUOT: unknown error, write`, while `Read`
and writes under `~/tmp` keep working.

`/tmp` on this box is a **tmpfs with per-user quotas** (kernel ≥6.6), measured
at **12769M on a 16G mount**. When the uid's slice is spent, tmpfs returns
`EDQUOT` no matter how much space the mount has left. The Claude Code Bash tool
stages its output capture under `/tmp/claude-<uid>/...`, so the shell never gets
to run — hence the empty output rather than an error message.

Once you have freed enough room to run a command, `quota -s` is the proof:

```
Filesystem   space   quota   limit
     tmpfs  11606M  12769M  12769M     <- pinned at the cap
```

Note the *files* columns read `0` — that means **no limit on file count**, not
zero files allowed. Read the **space** columns, and pick the large `tmpfs` line
(the small one is `/dev/shm`).

**This is a throne-shaped failure.** Every agent on the box — Regent, Alphas,
Shadows — shares one uid and therefore one quota. A single campaign that sprays
`/tmp` wedges the entire hierarchy simultaneously, and each wedged agent reports
only "Bash returns exit 1", which reads like a harness bug.

## Do not be talked out of it by `df`

Measured while completely wedged: `/tmp` 16G total, **3.2G available**, inodes
**49%** used. Neither bytes nor inodes were exhausted. Under quota, both numbers
are irrelevant. Two further red herrings on Bazzite:

- `/` at **100%** is composefs, the read-only ostree root. Always 100%. Normal.
- `btrfs` commands fail with `not a btrfs filesystem: /` — the root is composefs
  and `/var/home` is `/dev/dm-0`. Btrfs qgroups are not the mechanism here.
- `quota -s` printing nothing, or reporting `0`, does **not** exonerate quotas.
  Classic `quota(1)` reads filesystem quotas and cannot see tmpfs ones, and `0`
  conventionally means *no limit set*, not *zero bytes allowed*.

Compare with the neighbouring failure mode in
`claude/agent_docs/MEMORY/TMP_INODE_EXHAUSTION_VALIDATION_DEBRIS.md`: inode
exhaustion raises **`ENOSPC`** with `df -i` pinned at 100%. Different errno,
different fix.

## Triage with no shell at all

`Glob`/`Grep` may be absent from the session toolset and `Read` on a directory
errors, so you cannot even list a directory. You can still bisect in two calls:

1. `Write` to `~/tmp/probe.txt` — succeeds → `/var/home` is healthy.
2. `Write` to `/tmp/probe.txt` — `EDQUOT` → the tmpfs is the culprit.

Then hand the Lord a staged script per `claude/agent_docs/clipboard_commands.md`:
script into `~/tmp/<task>.sh`, output tee'd to `~/tmp/<task>.txt` that **you**
read afterwards. You cannot stage his clipboard either (that needs a shell), so
give him the literal `bash ~/tmp/<task>.sh` line and nothing to copy by hand.

## Cleanup rules that matter

- **Never delete the live session scratchpad**, `/tmp/claude-<uid>/<project>/<session-uuid>/`.
  The harness is running out of it. Exclude the current session UUID explicitly.
- **Age-gate and user-scope every deletion** (`-mmin +60 -user "$(id -u)"`) so
  concurrent Shadows' live scratchpads survive.
- **Unmount dead FUSE mounts first.** Stale AppImage mounts appear in `df` as
  `Transport endpoint is not connected` and **pin their backing directories**;
  `rm -rf` silently fails to reclaim the space until `fusermount -uz <mountpoint>`
  releases them. Observed offenders: `cromite`, `ghostty`, `rustdesk`
  — all soar-packaged `dwarfs` mounts (`mount | grep fuse.dwarfs`), each one
  shared and reference-counted across every concurrent invocation of that
  binary, not a per-run mount owned by the invoking script.
  `chrome-devtools-axi-cromite` and the project-issue-report renderer only
  `exec`/spawn the already-resolved binary path; neither creates or privately
  owns the mount, so neither can safely `fusermount -uz` it on its own exit
  without risking an unrelated concurrent user. Reclaiming a genuinely dead
  one is the reaper's job (liveness-checked via `/proc`, not a script-local
  exit trap).

A working recovery script is kept at `~/tmp/claude-tmp-cleanup.sh` when this
last fired; regenerate it from the rules above rather than trusting a stale copy.

## Prevention

Campaign scratch, renders, logs, and `node_modules` belong on `/var/home`
(`~/tmp`, effectively unlimited: 548G free), **never** the `/tmp` tmpfs. The
global `CLAUDE.md` already mandates `~/tmp` over `/tmp` for scratch files; this
document is why that rule has teeth. `chrome-devtools-axi-cromite`,
`chrome-devtools-axi-flatpak`, and the `project-issue-report` renderer were
audited (2026-08-08) and all already stage their own scratch under
`$HOME/tmp` — see `agent-launchers/bin/chrome-devtools-axi-cromite:115-125`,
`agent-launchers/bin/chrome-devtools-axi-flatpak:37-40`, and
`render_project_issue_report.py`'s `render_report()`. Its underlying CLI goes
through a flatpak install, not a soar/dwarfs AppImage, so it never mounts one. None
of these scripts create the shared `dwarfs` mounts covered above, so none of
them is the right place to unmount those.
