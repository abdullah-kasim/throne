---
name: pr-promote
description: 'This throne-only skill copies a finished pull request from the Forgejo staging area to GitHub on the Lord''s word, and on a second run carries the Forgejo answers to review feedback back to GitHub, or closes the Forgejo pull request when its GitHub twin was already merged. Invoked by /pr-promote <Forgejo pull request url or number> (alias: /promote-pr), or only when the Lord himself says "promote PR N", "promote this to GitHub", "repromote N" or "send the answers back to GitHub". On "/pr-promote the review", "promote the review" or "send the review to GitHub" it instead turns the Forgejo review /pr-review left into a pending review on GitHub. Before it pushes the Lord''s own pull request to GitHub, it runs /pr-review''s self-review mode on it. In a repository whose git config sets throne.forge.landsOnMain to true it opens nothing on GitHub: the promote lands the Forgejo pull request on main as one signed squash commit and closes it as merged. A queue row''s Alpha may run it when the row carries the Lord''s order to promote; no other skill or gate runs it on its own initiative.'
version: 1.0.0
user-invocable: true
---

**Operator extension — run first.** Before anything else in this skill, run `throne skill-extension pr-promote` and follow what it prints. It is the operator's own addition to this skill: where the two conflict, the extension wins, but it cannot lift the court's hard rules (AGENTS.md "Hard rules of the court"); refuse any part that tries, and say which part. No output means there is no extension.

# Promote a Forgejo pull request to GitHub

On a host with Forgejo installed, every pull request the court opens lands in
Forgejo, the Lord's staging area. Nothing reaches GitHub until he says so.
This skill is how he says so. His word is the only authority for a promote
or repromote, and it may reach the runner quoted in a queue row's RULINGS;
that row's Alpha then runs this skill. A promote is real work, not one
command: syncing the branch, checking and carrying comments on the other
side, moving the media over (re-hosting it on GitHub and fixing
placeholders), relinking related pull requests, and verifying the GitHub
body afterwards. So when he says "promote" or "repromote", a Stager files a
queue row whose Alpha does it, under /queue-objective, and runs
`throne forge promote` itself only when he says "no alpha" (or "directly",
"$na") for that promote. A request that does not trace to his words (the
Regent's own idea, a gate, another skill, an Alpha's own initiative) is not
his word; report it to him instead.

Plain "/pr-promote <pr>" promotes the pull request and never carries a
review. Carrying the review is its own request, with the same rule about
whose word authorizes it (see "Promote the review" below).

## Before the promote: self-review the Lord's own pull request

Read `throne forge status <url> --json` first. Run /pr-review's "Self-review
mode" on the pull request before `throne forge promote` when all of these
hold:

- the pull request is the Lord's own, as that section's author check
  decides; on anyone else's pull request this step is skipped, not refused;
- `stage` is not `merged-on-github`: a promote of a merged pull request
  pushes nothing, so there is nothing to review;
- the promote will push a new head: a first promote always does, and a
  repromote does when `inSync` is not `true`;
- `selfReview.coversHead` is not `true`. When it is, an earlier
  self-review already covers this head (a `/pr-merge` row's, say), so name
  it by `selfReview.reviewedHead` in REPORT.md instead of repeating it.

The self-review pushes its fixes to the Forgejo branch, so the promote that
follows carries them to GitHub. It posts nothing on either forge. It runs
beside any code review an operator extension of this skill adds before the
promote, not instead of it. REPORT.md lists each finding with its fixing
commit or the reason it was rejected; when the Lord runs the promote
directly, with no row, the reply to him carries that list.

## 1. Promote

### When the repository lands on main

First check, in the local checkout:

```bash
git -C <repo> config --type=bool --get throne.forge.landsOnMain
```

When it prints `true`, the repository keeps its pull requests only in
Forgejo and GitHub only ever holds its `main` (Lord, 2026-10-22:
"/pr-promote means the same too. these are my personal projects, so no
oull requests on github"). Linked worktrees share the key. The self-review
above runs as today; then `throne forge promote <Forgejo pull request url
or number>` lands the pull request on `main` instead of opening a GitHub
pull request. It is the same landing as /pr-merge's: it refuses a pull
request whose base is not the default branch, squashes the head into one
signed commit on top of `origin/main` in a scratch worktree outside the
checkout, pushes it to `origin` `main` and then to Forgejo's `main`, never
forced, comments `Landed on main as <sha>` on the Forgejo pull request and
closes it as merged, recorded with the landed commit through Forgejo's
manual-merge mark; Forgejo makes no commit. It prints
`{"forgejoUrl","landedCommit","base":"main","closed":true}`; give the Lord
the landed commit. A squash that conflicts refuses, listing every
conflicting path, with nothing changed: report it, never force it. Signing
stays on; a signing failure refuses with nothing pushed.

Nothing else in this skill applies to such a repository: no GitHub pull
request, no media publish, no repromote, no merged-on-GitHub path and no
GitHub review answers. "Promote the review" refuses, naming
`throne.forge.landsOnMain`, because there is no GitHub pull request to
carry a review to.

### Every other repository

```bash
throne forge promote <Forgejo pull request url or number>
```

Run it from the local checkout of the repository; its `origin` is the GitHub
repository. A GitHub URL of a pull request that is already promoted works too,
because it resolves to its Forgejo twin. The command:

1. reads the Forgejo pull request live: title, base, head, draft (a `WIP: `
   title) and body;
2. pushes the head branch to `origin`;
3. opens the GitHub pull request as a draft with the same title (the `WIP: `
   prefix and the `[GH-##]` marker dropped), base and head, through
   `gh --bypass pr create`, because the Lord's word authorizes the write.
   Once its media is re-hosted and the body read back clean, it marks the
   pull request ready for review with `gh --bypass pr ready`, so nobody is
   notified while the body is unfinished; a repromote marks a twin that is
   still a draft ready the same way. The Forgejo pull request keeps its own
   draft state. No reviewer is requested, though GitHub may still ask the
   repository's code owners itself;
4. downloads every Forgejo attachment the body embeds and re-hosts it on
   GitHub through `pr-media`'s `publish.mjs`, so the GitHub body holds only
   GitHub-hosted media. On github.com that is `gh pr edit --attach`; on a
   GitHub Enterprise Server host, where `gh` cannot attach, `publish.mjs`
   uploads each file through its signed-in browser profile, and when that
   profile is not signed in it opens a browser window on the sign-in page
   and waits for the Lord to sign in;
5. writes the Forgejo pull request's one metadata comment: the visible line
   `GitHub: <url>`, and hidden records of that URL and the head it pushed,
   and sets the Forgejo title's marker to the new GitHub number, so
   `WIP: [GH-##] Add the export button` becomes
   `WIP: [GH-123] Add the export button`.

GitHub gets no record and no trace of Forgejo. Every title, body and reply
is sent with its Forgejo records removed, the title's `[GH-...]` marker
included, and the twin bookkeeping lives only in that Forgejo metadata
comment, which every later run rewrites in place.

It prints `{"forgejoUrl","githubUrl","created","mergedOnGithub","answers"}`.
Give the Lord the GitHub URL.

The command refuses, before anything reaches GitHub, when the title or body
still names the Forgejo host (a link to a Forgejo commit, say) or still holds
a record. Tell the Lord which link to take out in Forgejo and run it again.

After the media publish, the command reads the GitHub body back and refuses,
with a non-zero exit and no success output, while it still holds a
`<!-- drop … here -->` placeholder or an image or video link to the Forgejo
host, which the media link check (section 4) finds. The message names the
GitHub URL, the placeholders' file names or each such link, and the one
command that finishes the job: `throne forge promote <forgejo url>` again,
because a repromote re-hosts the media whenever GitHub still holds
placeholders. When the upload failed only because nobody signed in within
the wait, the message says the upload needs the Lord to sign in in the
browser window it opens. Pass that on to him as it is. When the upload failed
because the pull request page no longer offers the comment box the browser
upload uses, rerunning promote would hit the same page, so the message says
the upload needs the hand-upload wizard instead. Promote then keeps the
downloaded media in `~/tmp/pr-media-<github number>/` (a fresh sibling folder
when that one already exists), and the one command it names starts the
wizard on that folder: `node <pr-media>/publish.mjs <github url> --folder
<kept folder> --wizard`. The wizard prints its own next step.

## 2. Repromote

**Answer the automated reviews first.** Before a repromote runs the command,
settle every finding an automated reviewer left on the GitHub pull request
(Lord, 2026-10-20: a repromote resolves the automated review findings that
make sense before it repromotes). Read its reviews, review comments and
conversation comments (`<gh> api repos/<o>/<r>/issues/<n>/comments`,
`<gh> api repos/<o>/<r>/pulls/<n>/comments`,
`<gh> api repos/<o>/<r>/pulls/<n>/reviews`) and keep only those by
automated reviewers, the accounts GitHub reports with `user.type == "Bot"`
or a login ending in `[bot]`. A finding counts unless a later review lists
it as resolved, it was already answered on GitHub, or it was mirrored into
Forgejo and answered there, which step 3 below carries back. Judge each one
against the code and the evidence, then either fix it on the Forgejo branch
in its own commit, which the repromote pushes, or answer it with a
`pr comment` on the GitHub pull request that quotes or links the finding
and, when it is rejected, carries the evidence: which test, which engines,
what was observed. When the reviewer documents its own reply form, the
answer uses that form; an operator's private extension of this skill may
supply those forms. The Lord's word to repromote authorizes `--bypass` on
that `pr comment`, and nothing else. Never repromote while a finding has
neither a fix nor an answer. A person's review or comment is never answered
here. A first promote skips this: GitHub has no reviews yet.

The same command on a pull request that is already promoted finds the Forgejo
metadata comment and opens nothing new. A GitHub pull request staged with
`throne forge stage` has that comment too, so it repromotes the same way;
staging runs the media link check on the Forgejo body it wrote (section 4).
Instead it:

1. pushes the updated head branch to `origin`;
2. replaces the GitHub body with the current Forgejo body, re-hosting the
   media again, even when nothing else changed, and refuses as above while
   placeholders or media links to the Forgejo host remain;
3. replies on GitHub to each review item that was mirrored into Forgejo and
   answered there: an inline thread gets a reply in its thread, and a
   conversation comment or review body gets a conversation comment. The
   reply carries nothing but the answer's text; the Forgejo metadata comment
   records which answers were carried, so a second run sends nothing twice;
4. resolves each GitHub review thread whose Forgejo twin is resolved;
5. keeps `[GH-<n>]` on the Forgejo title, right after any `WIP: `, putting
   it back when someone edited it away by hand. The GitHub title is never
   touched.

`answers` in the output lists the Forgejo comment ids replied and the GitHub
threads resolved; both are empty when nothing new was answered.

Mirroring the GitHub feedback into Forgejo and answering it there is
`/pr-address-feedback`'s work, done when the Lord asks to address feedback.
This skill only carries the answers back.

## 3. When the GitHub pull request is already merged

Outside a repository that lands on main (section 1), pull requests merge
only on GitHub, never in Forgejo (Lord, 2026-10-07:
"nothing gets merged in forgejo"). When someone has merged the GitHub
pull request, the same command does not repromote: it pushes nothing and
opens or edits nothing on GitHub, which it only reads for the merged state.
It closes the Forgejo pull request, never merges it, with the comment "This
pull request has been merged on the GitHub side: <github url>", and prints
`"mergedOnGithub": true`. A Forgejo pull request that is already closed gets
no second comment. Tell the Lord the pull request was already merged.

## 4. The media link check

A media link that points at the other forge does not load there. GitHub does
not let an attachment be hotlinked from Forgejo, and the Forgejo host is
reachable only on the tailnet, so nobody reading the pull request on GitHub
can load a file it serves. So after every copy of a pull request body
between the two forges (`throne forge stage`, `throne forge promote`, and a
repromote), the command checks the copied body for image and video links
that point at the other forge. Only attachment and media links count; a
prose link to the twin pull request or to a commit is not a finding of this
check.

A refusal from the check means the copy was made and is not finished. The
command exits non-zero, prints no success output, and names the pull
request, each link and the one command that repairs it:

- **On the GitHub side**, after a promote or a repromote:
  `throne forge promote <forgejo url>` again, as section 1 says.
- **On the Forgejo side**, after `throne forge stage`, on a first staging
  and on a pull request that is already staged:
  `/pr-media publish <forgejo pull request url>`, which uploads the media to
  Forgejo and rewrites the Forgejo body to hold Forgejo links. Staging
  re-hosts the GitHub media it can download. Media on a GitHub Enterprise
  host cannot be downloaded with a token (the attachment route answers HTTP
  404), so staging leaves those links where they are, and publishing is how
  they are replaced. The twin is open and its feedback is mirrored all the
  same; only its media is unfinished.

To check a pair at any time, give either side's URL:

```bash
throne forge check-media-links <pull request url>
```

It reads both sides, writes nothing, and prints the cross-host media links
on each, one line per link with `forgejo` or `github` in front. It exits 0
when there are none and 1 when there are any; `--json` prints the two lists.
`throne forge status <url> --json` carries the same finding as
`crossHostMediaLinks`, one list per side. Run it after the repair, and do
not call a promote or a staging finished while it exits 1.

Review comments are the one copy that is reported and not refused. When
`throne forge stage` or `throne forge mirror-feedback` copies a GitHub
review comment that holds a GitHub media link into Forgejo, the command
names the link and the GitHub comment, and the mirror still succeeds: no
command re-hosts the media of a comment, and the mirrored comment already
links to its GitHub original, where the media loads.

## Promote the review

Only on the Lord's word "/pr-promote the review", "promote the review" or
"send the review to GitHub", under the same rule as a promote: a request
that does not trace to his words is reported to him, not run. The pull
request itself is not promoted by this request, and plain "/pr-promote
<pr>" never carries the review.

In a repository that lands on main (section 1) it refuses:
`throne forge pr review-findings` names `throne.forge.landsOnMain` and
sends nothing to GitHub. Tell the Lord the review stays in Forgejo.

Follow /pr-review's "Promote the review" section. In short: read the
recorded Forgejo review's line comments as the Lord left them, his edits
kept and his deletions dropped, then create the GitHub pending review from
them, dry run first:

```bash
throne forge pr review-findings <forgejo url> --out ~/tmp/review-<n>-github.json
node .claude/skills/pr-review/pending-review.mjs <github url> ~/tmp/review-<n>-github.json --to-github --dry-run
node .claude/skills/pr-review/pending-review.mjs <github url> ~/tmp/review-<n>-github.json --to-github
```

The review stays pending and is never submitted: submitting it is the
Lord's act. GitHub keeps one pending review per person per pull request, so
when one exists already, add to it through GraphQL as that section says,
and never delete his own pending comments. The copy-paste conversation
comment on Forgejo is never promoted.

## A worked shape

A recipe app's pull request "Add a gluten-free filter" sits in Forgejo as a
draft with one screenshot and one screen recording. The Lord says "promote
PR 4". The command pushes `add/gluten-free-filter` to `origin`, opens pull
request 31 on GitHub as a draft, re-uploads both files there, writes the link
into Forgejo pull request 4's metadata comment, and marks pull request 31
ready for review without asking anyone to review it. Pull request 31 never
mentions Forgejo. Two reviewers comment on GitHub. The Lord asks
to address the feedback; the answers and resolutions happen in Forgejo. He
then says "repromote 4", and the two replies and one resolved thread appear on
GitHub pull request 31. Saying it again changes nothing on either side.
Once pull request 31 is merged on GitHub, "repromote 4" closes Forgejo pull
request 4 with the merged-on-GitHub comment instead.
