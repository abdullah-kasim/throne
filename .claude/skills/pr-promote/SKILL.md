---
name: pr-promote
description: 'This throne-only skill copies a finished pull request from the Forgejo staging area to GitHub on the Lord''s word, and on a second run carries the Forgejo answers to review feedback back to GitHub, or closes the Forgejo pull request when its GitHub twin was already merged. Invoked by /pr-promote <Forgejo pull request url or number> (alias: /promote-pr), or only when the Lord himself says "promote PR N", "promote this to GitHub", "repromote N" or "send the answers back to GitHub". A queue row''s Alpha may run it when the row carries the Lord''s order to promote; no other skill or gate runs it on its own initiative.'
version: 1.0.0
user-invocable: true
---

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

## 1. Promote

```bash
throne forge promote <Forgejo pull request url or number>
```

Run it from the local checkout of the repository; its `origin` is the GitHub
repository. A GitHub URL of a pull request that is already promoted works too,
because it resolves to its Forgejo twin. The command:

1. reads the Forgejo pull request live: title, base, head, draft (a `WIP: `
   title) and body;
2. pushes the head branch to `origin`;
3. opens the GitHub pull request with the same title (the `WIP: ` prefix and
   the `[GH-##]` marker dropped), base, head and draft state, through
   `gh --bypass pr create`, because the Lord's word authorizes the write;
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
`<!-- drop … here -->` placeholder or a link to the Forgejo host. The message
names the GitHub URL, the placeholders' file names or the Forgejo host, and
the one command that finishes the job: `throne forge promote <forgejo url>`
again, because a repromote re-hosts the media whenever GitHub still holds
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

The same command on a pull request that is already promoted finds the Forgejo
metadata comment and opens nothing new. A GitHub pull request staged with
`throne forge stage` has that comment too, so it repromotes the same way. Instead it:

1. pushes the updated head branch to `origin`;
2. replaces the GitHub body with the current Forgejo body, re-hosting the
   media again, even when nothing else changed, and refuses as above while
   placeholders remain;
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

Pull requests merge only on GitHub, never in Forgejo (Lord, 2026-10-07:
"nothing gets merged in forgejo"). When someone has merged the GitHub
pull request, the same command does not repromote: it pushes nothing and
opens or edits nothing on GitHub, which it only reads for the merged state.
It closes the Forgejo pull request, never merges it, with the comment "This
pull request has been merged on the GitHub side: <github url>", and prints
`"mergedOnGithub": true`. A Forgejo pull request that is already closed gets
no second comment. Tell the Lord the pull request was already merged.

## A worked shape

A recipe app's pull request "Add a gluten-free filter" sits in Forgejo as a
draft with one screenshot and one screen recording. The Lord says "promote
PR 4". The command pushes `add/gluten-free-filter` to `origin`, opens draft
pull request 31 on GitHub with both files re-uploaded there, and writes the
link into Forgejo pull request 4's metadata comment. Pull request 31 never
mentions Forgejo. Two reviewers comment on GitHub. The Lord asks
to address the feedback; the answers and resolutions happen in Forgejo. He
then says "repromote 4", and the two replies and one resolved thread appear on
GitHub pull request 31. Saying it again changes nothing on either side.
Once pull request 31 is merged on GitHub, "repromote 4" closes Forgejo pull
request 4 with the merged-on-GitHub comment instead.
