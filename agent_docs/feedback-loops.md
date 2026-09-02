# Feedback loops — how to verify a change

Run every check from the throne root (the live checkout, e.g.
`~/repos/throne`).
Ordered by correctness signal: cheapest, most deterministic first; live smoke
runs last.

## 1. Typecheck — `npx tsc --noEmit`

```bash
npx tsc --noEmit
```

The fastest correctness gate. `tsconfig.json` is typecheck-only (Node runs the
`.ts` directly; there is no build). A green run catches type errors before
runtime. Note it does **not** catch Node strip-only-mode violations (`enum`,
`namespace`, parameter-properties, decorators) — those pass `tsc` but crash on
import, so also load the module (step 3) after touching class/enum shapes.

## 2. Unit tests — `node --test`

```bash
node --test
```

The hermetic suite in `test/` exercises the reliability rule via injected
dependency seams (no live herdr): the name resolver (single / zero / ambiguous
match), the herdr-presence guard (assert-herdr exit code both ways), and the
keep-going send guard (nudge fires exactly once on a single match, sends nothing
on zero or ambiguous). Add a test here for any new resolver or guard logic.

## 3. Command smoke runs — `./bin/throne-cli <cmd>`

Exercise the real code path against live herdr. Prove the failure paths, not just
the happy one — and never nudge a working orchestrator:

```bash
./bin/throne-cli assert-herdr                 # exits 0 inside herdr
./bin/throne-cli agent-statuses               # prints the live table
./bin/throne-cli agent-logs __nope__          # exits 1: unknown name
./bin/throne-cli send-agent __nope__ hi       # exits 1, sends nothing
./bin/throne-cli keep-going --name __nope__   # exits 1, sends nothing
```

To prove the assert-herdr non-zero path, run it with a PATH that shadows `herdr`
with a stub that exits 1 (so `herdr pane current` fails). For `create-agent` /
`spawn-git-tree`, verify against a throwaway target (a `--name validate-check`
agent, or a scratch worktree) and tear it down — never against the live Regent or
the live checkout.

## 4. systemd unit verification — `systemd-analyze verify`

```bash
systemd-analyze --user verify ~/.config/systemd/user/throne-backend.service
systemd-analyze --user verify ~/.config/systemd/user/sweep-tmp-scratch-home.timer
```

Validates unit syntax and directives without installing or enabling anything.
Green exit means the units are well-formed; do not `enable --now` just to test.

Verify the **installed** units, not the repo sources. `throne-backend.service`
is a template and `systemd-analyze` rejects its unsubstituted token — measured
on this host (against the since-retired `throne-keep-going.service`, same
template shape), `systemd-analyze verify ./systemd/<template>.service` exits 1
with `WorkingDirectory= path is not absolute: {{THRONE_ROOT}}` /
`Unit configuration has fatal error, unit will not be started.`, while the
installed-unit forms above exit 0 with no output. The repo-source timer form is
worse than useless: `systemd-analyze --user verify ./systemd/<pair>.timer`
exits **0** while still printing that same fatal error for the service it pulls
in — a green exit over a broken unit. (A timer itself carries no tokens; the
token that breaks the check lives in its service.)

On macOS the equivalent is `plutil -lint launchd/*.plist` for the sources
(tokens sit inside `<string>` values, so the raw templates lint clean) and
`launchctl print gui/$(id -u)/com.throne.throne-backend` for the installed
agent.
