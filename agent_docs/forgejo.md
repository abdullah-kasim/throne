# Forgejo: a tailnet-only forge for readable pull requests

Forgejo is an optional, self-hosted GitHub-like forge that the throne can run
beside ntfy. It exists to make pull requests readable: rendered diffs
(unified and side-by-side), markdown descriptions, and image and video
attachments that play inline, all reachable from a phone on the tailnet. It
is **tailnet-only**: the container is published on the Tailscale address and
on loopback for the HTTPS front, never on `0.0.0.0`. Loopback cannot be
reached from another host.

It is **only a staging area**: nothing is merged in Forgejo. A pull request
reaches GitHub through `/pr-promote` on the Lord's word and is merged there;
its Forgejo pull request is then closed with a comment saying it was merged
on the GitHub side (`throne forge close-merged-twin`, see
`agent_docs/commands.md` `## forge`).

It is **optional**. A plain `./install.sh` or `install-services` run never
pulls, renders, enables or starts anything Forgejo. Only
`install-forgejo.sh` turns it on.

## How install-services decides

One fact decides it on both platforms: the install marker
`${XDG_STATE_HOME:-$HOME/.local/state}/forgejo/enabled` exists. Only
`install-forgejo.sh` writes it (`src/install-services/forgejo-installation.ts`).

- Marker present: `install-services` renders `systemd/forgejo.service` and
  runs `systemctl --user enable --now forgejo.service` on linux
  (`linuxUnitsForHost` in `src/install-services/linux.ts`), or renders
  `launchd/com.throne.forgejo.plist` and bootstraps it on a mac
  (`darwinAgentsForHost` in `src/install-services/darwin.ts`).
- Marker absent: Forgejo is left out of the service set entirely. Removing the
  marker later does not remove a unit that is already installed; it only stops
  the next `install-services` run from rendering and enabling it again (see
  "Remove Forgejo alone" below).

Because the marker survives `./install.sh`, every later `./install.sh` keeps an
installed Forgejo's unit current.

## Install

Run it by an agent, from the **live checkout**, after `./install.sh` has built
`dist/`:

```bash
I_AM_AN_AGENT=1 ./install-forgejo.sh
```

The live checkout matters: the installer calls `install-services`, which
refuses a linked worktree so a unit is never baked to a disposable path.
Preconditions it checks and refuses on with a clear message: `node` and
`dist/src/tools.js`, a docker-compatible CLI reaching its engine (`docker`,
or bare `podman` when no `docker` is installed; `THRONE_CONTAINER_RUNTIME=<name>`
names another), Tailscale installed (on PATH,
or the `Tailscale.app` CLI on a mac) holding a tailnet IPv4, and a MagicDNS
name for the host. Tailscale is never installed for you.

What a run does, in order:

1. Pulls the pinned image, `vendor-pins.json` `tools.forgejo.image`
   (`codeberg.org/forgejo/forgejo:<release>-rootless`). A stamp in
   `vendor/.stamps/forgejo-image` skips the pull when the pin has not moved;
   `--force` pulls again.
2. Fronts Forgejo with HTTPS: `tailscale serve --bg --https=8443
   http://127.0.0.1:8421`, skipped when `tailscale serve status --json`
   already shows that exact proxy. A front that proxies anywhere else, such
   as an older `http://<tailnet-ip>:8420`, is replaced. If `tailscale serve`
   fails, the run warns and Forgejo stays on plain http.
3. Writes `config/app.ini` on the first run only (below).
4. Writes the install marker.
5. Runs `install-services`, which renders and starts the unit.
6. Waits about two minutes (120 tries a second apart) for
   `http://<tailnet-ip>:8420/` to answer.
7. Creates the admin user if it does not exist yet.
8. Creates the admin's API token if `api-token` does not exist yet, then
   checks that Forgejo accepts it (below).
9. Installs the pinned `tea` CLI at `~/.local/bin/tea` unless that binary
   already reports the pinned version (below).
10. Adds the tea login `forgejo` unless tea already has a login by that name.
11. Prints the URLs, the admin login and where the password and token are.

Re-running is idempotent: app.ini, the data, the marker, the admin user, the
API token and the tea login are never rewritten. Re-run it after a `git pull` that moves the pin, then
`systemctl --user restart forgejo.service` so the new image is served.

## URLs

| URL | When |
| --- | --- |
| `https://<magicdns-name>:8443/` | the HTTPS front was configured (`:443` is left for other services on the host) |
| `http://<magicdns-name>:8420/` | always |
| `http://<tailnet-ip>:8420/` | always |

All three are tailnet-only. `systemd/forgejo-serve` publishes
`<tailnet-ip>:8420` and `127.0.0.1:8421` to the container's port 3000; the
HTTPS front proxies to the loopback one. The two addresses need different
ports because a podman machine refuses one host port on two addresses
(`rootlessport conflict`). The MagicDNS name is read at
install time from `tailscale status --self --json` (`.Self.DNSName`) and is
never committed. `ROOT_URL` in app.ini is the https URL when the front was
configured on the first run, otherwise the http MagicDNS URL; links Forgejo
generates, clone URLs included, use it.

## Staged pull requests and the metadata comment

A pull request reaches Forgejo one of two ways. One the court opens itself
lands there through `throne forge pr create`. One that is already on GitHub is
staged with:

```bash
throne forge stage <github pull request url>
```

run from the local checkout, with the head branch fetched
(`git fetch origin <head>:<head>`; the command refuses and names it
otherwise). It opens the Forgejo pull request with the GitHub title and body,
re-hosts the body's GitHub images and videos as Forgejo attachments, mirrors
the GitHub review feedback once, and prints
`{"githubUrl","twinUrl","created"}`. It writes nothing to GitHub. Running it
again on a staged pull request opens nothing and prints `"created": false`.

Every Forgejo pull request title names its GitHub twin, right after any
`WIP: ` draft prefix (a draft is a title matching `^wip:\s*`, so nothing
may come before it): `WIP: [GH-123] Add the export button`. A pull
request with no GitHub twin yet carries `[GH-##]` in the same place. The
forge code sets it: `pr create` on Forgejo titles a new pull request with
`[GH-##]`, `stage` opens the twin with the GitHub number, and every `stage`
and `promote` run that knows the GitHub URL sets the number on the Forgejo
title, replacing `[GH-##]`, restoring a marker edited away by hand, and
never doubling it. The title `promote` sends to GitHub has the marker removed.

Everything that links the two twins lives in one place: a single metadata
comment on the Forgejo pull request, written by the Forgejo admin. Its first
line, `GitHub: <url>`, is the visible link; below it, hidden records hold the
GitHub URL, the head last promoted and the Forgejo answers already carried
back. `stage`, `promote` and repromote rewrite that comment in place. Neither
pull request's body carries a record, and GitHub never learns that Forgejo
exists: no text the court sends there names the Forgejo host or carries a
record. A GitHub URL is matched to its twin by reading Forgejo alone.

`throne forge status <url|number|branch> --json` prints where one pull
request stands on both forges. Read `stage` (`forgejo-only`, `promoted`,
`github-only`, `merged-on-github` or `closed`) to learn whether it has a
GitHub twin yet, `publishTo` to learn where media and replies for it go (a
GitHub URL is always `github`), and `mergeTarget` for the GitHub pull request
a merge lands on; a pull request that was never promoted has `mergeTarget`
`null` and the reason in `mergeTargetRefusal`. The exact shape and every
operation are in `agent_docs/commands.md` `## forge`.

To read a staged pull request locally, `throne forge open <url|number|branch>`
opens it in the editor: it reuses a clean worktree already at its head, or
creates a detached review worktree fetched from the checkout's `forgejo`
remote when Forgejo holds the head (`origin` otherwise). The `/pr-open` skill
runs it.

## Keeping Forgejo copies current

A Forgejo pull request's diff is only right while Forgejo's copy of its base
matches GitHub's. Three things keep the copies in step, and none of them ever
force-pushes, deletes a branch, or pushes to GitHub:

- **Every base refresh fetches first.** `throne forge push-branch`, `pr create`
  and `ensure-repository` fetch the base from `origin` with an explicit refspec
  before they compare or push it, and refuse when that fetch fails, so a stale
  local clone never puts a stale base in Forgejo.
- **`throne forge sync-branches [--repo <path>]`** brings every GitHub branch
  of one repository onto its Forgejo copy, by creating or fast-forwarding it
  only, the bases of open pull requests first. A branch that diverged, or that
  Forgejo holds ahead of GitHub, is left alone and reported; a branch only
  Forgejo has is never touched. It makes the Forgejo copy first when the
  repository has none.
- **The backend's branch mirror** runs that sync for every repository that
  already has a Forgejo copy.

The command, its outcomes, its JSON and its exit codes are in
`agent_docs/commands.md` `## forge`.

### The branch mirror in the backend

A hosted worker in the throne backend, registered beside the backend's other
hosted workers, runs once when the backend starts (without delaying the
backend's start-up) and then every 10 minutes. Each run:

- does nothing at all, no git process and no API call, when the host's
  forge is `github` (the `hostForge` that `throne forge status` reports),
  which is when the install marker is absent.
  Forgejo installed but not answering is a failure: logged, never thrown.
- does nothing, and logs that it skipped, when the previous run is still
  going. A first sync of a repository with a couple of hundred branches can
  outlast a tick.
- syncs each repository it finds, one after another. Each repository's
  failure is caught and logged and the next repository is still synced;
  nothing a sync does can stop the backend. It logs one line per repository
  with how many branches were created, fast-forwarded or diverged and any
  open pull request whose base is not current.
- never creates a Forgejo copy; it only syncs copies that already exist.

Forgejo is always reached directly, never through a proxy a checkout's or the
global git config sets, so a checkout whose `http.proxy` tunnels everything to
another host still mirrors.

Its log lines go where the backend's do:
`journalctl --user -u throne-backend.service` on linux, `~/.throne/logs/throne-backend.log`
on a mac.

### How the mirror finds each repository's checkout

A sync runs in a local clone, so the worker needs the checkout behind each
Forgejo copy. Every forge command that resolves a repository's Forgejo copy
from a local checkout (`ensure-repository`, `push-branch`, `pr create`,
`sync-branches`) records the copy's `<owner>/<name>` and the checkout's
absolute path in a registry file in the state directory that "Where the
data lives" describes. Each run lists the admin's repositories from the Forgejo API and
looks each one up in that registry. A repository with no recorded checkout,
or whose checkout is gone or no longer has a `forgejo` remote, is logged and
skipped.

The registry is the source, rather than the queue's target repositories,
because a queue row's target is not always the clone that holds the
`forgejo` remote (a row can target a linked worktree of a bare-backed clone),
and because the registry is written by the same code that creates the remote,
so every copy made from now on is found without a second record to keep in
step.

A Forgejo copy made before the registry existed is skipped until a forge
command runs in its checkout. Register it, and sync it straight away, by hand:

```bash
throne forge sync-branches --repo <checkout>
```

## Where the data lives

Everything is under one state directory, the same place systemd's
`StateDirectory=forgejo` names for the user unit, beside ntfy's and
conduwuit's:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/forgejo/
  config/app.ini                mounted at /etc/gitea (GITEA_APP_INI=/etc/gitea/app.ini)
  data/                         mounted at /var/lib/gitea, the image's work path
    data/                       Forgejo's app data path
      forgejo-repositories/     repositories, as <owner>/<repo>.git
      forgejo.db                SQLite database, with forgejo.db-wal and forgejo.db-shm beside it
      attachments/              uploaded images and videos
    git/                        the image user's home directory, empty
    custom/                     Forgejo's custom directory for overrides, empty
  admin-password                mode 0600
  api-token                     the admin's API token, mode 0600
  enabled                       the install marker
```

app.ini sets no `[repository] ROOT` or `[database] PATH`, so Forgejo's
defaults apply. Its v16.0 configuration cheat sheet
(<https://forgejo.org/docs/v16.0/admin/config-cheat-sheet/>) gives
`APP_DATA_PATH` as "AppWorkPath/data", `ROOT` as
"%(APP_DATA_PATH)s/forgejo-repositories" and the SQLite `PATH` as
"data/forgejo.db". That is why everything lives one `data/` deeper than the
mount. The image creates `git/` (its `HOME`) and `custom/` (its
`GITEA_CUSTOM`) on every start. Neither holds repositories or configuration
here: app.ini is in `config/`. Forgejo also keeps avatars, search indexes,
queues and its signing keys under `data/data/`.

Every file belongs to the user who runs the unit. `forgejo-serve` picks the
user mapping from what `<cli> version` reports, never from the CLI's name: a
CLI that reports itself as `Podman Engine` (podman, or podman's own `docker`
wrapper) runs the container with `--userns=keep-id:uid=1000,gid=1000` (the
image's own user); any other CLI runs it with `--user=$(id -u):$(id -g)`,
because the Docker CLI refuses `keep-id` ("--userns: invalid USER mode") even
when podman's API is behind it. A server section that names no engine gets
the same `--user` mapping and a line in the log saying what it reported. The
directory is mode 0700.

## Back it up

The simplest consistent backup is a copy taken while Forgejo is stopped (the
SQLite database runs in WAL mode, so a copy of a running instance can be torn):

```bash
systemctl --user stop forgejo.service
cp -a "${XDG_STATE_HOME:-$HOME/.local/state}/forgejo" ~/forgejo-backup-$(date +%F)
systemctl --user start forgejo.service
```

Or let Forgejo build an archive while it runs. Forgejo's upgrade guide for
v16.0 lists "forgejo dump to collect everything into one zip file" and notes
"there is no need to dump SQLite because the database itself is included in
the zip file already". Inside the container the work path is `/var/lib/gitea`,
so this lands at `data/forgejo-dump.zip` in the state directory (use `docker`
in place of `podman` on a docker host):

```bash
podman exec throne-forgejo forgejo dump --file /var/lib/gitea/forgejo-dump.zip
```

## Configuration and attachment limits

`install-forgejo.sh` writes `config/app.ini` once, mode 0600, and never again:
an existing file is kept as-is on every re-run. Edit it by hand and restart
the unit to change anything. What the first run writes:

- `[database] DB_TYPE = sqlite3`.
- `[server]` `DOMAIN` (the MagicDNS name), `ROOT_URL`, `HTTP_PORT = 3000`,
  `DISABLE_SSH = true` and `START_SSH_SERVER = false`: there is no SSH, push
  over HTTP.
- `[service] DISABLE_REGISTRATION = true`: only the admin creates accounts.
- `[repository] DEFAULT_REPO_UNITS = repo.code,repo.releases,repo.pulls`: new
  repositories start without the issue tracker and wiki (a repository's
  settings can turn them on).
- `[actions] ENABLED = false` and `[packages] ENABLED = false`.
- `WORK_PATH`, `[security] INSTALL_LOCK`, `SECRET_KEY`, `INTERNAL_TOKEN` and
  `[oauth2] JWT_SECRET`, so Forgejo has nothing to generate and append to the
  file on its first start.
- Attachments for pull requests and issues:

  ```ini
  [attachment]
  ENABLED = true
  ALLOWED_TYPES = .png,.jpg,.jpeg,.gif,.svg,.webp,.mp4,.webm,.mov
  MAX_SIZE = 500
  ```

Forgejo's v16.0 configuration cheat sheet defines `ALLOWED_TYPES` as a
"Comma-separated list of allowed file extensions (.zip), MIME types
(text/plain), or wildcard types (image/*, audio/*, video/*). Empty value or */*
allows all types", `MAX_SIZE` as "Maximum size (MB)" (default 2048), and
`MAX_FILES` as "Maximum number of attachments that can be uploaded at once"
(default 5). To allow another type or a bigger file, edit those lines and run
`systemctl --user restart forgejo.service`.

## The admin user

The admin's full name and email come from the `identity` section of
`config.user.ts`, read through `bin/throne-cli git-identity`. The login name is
the email's local part, lower-cased, with every run of characters other than
`a-z` and `0-9` turned into one `-` and leading and trailing `-` trimmed
(`Example.Admin+forge@…` logs in as `example-admin-forge`). The password is
generated, printed once by the run that creates the user, and stored in
`admin-password` (mode 0600). A re-run finds the user and leaves it alone.

## The API token

`${XDG_STATE_HOME:-$HOME/.local/state}/forgejo/api-token` holds one access
token for the admin user, mode 0600, beside `admin-password`. It is the only
Forgejo credential store: the `throne forge` command reads this file for every
Forgejo API call, and the tea login was added with it. Nothing writes the
token anywhere else, and the installer never prints it.

The first run that finds no `api-token` creates the token inside the running
container with
`forgejo admin user generate-access-token --username <admin> --token-name throne-forge --scopes all --raw`
and writes it with mode 0600. `all` covers repositories, issues, pull
requests, the user endpoint and markdown rendering. It grants no more than
`admin-password` beside it already does. An existing file is never rewritten.
Every run, the first included, sends `GET /api/v1/user` with the token to
`http://<tailnet-ip>:8420/`. If Forgejo refuses it, the run stops with a
message saying how to replace it, and leaves the file alone.

Rotate it:

1. Signed in to Forgejo as the admin, open Settings > Applications and delete
   the token `throne-forge`. A token with that name blocks creating a new one.
2. Delete the file and the tea login that holds the old token:

   ```bash
   rm "${XDG_STATE_HOME:-$HOME/.local/state}/forgejo/api-token"
   ~/.local/bin/tea logins delete forgejo
   ```

3. Re-run `I_AM_AN_AGENT=1 ./install-forgejo.sh` from the live checkout. It
   creates a new token and adds the login again.

## tea

[tea](https://gitea.com/gitea/tea) is the Gitea and Forgejo command line, the
counterpart of `gh`. It is installed so the Lord, or an agent working by hand,
can list, check out and open pull requests in the local Forgejo from a
terminal. The court's own pull-request work goes through `throne forge`, which
calls the Forgejo HTTP API directly and does not need tea.

`vendor-pins.json` `tools.tea` pins the release and the sha256 of each
platform's binary (`linux-amd64`, `linux-arm64`, `darwin-amd64`,
`darwin-arm64`). The installer downloads
`https://gitea.com/gitea/tea/releases/download/v<version>/tea-<version>-<platform>`
into `${XDG_CACHE_HOME:-$HOME/.cache}/throne/tea/<version>/`. It refuses the
download unless its sha256 matches the pin, and reuses a cached copy whose
sha256 matches. It installs only a verified copy, to `~/.local/bin/tea`.
A run skips all of this when `~/.local/bin/tea --version` already reports
the pinned version.

`~/.local/bin` is the user's own executables directory under the XDG base
directory layout. It is outside the repository, so every campaign worktree and
every shell resolves the same tea. It is also one of the two directories
`install-services` links the `throne` command into (`~/bin` is the other), so
a host set up for the throne normally has it on PATH. The installer calls tea
by its full path and does not depend on that.

The login is named `forgejo`. It points at `ROOT_URL` from `config/app.ini`
and uses the token from `api-token`, passed to `tea login add` in the
`GITEA_SERVER_TOKEN` environment variable so it never appears on a command
line. tea keeps its logins in its own config file
(`~/.config/tea/config.yml`). Check it with `~/.local/bin/tea logins list`.

Where each pinned sha256 came from (tea v0.16.0, checked 2026-10-07): the
release's published
<https://gitea.com/gitea/tea/releases/download/v0.16.0/checksums.txt>, lines
`tea-0.16.0-linux-amd64`, `tea-0.16.0-linux-arm64`, `tea-0.16.0-darwin-amd64`
and `tea-0.16.0-darwin-arm64`. Each binary was also downloaded from the URL
above and hashed with `sha256sum tea-0.16.0-*`, and each hash matched its
`checksums.txt` line. `file` reported ELF x86-64, ELF aarch64, Mach-O x86_64
and Mach-O arm64 respectively, and the linux-amd64 binary's `--version`
printed `0.16.0`. To move the pin, repeat those two steps for the new tag and
replace the version and all four sha256 values together.

## Inspect and restart

```bash
systemctl --user status forgejo.service
systemctl --user restart forgejo.service
journalctl --user -u forgejo.service -n 100 -f
podman ps --filter name=throne-forgejo
```

On macOS:

```bash
launchctl print gui/$(id -u)/com.throne.forgejo
launchctl kickstart -k gui/$(id -u)/com.throne.forgejo
tail -f ~/.throne/logs/forgejo.log
```

`systemd/forgejo-serve` refuses to start when `config/app.ini` is missing, so
a stray unit never exposes Forgejo's first-run web installer. It waits up to
60 seconds for an interface to hold the address `tailscale ip -4` reports, and
exits non-zero when that address, Tailscale, the container runtime, `node` or
the pin is missing, so the
service manager retries. The runtime comes from
`systemd/container-runtime-ensure`: a runtime whose `info` answers, `docker`
before `podman` (`THRONE_CONTAINER_RUNTIME=<name>` forces one). When none
answers, on a mac it starts the installed one once, under a `flock` lock shared
with ntfy, and on either platform it waits up to 180 seconds
(`THRONE_CONTAINER_RUNTIME_WAIT_SECONDS`) before the script exits non-zero.
The retry policy: `Restart=on-failure`, `RestartSec=5s`, at most 5
starts in 60 seconds, `TimeoutStartSec=70` on linux; `KeepAlive` on an
unsuccessful exit with `ThrottleInterval` 10 on a mac.

## Undo the HTTPS front

```bash
tailscale serve --https=8443 off
```

Then set `ROOT_URL = http://<magicdns-name>:8420/` in `config/app.ini` and
restart the unit, or Forgejo keeps generating links to the https URL.

## Remove Forgejo alone

Linux:

```bash
rm "${XDG_STATE_HOME:-$HOME/.local/state}/forgejo/enabled"
systemctl --user disable --now forgejo.service
rm "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/forgejo.service"
systemctl --user daemon-reload
```

macOS:

```bash
rm "${XDG_STATE_HOME:-$HOME/.local/state}/forgejo/enabled"
launchctl bootout gui/$(id -u)/com.throne.forgejo
rm ~/Library/LaunchAgents/com.throne.forgejo.plist
```

Removing the marker first keeps the next `./install.sh` from bringing it back.
Optionally delete the data, the image (`docker rmi` on a docker host) and the
HTTPS front too:

```bash
rm -rf "${XDG_STATE_HOME:-$HOME/.local/state}/forgejo"
podman rmi codeberg.org/forgejo/forgejo:<tag in vendor-pins.json>
tailscale serve --https=8443 off
```

To drop tea as well:

```bash
~/.local/bin/tea logins delete forgejo
rm ~/.local/bin/tea
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/throne/tea"
```

`./uninstall.sh` instead takes Forgejo down with the rest of the throne: it
stops and removes `forgejo.service` or `com.throne.forgejo` and the
`throne-forgejo` container, and leaves the state directory (marker and API
token included), the image and the HTTPS front, printing the command that
removes each. A later `./install.sh` therefore brings Forgejo back with its
data.

It also keeps tea and its `forgejo` login and prints the command that removes
them. The login carries the API token that lives in the kept data, so it still
works when `./install.sh` brings Forgejo back. tea at `~/.local/bin` is a
general command on the user's PATH, and removing it would break a tool the
user may be using against the kept data. Only tea's download cache,
`${XDG_CACHE_HOME:-$HOME/.cache}/throne/tea`, is removed, as herdr's is.

## macOS

First run on a Mac on 2026-10-08, with the Docker CLI on a podman machine
context. What that run taught:

- `forgejo-serve` reads the image pin with the node named in
  `FORGEJO_NODE_BIN`, and refuses to start when it is unset. Both the
  LaunchAgent and the linux unit pass the mise install of the node version
  pinned in the throne root's mise.toml; it never falls back to the node on
  PATH.
  An earlier `sed` parse used a GNU-only `{...p}` block that BSD sed refuses,
  and the LaunchAgent restarted it every 10 seconds.
- When the service will not come up, read `~/.throne/logs/forgejo.log`
  and `launchctl print gui/$(id -u)/com.throne.forgejo`. Stop a restart loop
  with `launchctl bootout gui/$(id -u)/com.throne.forgejo`; start it again with
  `launchctl kickstart -k`, or re-run the installer. The installer names these
  two on a Mac when Forgejo does not answer, and `systemctl` on linux.
- `docker` may be the Docker CLI talking to podman's API (`docker context ls`).
  The Docker CLI cannot pass podman's `keep-id`, so it gets the `--user`
  mapping. Files still land as the Mac user, because the podman machine's
  shared folders show every file as the host user.
- The HTTPS front proxies to loopback because `tailscaled` on macOS cannot
  reach its own tailnet address: a front pointed at `http://<tailnet-ip>:8420`
  accepts the TLS request, then hangs and logs "proxy error: context canceled"
  while plain http on port 8420 answers. Re-running the installer moves such a
  front to `http://127.0.0.1:8421`.
- When the Docker CLI reports only `unable to upgrade to tcp, received 500`,
  the podman engine's reason is in the machine's log:
  `podman machine ssh 'journalctl --user -u podman.service --no-pager'`.
