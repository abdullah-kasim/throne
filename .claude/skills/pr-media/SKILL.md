---
name: pr-media
description: Capture before and after screenshots and click videos of a UI change with agent-browser, one on the PR's base and one on its head, write an index.html contact sheet that shows each pair side by side, and publish the folder to a GitHub pull request, replacing the media the PR body already carries. Use when a PR needs screenshots, a screen recording, a GIF, or "before and after" images, when the user says "take screenshots of your changes", "record a video of pressing it", "add media to the PR", or "publish the screenshots to the PR", when the user asks to refresh, regenerate or redo the PR media or screenshots, or as `/pr-media publish <pr>`. Covers github.com and GitHub Enterprise.
version: 2.3.0
user-invocable: true
---

# PR media

GitHub's image and video attachments are `user-attachments` uploads.
Since gh 2.99 (2026-09-01) `gh pr edit --attach <file>` makes them on
github.com and GitHub Enterprise Cloud, rewriting a local-path reference
in the body to the uploaded URL in place; there is still no REST or
GraphQL endpoint, and GitHub Enterprise Server refuses `--attach`, so on
a GHES PR publish uploads each file through a signed-in agent-browser
session, the same comment-box upload a person makes by dragging a file
in, and then edits the body with gh (section 4). This skill has two
modes: **capture** (sections 1 to 3) produces the files, stages them in
one folder with an `index.html` contact sheet, and drafts the
`## Screenshots` section LOCALLY as `screenshots.md` in that folder;
capture never edits the pull request. **Publish** (section 4) writes
that section into the live body, uploads the folder's latest files and
replaces whatever the anchors held before. Lord, 2026-09-16: "do not
update the PR description if you're not asked to publish it".

Every state and interaction the PR changes is captured twice, once on
the PR's base (**before**) and once on its head (**after**), and the two
are shown side by side: a two-column table in the contact sheet and in
the PR body. A capture that shows only the after leaves the reviewer to
remember what the page looked like.

**Every interaction the PR changes or adds is recorded as a video**: a
click, a drag, a resize, an expand or collapse, a navigation or
transition, a keyboard path. The after is always recorded; the before
is recorded when the base has an equivalent interaction. Stills support
videos, never replace them. A folder with no video is wrong unless the
PR changes no interaction at all: static styling, copy or colour only,
and then publish needs `--stills-only "<reason>"` (section 4). Phone
captures follow the same rule at 393x852. Lord, 2026-10-02: "Videos are
missing - /pr-media must include videos".

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
852`), named `NN-<what>-phone-before.png` / `NN-<what>-phone-after.png`
(and `.mp4` for a clip) with their own order number; the recording at
that size shows the whole viewport. Not 320x720:
the Lord ruled on 2026-09-14 that it was too small and limiting.

### Before and after, side by side

Serve the base and the head at the same time on two ports, for example
a second checkout of the base commit (`git worktree add
~/tmp/pr-media-<pr>-base <base-sha>`) running the dev server on one
port and the PR branch on another. Keep one agent-browser session per
side (`--prefix media-before`, `--prefix media-after`) and drive both
through the same steps, the same data, the same viewport and the same
theme, capturing each state on the base and then on the head before
moving to the next state. Everything below (viewport, cursor overlay,
glide, press-hold-release, a fresh namespace per take, reading every
capture back) applies to both sides unchanged.

- A control that does not exist on the base still gets a before: the
  same screen in the same state on the base, showing its absence.
- A before video is needed only when the base has an equivalent
  interaction. When it has none, the pair is a before screenshot and an
  after video under one stem (`05-coupon-apply-before.png` beside
  `05-coupon-apply-after.mp4`), and the before cell shows the
  screenshot.
- Name both sides `NN-<what>-before.<ext>` and `NN-<what>-after.<ext>`;
  section 2 has the full rule.

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

`<name>` starts with its order number and ends with its side
(`01-cart-total-before`); see section
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

It writes `~/tmp/pr-media-<pr>/index.html`: one section per pair or
single file in order. A pair is a two-column table, Before then After,
with an `<img>` or a `<video controls playsinline>` in each cell; below
about 600px wide the columns stack with the before first, which keeps
it readable on a 393-wide phone. A single is shown as before: the file
name as heading, the media, and the caption the PR body will carry.
Every `src` is relative, the page follows the system's dark mode, and
there are no external assets, so it opens from Finder or with `open
~/tmp/pr-media-<pr>/index.html`. Open it in agent-browser and read the
screenshot back; publish refreshes it.

## 2. Stage and hand over

All files in one folder, named for what they show, `<pr>` in the folder:

```
~/tmp/pr-media-99/
  index.html
  screenshots.md
  01-cart-total-before.png
  01-cart-total-after.png
  02-coupon-field-before.png
  02-coupon-field-after.png
  03-coupon-apply-before.mp4
  03-coupon-apply-after.mp4
  04-cart-total-phone-before.png
  04-cart-total-phone-after.png
  05-receipt-footer.png
```

**A before/after pair is two files sharing one `NN-<what>` stem**, one
ending `-before`, the other `-after`, before the extension; the two may
differ in extension (a before screenshot beside an after video). A file
with neither suffix is a single and is shown alone. The tools pair by
stem and always put the before first, even though `-after` sorts ahead
of `-before` in a file listing. A side whose partner is missing is
shown alone and publish names it on stderr; two files on the same side
of one stem are refused.

**Every file name starts with a two-digit order number and a dash**
(`01-`, `02-`, ... `10-`; Lord, 2026-09-16), in the order the body shows
them: the number order is then the body order, the contact-sheet order
and the video drop order in the wizard, and none of it can drift when a
file is added later. A pair's two files share one number; a phone
variant keeps its own (`04-cart-total-phone-before.png`) rather than
sharing its desktop twin's. The number never reaches the
reader: alt text and captions strip it (`![cart total before](./01-cart-total-before.png)`).
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
outside the wrapper. Inside it, every file sits in an anchor pair named
for the file, holding a local-path reference; publish owns everything
between the two markers. Pairs go in tables, each with its caption in
the row directly above it; singles keep one paragraph each:

```markdown
## Screenshots

<details>
<summary>Screenshots</summary>

Desktop 1400x900, dark theme:

<table>
<tr><th>Before</th><th>After</th></tr>
<tr><td colspan="2">

**1.** The cart total, with a coupon applied: the after shows the discount line.

</td></tr>
<tr>
<td>

<!-- pr-media: 01-cart-total-before.png -->
![cart total before](./01-cart-total-before.png)
<!-- /pr-media: 01-cart-total-before.png -->

</td>
<td>

<!-- pr-media: 01-cart-total-after.png -->
![cart total after](./01-cart-total-after.png)
<!-- /pr-media: 01-cart-total-after.png -->

</td>
</tr>
<tr><td colspan="2">

**2.** Applying a coupon: nothing happens before; after, the total updates in place.

</td></tr>
<tr>
<td>

<!-- pr-media: 02-coupon-apply-before.mp4 -->
![coupon apply before](./02-coupon-apply-before.mp4)
<!-- /pr-media: 02-coupon-apply-before.mp4 -->

</td>
<td>

<!-- pr-media: 02-coupon-apply-after.mp4 -->
![coupon apply after](./02-coupon-apply-after.mp4)
<!-- /pr-media: 02-coupon-apply-after.mp4 -->

</td>
</tr>
</table>

The receipt footer, unchanged in layout:

<!-- pr-media: 05-receipt-footer.png -->
![receipt footer](./05-receipt-footer.png)
<!-- /pr-media: 05-receipt-footer.png -->

</details>
```

- **Every pair: a row in an HTML `<table>`, with its caption in the row
  directly above it.** One table per group (desktop, phone, a theme),
  one heading line above the table naming the group, a header row
  `<tr><th>Before</th><th>After</th></tr>`, then for each pair a caption
  row, `<tr><td colspan="2">`, holding one or two sentences that start
  with a bold order number (`**1.**`), followed by the pair's row. The
  Lord, 2026-09-25, on a numbered list printed above a table of shots:
  "this isn't particularly readable ... It should inline those
  bulletpoints with the screenshot's table." Never write the captions as
  a separate list; a reader must not count rows to match a sentence to a
  shot. Write the number in bold rather than as `1.`, which renders as a
  one-item list restarting at the cell's edge.
- **Blank lines inside every cell.** Each `<td>` holds its content on its
  own lines with a blank line above and below, the caption as well as
  the anchor pair on its own three lines. GitHub renders Markdown inside
  a cell (an image, a code span, bold) only when the cell's content is
  set off by blank lines.
- **Images and videos share the form.** Publish turns a video's
  reference into the bare asset URL, and GitHub renders a bare URL as a
  player only when it sits alone in its own paragraph. Rendered on
  2026-09-25 with `gh api -X POST /markdown -f mode=gfm` against a real
  uploaded video: in a Markdown table cell the bare URL became a player
  on github.com but a plain link on GitHub Enterprise Server 3.20; in the
  HTML `<td>` with blank lines around it, both hosts rendered a
  `<video controls>` in each cell, side by side. So every pair uses the
  HTML form, and a pair of a before screenshot and an after video sits in
  the same table as the image pairs around it. To check a draft renders,
  pass the repository as context (`-f context=<owner>/<repo>`): without
  it the API renders a bare video URL as a link on both hosts.
- **Older drafts** that put image pairs in a `| Before | After |`
  Markdown table with inline one-line anchor pairs still publish:
  publish keeps a table-row anchor pair on one line when it rewrites it,
  and its verification fails loudly if one ever spans several lines.
  Convert them to the form above when you next touch them.
- **Singles** keep one sentence of context, then the anchor pair on
  three lines, alone in its paragraph; a single video becomes a player.

Everything between `<!-- pr-media: <name> -->` and
`<!-- /pr-media: <name> -->` belongs to publish: it is replaced
wholesale on every publish, so a re-publish swaps the earlier upload for the new one
without touching the human text around it. The alt text is the file
name without its `NN-` order prefix and with dashes as spaces (`cart
total before`); that is also the caption in the contact sheet. The
anchors keep the full file name, prefix included, so an anchor is
renamed when a file is renumbered.

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
/pr-media publish <pr-url|number> [--folder <dir>] [--dry-run] [--replace-all] [--wizard | --collect] [--stills-only "<reason>"]
```

```bash
node "$THRONE_LIVE_ROOT/.claude/skills/pr-media/publish.mjs" <pr-url|number> [--folder <dir>] [--dry-run] [--replace-all] [--stills-only "<reason>"]
```

**A folder with no video is refused.** Right after listing the folder,
before it reads the body or uploads anything, publish refuses a folder
that holds no video, with a message naming the video rule (top of this
file) and `--stills-only`. The refusal is the same in every mode: a
plain publish, `--wizard`, `--collect`, and `--dry-run`, which reports
it as the refusal the real run would be. The way out is
`--stills-only "<reason>"`, for a PR that changes no interaction: the
reason is required and must not be empty (a missing reason, or an
option where the reason should be, is refused too), it says why there
is nothing to record, and publish prints it in its summary.

```bash
node "$THRONE_LIVE_ROOT/.claude/skills/pr-media/publish.mjs" 99 --folder ~/tmp/pr-media-99 --stills-only "copy change only, no interaction"
```

### Refreshing the media

"Refresh", "regenerate" or "redo" the media on a PR means, by default:
capture a new set, publish it, and remove every earlier capture from the
body. Keeping earlier captures in the body needs the user to ask for it.
Lord, 2026-09-28: "if we want to refresh the media, then it means that
we regenerate and publish and get rid of the old screenshots. We can
reuse the Before images though - no problem with that".

- **A new folder.** A refresh never captures into the old folder; it
  starts a new one beside it, for example `~/tmp/pr-media-99-v2` after
  `~/tmp/pr-media-99`, laid out and numbered as in section 2.
- **Every AFTER is fresh.** Each `-after` file is captured again from
  the PR's current head.
- **A BEFORE may be reused.** A `-before` file may be copied from the
  previous folder, under its number in the new folder, when the new pair
  shows the same view on the same base. Anything else is captured again.
- **The draft carries every file.** The new folder's `screenshots.md`
  (section 3) holds an anchor pair for every file in it, so publish
  replaces the whole `## Screenshots` section and every earlier anchor
  and upload inside it leaves the body. `--replace-all` removes the rest:
  every anchor pair and `<!-- drop <name> here -->` placeholder elsewhere
  in the body whose file is not in the new folder, with what it holds.

  ```bash
  node "$THRONE_LIVE_ROOT/.claude/skills/pr-media/publish.mjs" 99 --folder ~/tmp/pr-media-99-v2 --replace-all
  ```

  The summary names what it removed on one line,
  `removed, not in the folder: 03-coupon-apply-before.mp4, 03-coupon-apply-after.mp4`,
  and `--dry-run` prints the same line without sending anything.
- **Confirm the old names are gone.** After publishing, check that no
  file name the previous folder had, and the new folder does not, is
  still in the live body. A reused BEFORE that kept its name is the new
  folder's own file and is left out of the check. No output means the
  refresh is complete:

  ```bash
  body=$(gh pr view 99 --json body -q .body)
  comm -23 <(ls ~/tmp/pr-media-99 | sort) <(ls ~/tmp/pr-media-99-v2 | sort) | while read -r name; do grep -F -- "$name" <<<"$body"; done
  ```

  For a PR outside the current checkout, add `-R <host>/<owner>/<repo>`
  to the `gh pr view`.

### What publish does

A URL gives the host, repository and number; a bare number resolves the
repository from the current checkout (`gh repo view`) and the folder
defaults to `~/tmp/pr-media-<number>`. What the script does, in order:

1. Lists the folder's media files in body order (pairs by stem, each
   before just ahead of its after) and refuses before any
   upload when the folder is empty or missing, a file is empty, an
   image is over 10 MB or a video over 100 MB, or no file is a video
   and `--stills-only` was not given.
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
   inside `## Screenshots`. An anchor or placeholder that sits in a
   Markdown table row (its line starts with `|`) is written inline on
   one line; everywhere else it keeps the three-line layout. A pair whose
   file is no longer in the folder is left exactly as it is and reported,
   never deleted, unless `--replace-all` is given: then that pair, and
   any `<!-- drop <name> here -->` placeholder naming a file not in the
   folder, is removed with what it holds wherever it sits in the body,
   and the summary names each one, `removed, not in the folder: <name>`.
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
   (`brew upgrade gh`). On GitHub Enterprise Server the files are
   uploaded first through the browser (below), and the same edit runs
   with `--body-file` and no `--attach`.
5. Re-fetches the body and verifies every anchor pair holds exactly one
   `user-attachments` URL and no local path, and that no anchor pair in
   a table row spans several lines, and, with `--replace-all`, that no
   anchor names a file outside the folder, failing loudly on a survivor;
   it then prints `name -> URL` for each file, deletes `live.md`, and
   rewrites `index.html`.

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

**GitHub Enterprise Server: upload through a signed-in browser.**
`--attach` refuses a GHES host (verified on GHES 3.20), so a plain
`publish.mjs <pr-url>` on a GHES host uploads with `browser-upload.mjs`
beside this file, then makes the one body edit with gh. The Lord asked
for this on 2026-09-25 because hand uploads did not scale: "We're gonna
do the agent-browser way." What it does:

1. **Proxy.** A GHES host is often reachable only through a proxy. One
   lookup serves the browser and every gh call: `PR_MEDIA_BROWSER_PROXY`,
   then `HTTPS_PROXY` or `ALL_PROXY`, then git's own per-host setting,
   `git config --get-urlmatch http.proxy https://<host>`. Set that once
   and nothing else needs an environment variable:
   `git config --global http.https://<host>.proxy socks5h://127.0.0.1:<port>`.
   Chrome is given `socks5://` where the setting says `socks5h://`.
2. **Saved sign-in.** The browser runs in its own agent-browser
   namespace, `pr-media-<host>`, with a persistent profile at
   `~/.config/throne/agent-browser/<host>`, so a sign-in survives between
   runs, including the cookies a cookie export would miss. Each run opens
   the PR headless and reads `<meta name="user-login">`. When it is empty,
   because there was never a sign-in or the session expired, the script
   closes the headless browser, opens a visible window on the host's
   sign-in page, and polls every three seconds, for up to
   `PR_MEDIA_SIGN_IN_WAIT_SECONDS` (600 by default), until the meta tag
   names a user. Nobody has to report back that they signed in. It then
   reopens headless on the same profile and proves the sign-in stuck.
3. **Upload, one file at a time.** On the PR page it empties the
   comment box, `#new_comment_field`, hands the file to its file input,
   `#fc-new_comment_field`, and polls the box until it holds a
   `user-attachments` URL and no `[Uploading …]()` placeholder: an image
   arrives as `<img … src="…">`, a video as a bare URL. One file per
   round keeps the mapping from file to URL exact, so no stem or drop
   order is guessed. The wait is a minute plus two seconds per megabyte.
   The box is emptied after every file and in a `finally`, and nothing
   is ever posted.
4. **Edit.** The URLs go to the same path `--asset <name>=<url>` takes,
   and the body is edited and verified as on github.com.

Only one browser can hold a profile. A second publish to the same host
while one is running fails with a message naming the profile; wait, or
run `agent-browser close --all`. When the page layout changes and the
comment box or its file input is gone, the script says so and names the
fallback below. `--dry-run` uploads nothing and reports how many files
the browser would send.

**GitHub Enterprise Server fallback: the upload wizard.** When the
browser path cannot run (no display for the sign-in window, a changed
page layout), the user uploads by hand in the PR editor, unsorted, and
the script sorts the uploads into their anchors afterwards. Two steps:

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
   text. A video becomes a bare URL with no name, so the list names
   every file in body order, a before just ahead of its after, marks the
   videos, and says to drop the videos one at a time in that order; the
   collect step maps videos by that order.
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
