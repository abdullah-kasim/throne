---
name: pr-media
description: Capture screenshots and a click video of a UI change with agent-browser, write an index.html contact sheet of the folder, and publish the folder to a GitHub pull request, replacing the media the PR body already carries. Use when a PR needs screenshots, a screen recording, a GIF, or "before and after" images, when the user says "take screenshots of your changes", "record a video of pressing it", "add media to the PR", or "publish the screenshots to the PR", or as `/pr-media publish <pr>`. Covers github.com and GitHub Enterprise.
version: 2.0.0
user-invocable: true
---

# PR media

GitHub's image and video attachments are `user-attachments` uploads.
Since gh 2.99 (2026-09-01) `gh pr edit --attach <file>` makes them on
github.com and GitHub Enterprise Cloud, rewriting a local-path reference
in the body to the uploaded URL in place; there is still no REST or
GraphQL endpoint, and GitHub Enterprise Server refuses `--attach`, so on
a GHES PR the user drops the files into the editor once and the publish
wizard sorts the uploads into place afterwards; no browser is driven. This skill has two
modes: **capture** (sections 1 to 3) produces the files, stages them in
one folder with an `index.html` contact sheet, and drafts the
`## Screenshots` section LOCALLY as `screenshots.md` in that folder;
capture never edits the pull request. **Publish** (section 4) writes
that section into the live body, uploads the folder's latest files and
replaces whatever the anchors held before. Lord, 2026-09-16: "do not
update the PR description if you're not asked to publish it".

**Never commit media to a git branch as a workaround.** Not a `media/`
branch, not `docs/`, not a release asset. Binary blobs are permanent
repository weight and the decision is the user's alone; ask for explicit
approval in chat before any such commit, and expect the answer to be no.

## 1. Capture with agent-browser

Load `agent-browser skills get core` first. Always use a named session.
Set a fixed viewport so every capture has the same size:

```bash
export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix media)"
agent-browser open <url> && agent-browser wait --load networkidle
agent-browser set viewport 1400 900
```

A change that a phone can reach gets a second set of captures at the
phone viewport, iPhone 16, 393x852 (`agent-browser set viewport 393
852`), named `<name>-phone.png` and `<part>-phone.mp4` beside the desktop
ones; the recording at that size shows the whole viewport. Not 320x720:
the Lord ruled on 2026-09-14 that it was too small and limiting.

One screenshot per place the change is visible. Hover the element first
when the hover state is part of the change, and scope the shot to the
container so the reader sees the context, not the whole page:

```bash
agent-browser wait 3000                       # let async tables fill; networkidle is not enough
agent-browser scrollintoview "#container"
REF=$(agent-browser snapshot -i | grep -m1 '<link text>' | grep -o 'ref=e[0-9]*' | cut -d= -f2)
agent-browser hover "@$REF"
agent-browser screenshot "#container" ~/tmp/pr-media-<pr>/<name>.png
```

`<name>` starts with its order number (`01-table-path-link`); see section
2 for the rule.

An element screenshot of something inside a scrolling container paints
the clipped part black. For those, screenshot the viewport and crop to
the element's box instead:

```bash
BOX=$(agent-browser get box "#container" --json)      # .data.{x,y,width,height}
agent-browser screenshot ~/tmp/viewport.png
ffmpeg -y -i ~/tmp/viewport.png -vf "crop=W:H:X:Y" ~/tmp/pr-media-<pr>/<name>.png
```

Video of an interaction uses `agent-browser record` (needs `ffmpeg`;
`agent-browser doctor` checks). Headless capture has no mouse pointer and
no address bar, so inject `cursor-overlay.js` beside this file first (this skill ships with the throne under `.claude/skills/pr-media/`, and every court tab exports `THRONE_LIVE_ROOT`, so the two helpers are addressed through it): it
draws a URL bar across the top showing `location.href` (kept current on
pushState and popstate) and a cursor that follows the mouse events
agent-browser dispatches and shrinks on mousedown. Then move the pointer
with `glide.sh`, which eases the real mouse from the viewport centre to
the target over about two seconds of `mouse move` calls, so hover states
fire along the way and the viewer watches the cursor travel:

```bash
CUR="$(cat "$THRONE_LIVE_ROOT/.claude/skills/pr-media/cursor-overlay.js")"
GLIDE="$THRONE_LIVE_ROOT/.claude/skills/pr-media/glide.sh"
agent-browser scrollintoview "#container"     # the recording shows the viewport as it is
agent-browser eval "$CUR"
agent-browser mouse move 700 450              # park at the centre so the glide starts there
agent-browser record start ~/tmp/pr-media-<pr>/<part>.mp4
agent-browser wait 700
"$GLIDE" "<css selector of the target>" 24    # eased sweep, 24 steps
agent-browser wait 900
agent-browser mouse down && agent-browser wait 350 && agent-browser mouse up   # not `click`
agent-browser wait 1400
agent-browser record stop
```

Press, hold, release instead of `click` whenever the target navigates or
opens a tab. `click` sends the press and the release in the same instant,
the new tab takes focus before the page paints another frame, and the
ripple never reaches the video (two takes proved it: the ring was in the
DOM, the recording showed nothing). A 350 ms hold gives the ring about
ten frames while the page still has focus. The glide has already parked
the pointer on the target, so the press lands where the glide ended.

`glide.sh` takes a CSS selector, not an `@ref`, because it resolves the
target's centre with `getBoundingClientRect()` inside the page. It
scrolls the target into view first: a target above the viewport gives a
negative centre, the glide runs off-screen, and a `click` that has to
scroll mid-recording landed nowhere in two takes out of three. After a
click that should open a tab, assert it did (`agent-browser tab`, look
for the expected host) before recording the opened page, and resolve the
tab id from that listing rather than assuming `t2`.

The overlay also draws a click ripple: on mousedown a ring expands and
fades over 700 ms around the pointer and the cursor shrinks, so the
press itself is visible. Three facts about the recorder shape how that
overlay is written and how a take is run:

- **Frames come from Chrome's screencast and only when the page
  repaints on the main thread.** Compositor-only changes, meaning CSS
  `transform` or `opacity` transitions and Web Animations API
  animations, produce no frames; the last frame is held and the change
  is simply absent from the video. The ripple therefore animates
  `width`, `height`, `left`, `top` and colours from a
  `requestAnimationFrame` loop, and the press shrinks the SVG's
  `width`/`height`, never `transform`.
- **A page that repaints continuously records nothing.** A
  `requestAnimationFrame` loop running for the whole take produced zero
  screencast frames and `record stop` failed with "Output file does not
  contain any stream". Keep in-page animation brief, and never leave a
  perpetual animation running while recording.
- **Use a fresh namespace per recording session.** A daemon reused
  across many `open` / `close --all` cycles stopped delivering frames
  for input-driven changes while still saving a file, so the ripple
  silently vanished. `AGENT_BROWSER_NAMESPACE=<take>` with a new name
  per session costs nothing. Always read `record stop --json` and check
  `capturedFrames`: a clip with an interaction in it and a count under
  about 10 did not capture the interaction.

One clip per page. A recording is bound to the document it started on:
navigate in the same tab and the frames freeze, so stop, navigate,
re-inject the cursor, and start the next clip. Show the interaction in
every place the change appears (a table row and a detail header are two
clips), then join the clips with ffmpeg `-f concat`.

A click that opens a new tab is invisible in the clip that recorded the
click, so follow it with a clip of the opened tab (see the
`ERR_BLOCKED_BY_CLIENT` note above for the launch flag that makes local
dev hosts render). Confirm the tabs really opened with `agent-browser
tab` before claiming so.

Tab switching uses ids from `agent-browser tab` (`tab t2`), not indexes.

`ERR_BLOCKED_BY_CLIENT` on a local dev host such as `*.example.test` is not
a wall. `agent-browser network requests` shows what happened: a `GET
http://host/` followed by `GET https://host/`. Chrome 112+ upgrades
main-frame `http://` navigations to `https://` (HTTPS Upgrades; the
`HttpsUpgradesEnabled` policy definition in the Chromium tree documents
it) and exempts only non-unique hostnames such as `localhost`, `.local`
and private IP ranges, which is why `localhost` loads and a public
`.site` name resolving to 127.0.0.1 does not. Chrome would silently fall
back to `http://` when the `https://` attempt fails, but the dev stack's
self-signed certificate is not a network failure: the daemon, launched
without certificate errors ignored, aborts the response, and that abort
is what surfaces as "blocked by client" and pre-empts the fallback.
Launch the daemon with certificate errors ignored, in a namespace of its
own so an existing daemon without the flag is not reused:

```bash
export AGENT_BROWSER_SESSION=media-https
agent-browser --namespace media-https --ignore-https-errors open <url>
```

Every later command in that session passes `--namespace media-https`.
The flag applies at daemon launch only; adding it to a later command
changes nothing. Show the page the click opened: after the click, `tab
<id>` to the new tab, inject the overlay again (it is a new document),
and record a few seconds of it as its own clip. A result card is the
fallback only when the target genuinely cannot render.

Read every capture back (the Read tool on the png, `ffmpeg -sseof -0.5
-frames:v 1` for a video's last frame) before handing it over. A blank
frame or a stale build in the shot is worse than no shot.

End the capture by writing the contact sheet, one page that shows every
image and video in the folder (a `.md` cannot play a video locally, so
it is HTML):

```bash
node "$THRONE_LIVE_ROOT/.claude/skills/pr-media/contact-sheet.mjs" ~/tmp/pr-media-<pr>
```

It writes `~/tmp/pr-media-<pr>/index.html`: one section per file in
name order, the file name as heading, an `<img>` or a `<video controls>`
with a relative `src`, and the caption the PR body will carry. No
external assets, so it opens from Finder or with `open
~/tmp/pr-media-<pr>/index.html`. Open it in agent-browser and read the
screenshot back; publish refreshes it.

## 2. Stage and hand over

All files in one folder, named for what they show, `<pr>` in the folder:

```
~/tmp/pr-media-99/
  index.html
  01-table-path-link.png
  02-trace-header-path-link.png
  03-path-cell-click.mp4
```

**Every file name starts with a two-digit order number and a dash**
(`01-`, `02-`, ... `10-`; Lord, 2026-09-16), in the order the body shows
them: name order is then the body order, the contact-sheet order and the
video drop order in the wizard, and none of it can drift when a file is
added later. A phone variant keeps its own number (`04-table-path-link-phone.png`)
rather than sharing its desktop twin's. The number never reaches the
reader: alt text and captions strip it (`![table path link](./01-table-path-link.png)`).
Publish warns on stderr about any file without the prefix and still
proceeds, so an older folder can be re-published.

`<pr>` is the PR number, or the ticket key until a number exists (rename
the folder once the PR is open; publish defaults to
`~/tmp/pr-media-<number>`). Accepted media: `.png .jpg .jpeg .gif .webp
.svg .mp4 .mov .webm`, images at most 10 MB, videos at most 100 MB, the
limits gh enforces. Then, in the final message:

- Send the files with SendUserFile so they render in the conversation.
- Give a link that opens the contact sheet on the user's machine:
  `file:///Users/<user>/tmp/pr-media-99/index.html`, plus the command
  `open ~/tmp/pr-media-99/index.html` in a fenced block.
- List which file goes where in the body, and say that `/pr-media
  publish 99` writes the section and uploads them; the PR has not been
  edited yet.

## 3. Draft the Screenshots section — locally, never on the PR

Write `~/tmp/pr-media-<pr>/screenshots.md`: the whole `## Screenshots`
section as it should read on the PR, between `## How` and `## Testing`
(see the `pr-description` skill). The content is wrapped in the
collapsible spoiler `pr-description` describes as the default:
`<details><summary>Screenshots</summary>`, a blank line, the captures,
a blank line, `</details>`, with the `## Screenshots` heading itself
outside the wrapper. One sentence of context per file, then an anchor
pair named for the file, with a local-path reference inside:

```markdown
## Screenshots

<details>
<summary>Screenshots</summary>

Trace header, hovered:

<!-- pr-media: 01-trace-header-path-link.png -->
![trace header path link](./01-trace-header-path-link.png)
<!-- /pr-media: 01-trace-header-path-link.png -->

</details>
```

A video gets the same shape (`![path cell click](./03-path-cell-click.mp4)`
alone in its paragraph); publish turns it into the bare asset URL that
GitHub renders as a player. Everything between `<!-- pr-media: <name>
-->` and `<!-- /pr-media: <name> -->` belongs to publish: it is replaced
wholesale on every publish, so a re-publish swaps the earlier upload for
the new one without touching the human text around it. The alt text is
the file name without its `NN-` order prefix and with dashes as spaces;
that is also the caption. The anchors keep the full file name, prefix
included, so an anchor is renamed when a file is renumbered.

**The PR description is not touched in capture mode.** No `gh pr edit`,
no live-body patch, not even to place anchors: a capture that has not
been asked to publish leaves the PR exactly as it found it (Lord,
2026-09-16: "do not update the PR description if you're not asked to
publish it"). The draft file is what publish applies: when
`screenshots.md` exists in the folder, publish replaces the live body's
`## Screenshots` section with it wholesale (or inserts it before
`## Testing` when there is none), then rewrites the anchors with the
uploaded URLs. Every earlier anchor, placeholder or loose upload in the
old section goes with it, so the draft must carry every file the folder
holds. The previous placeholder form, `<!-- drop <name> here -->`, is
still recognised and converted to an anchor pair on publish, and a file
with neither is appended to `## Screenshots`.

When publish edits the body it always patches the LIVE one, never a
local copy: `gh pr view <n> --json
body -q .body > live.md`, edit that text,
`gh pr edit <n> --body-file live.md`, delete the file. A
`user-attachments` URL lives only on GitHub: republishing a stale local
file erases the uploads (it happened on 2026-09-09, three minutes after
the user dropped them). If it has already happened, GraphQL
`pullRequest(number){ userContentEdits(first:80){ nodes{ editedAt diff }
} }` returns every prior body in full and the asset URLs stay valid, so
the original `<img … src="…/user-attachments/assets/…">` tags and bare
video URLs go back verbatim.

Useful facts, verified against GHE 3.20 with `gh api -X POST /markdown
-f mode=gfm -f text=...`: `<video>` tags are stripped, so a video is
only ever a `user-attachments` upload; images are not proxied through
camo on that host.

## 4. Publish

```
/pr-media publish <pr-url|number> [--folder <dir>] [--dry-run]
```

```bash
node "$THRONE_LIVE_ROOT/.claude/skills/pr-media/publish.mjs" <pr-url|number> [--folder <dir>] [--dry-run]
```

A URL gives the host, repository and number; a bare number resolves the
repository from the current checkout (`gh repo view`) and the folder
defaults to `~/tmp/pr-media-<number>`. What the script does, in order:

1. Lists the folder's media files in name order and refuses before any
   upload when the folder is empty or missing, a file is empty, an
   image is over 10 MB or a video over 100 MB.
2. Reads the LIVE body: `gh pr view <n> -R <host>/<owner>/<repo> --json
   body -q .body`. Never a local copy. When the folder holds
   `screenshots.md` (section 3), the live `## Screenshots` section is
   replaced with it before anything else happens, spoiler wrapper and
   all: the whole section is a span from `## Screenshots` to the next
   `## ` heading, so a wrapped draft passes through unchanged; the
   summary line says so.
3. Rewrites the anchors: an existing `<!-- pr-media: <name> -->` pair is
   replaced with a fresh `![alt](./<name>)`, an old `<!-- drop <name>
   here -->` placeholder becomes a pair, a file with neither is appended
   inside `## Screenshots`. A pair whose file is no longer in the folder
   is left exactly as it is and reported, never deleted.
4. Runs ONE edit from inside the folder, for github.com and GitHub
   Enterprise Cloud:

   ```bash
   gh --bypass pr edit <n> -R <host>/<owner>/<repo> --body-file live.md \
     --attach './<image>#<alt>' --attach ./<video> …
   ```

   One `--attach` per file; the alt after `#` is the file name with
   dashes as spaces and is given to images only (gh refuses alt text on
   a video). gh matches a body reference to an attached file by absolute
   path, which is why the references are `./<name>` and the command runs
   with the folder as its working directory; it uploads each file and
   rewrites the reference to the `user-attachments` URL in place, a
   standalone video embed becoming the bare URL that plays. On a
   github.com target the script refuses when gh is older than 2.99
   (`brew upgrade gh`).
5. Re-fetches the body and verifies every anchor pair holds exactly one
   `user-attachments` URL and no local path, prints `name -> URL` for
   each file, deletes `live.md`, and rewrites `index.html`.

`--dry-run` prints the rewritten body and the exact gh command and sends
nothing; the body on GitHub is unchanged.

**The `--bypass` rule.** In a court tab the throne's `bin/gh` guard sits
on PATH and denies every GitHub mutation. Publishing is the one
Lord-ordered mutation this skill is allowed to make, so the script
prepends `--bypass` as the FIRST argument for the `pr edit` call, and
only when the `gh` first on PATH is that guard (it reads the file for
the guard's marker; a plain gh would reject the flag). Use `--bypass`
for nothing else: not to open, close, merge or comment on a PR, and
never by hand as a way around the guard. The `pr view` reads need no
bypass.

**GitHub Enterprise Server fallback: the upload wizard.** `--attach`
refuses a GHES host (verified on GHES 3.20), and no browser is driven
for this: the user uploads by hand in the PR editor, unsorted, and the
script sorts the uploads into their anchors afterwards. Two steps:

1. `--wizard` prints the drop list and sends nothing:

   ```bash
   node "$THRONE_LIVE_ROOT/.claude/skills/pr-media/publish.mjs" <pr-url> --folder <dir> --wizard
   ```

   Relay it through the harness's question tool (AskUserQuestion in
   Claude Code, or the equivalent blocking prompt of the harness in
   use), never as plain chat. This holds for a campaign Alpha too: when
   the Lord filed the publish objective himself, that filing is his
   authorization for exactly this question, and the Alpha blocks on it
   in its own pane and waits for his answer (Lord, 2026-09-16: "launch
   an alpha that blocks me with a Q&A since you've received my
   authorization"); it is the one question an Alpha may put to him.
   The question is the drop list itself: the question is the drop list itself, the
   options are "Uploaded and saved" (recommended), "Skip publishing",
   and "Stop", and nothing runs until the user answers. A wizard that
   only prints instructions gets scrolled past, and a collect step run
   before the upload refuses with a misleading "no loose upload"
   (Lord, 2026-09-16). The list tells the user to open the PR, edit the
   description, put the cursor on an empty line under `## Screenshots`,
   drop every file from the folder, wait until each upload has become
   an `<img>` tag or a link, and press **Update comment**. A drop landing outside the Screenshots spoiler is fine: the collect step
   below moves every loose upload into its anchor inside the wrapper.
   Images may go in any order because GitHub keeps the file stem as the `alt`
   text. A video becomes a bare URL with no name, so when the folder
   holds more than one video the list says to drop them one at a time
   in the order given, and the collect step maps videos by that order.
   Only the "Uploaded and saved" answer leads to step 2.
2. After that answer, `--collect` reads the LIVE body, gathers
   every `user-attachments` reference that is not already inside an
   anchor pair (`<img … alt="…" src="…">`, `![…](…)` or a bare URL on
   its own line), maps images to files by stem and videos by order,
   removes those loose copies, rewrites the anchors with the URLs (image
   markdown for an image, the bare URL for a video), edits the body with
   `--body-file` and no `--attach`, and verifies the same way as the
   github.com path:

   ```bash
   node "$THRONE_LIVE_ROOT/.claude/skills/pr-media/publish.mjs" <pr-url> --folder <dir> --collect
   ```

   It refuses, changing nothing, when a file in the folder has no loose
   upload in the body; a loose upload with no matching file is removed
   and named in the summary. Re-running the wizard later replaces the
   earlier uploads the same way the github.com path does.
   `--asset <name>=<url>` remains for a URL obtained some other way;
   every file needs one, or it refuses.
