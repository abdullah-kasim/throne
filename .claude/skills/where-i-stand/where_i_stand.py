import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

from review_requests_and_teammates import collect_others, configured_teams, hosts_file_lines, owners_searched_on, window_start

HOSTS_FILE = os.path.expanduser(os.environ.get("WHERE_I_STAND_HOSTS", "~/.config/where-i-stand/hosts"))
FAILING = {"FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"}
PASSING = {"SUCCESS", "NEUTRAL", "SKIPPED"}
TICKET = re.compile(r"\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b")
FORGEJO = "forgejo"
STAGING_TITLE = re.compile(r"^(?P<draft>WIP:\s*)?(?:\[GH-(?P<github>##|\d+)\]\s*)?(?P<title>.*)$", re.DOTALL)
FORGEJO_PAGE_SIZE = 50
LINK = re.compile(r"\[([^\]]*)\]\(([^)\s]+)\)|(https?://[^\s<>)\]]+)")
CLOSING_ISSUE = re.compile(r"\b(?:fixes|closes|resolves)\s+#(\d+)", re.IGNORECASE)
BRANCH_KINDS = {"fix": "bug fix", "add": "new feature", "update": "change", "try": "experiment", "remove": "removal"}


def configured_hosts():
    hosts = [("github.com", "gh")]
    if os.path.exists(HOSTS_FILE):
        for line in open(HOSTS_FILE):
            parts = line.split()
            if len(parts) == 2 and not line.lstrip().startswith("#"):
                hosts = [entry for entry in hosts if entry[0] != parts[0]] + [(parts[0], parts[1])]
    return hosts


def configured_forges():
    return [(root.rstrip("/"), os.path.expanduser(token_file)) for root, token_file in hosts_file_lines(HOSTS_FILE, FORGEJO)]


def host_names():
    return [host for host, command in configured_hosts()] + [urllib.parse.urlsplit(root).netloc for root, token_file in configured_forges()]


def run_json(command):
    result = subprocess.run(command, capture_output=True, text=True, cwd=os.path.expanduser("~"))
    if result.returncode != 0:
        return None, result.stderr.strip().splitlines()[-1:] or ["no output"]
    return json.loads(result.stdout or "null"), None


def one_line_summary(body, title):
    for line in (body or "").splitlines():
        text = re.sub(r"<[^>]+>|!\[[^\]]*\]\([^)]*\)|\[([^\]]*)\]\([^)]*\)", r"\1", line).strip()
        text = re.sub(r"^([-*+]|\d+\.)\s+", "", text.strip("*_`> ").strip())
        if not text or text.startswith(("#", "|", "---", "Ticket:", "Fixes", "Closes", "Related")) or text.lower().startswith(("http", "ticket")):
            continue
        sentence = re.split(r"(?<=[.!?])\s", text, maxsplit=1)[0]
        return sentence if len(sentence) <= 180 else sentence[:177].rstrip() + "…"
    return title


def linked_ticket_url(body, ticket):
    for link in LINK.finditer(body or "") if ticket else []:
        text, address = link.group(1) or "", link.group(2) or link.group(3)
        if ticket.lower() in (text + " " + address).lower():
            return address
    return ""


def github_issue_url(body, pull_request_url):
    issues_address = pull_request_url.split("/pull/")[0] + "/issues/"
    closing = CLOSING_ISSUE.search(body or "")
    if closing:
        return issues_address + closing.group(1)
    linked = re.search(re.escape(issues_address) + r"\d+", body or "")
    return linked.group(0) if linked else ""


def branch_kind(branch):
    return BRANCH_KINDS.get(branch.split("/")[0], "")


def check_counts(rollup):
    states = [(check.get("conclusion") or check.get("state") or check.get("status") or "").upper() for check in rollup or []]
    return {
        "passing": sum(state in PASSING for state in states),
        "failing": sum(state in FAILING for state in states),
        "running": sum(state not in PASSING and state not in FAILING for state in states),
    }


def is_merged(pr):
    return pr["state"] == "MERGED"


def is_on_forgejo(pr):
    return pr.get("forge") == FORGEJO


def standing(pr):
    if is_merged(pr):
        return "merged"
    if pr["state"] == "CLOSED":
        return "closed"
    if is_on_forgejo(pr):
        return "forgejo only"
    if pr["checks"]["failing"] or pr["conflicting"] or pr["review"] == "CHANGES_REQUESTED":
        return "needs you"
    if pr["review"] == "APPROVED":
        return "ready to merge"
    if pr["draft"]:
        return "draft"
    return "waiting on review"


def split_staging_title(title):
    parts = STAGING_TITLE.match(title)
    github = parts.group("github")
    return {
        "draft": parts.group("draft") is not None,
        "github_number": int(github) if github and github.isdigit() else None,
        "title": parts.group("title").strip(),
    }


def read_forgejo(root, token, path):
    request = urllib.request.Request(f"{root}/api/v1/{path}", headers={"Authorization": f"token {token}", "Accept": "application/json"})
    without_proxy = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with without_proxy.open(request, timeout=30) as response:
        return json.load(response)


def forgejo_record(host, item, detail):
    marked = split_staging_title(item["title"])
    pull = item.get("pull_request") or {}
    merged = bool(pull.get("merged"))
    head_branch = ((detail.get("head") or {}).get("ref") or "")
    ticket = TICKET.search(marked["title"]) or TICKET.search(head_branch.upper()) or TICKET.search(item.get("body") or "")
    pr = {
        "host": host,
        "forge": FORGEJO,
        "repository": item["repository"]["full_name"],
        "number": item["number"],
        "url": item["html_url"],
        "title": marked["title"],
        "summary": one_line_summary(item.get("body"), marked["title"]),
        "ticket": ticket.group(1) if ticket else "",
        "ticket_url": linked_ticket_url(item.get("body"), ticket and ticket.group(1)),
        "kind": branch_kind(head_branch),
        "state": "MERGED" if merged else item["state"].upper(),
        "draft": marked["draft"] or bool(pull.get("draft")),
        "github_number": marked["github_number"],
        "review": "",
        "approvals": [],
        "conflicting": detail.get("mergeable") is False and item["state"] == "open",
        "checks": check_counts([]),
        "merged_at": pull.get("merged_at") or "",
        "updated_at": item["updated_at"],
        "size": f"{detail.get('changed_files', 0)} files, +{detail.get('additions', 0)} −{detail.get('deletions', 0)}",
        "head": (detail.get("head") or {}).get("sha") or "",
    }
    pr["standing"] = standing(pr)
    return pr


def collect_forgejo(root, token_file, since):
    host = urllib.parse.urlsplit(root).netloc
    try:
        token = open(token_file).read().strip()
    except OSError as error:
        return [], [f"{host}: cannot read its token file: {error.strerror}"]
    prs, problems, page = [], [], 1
    while True:
        query = urllib.parse.urlencode({"type": "pulls", "state": "all", "created": "true", "since": f"{since}T00:00:00Z", "limit": FORGEJO_PAGE_SIZE, "page": page})
        try:
            found = read_forgejo(root, token, f"repos/issues/search?{query}")
        except (urllib.error.URLError, OSError, ValueError) as error:
            return prs, problems + [f"{host}: {error}"]
        for item in found:
            if item["updated_at"][:10] < since:
                continue
            try:
                detail = read_forgejo(root, token, f"repos/{item['repository']['full_name']}/pulls/{item['number']}")
            except (urllib.error.URLError, OSError, ValueError) as error:
                problems.append(f"{item['html_url']}: {error}")
                detail = {}
            prs.append(forgejo_record(host, item, detail))
        if len(found) < FORGEJO_PAGE_SIZE:
            return prs, problems
        page += 1


def fold_staged_copies(prs):
    on_github = [pr for pr in prs if not is_on_forgejo(pr)]
    kept = []
    for pr in prs:
        if not is_on_forgejo(pr) or pr["github_number"] is None:
            kept.append(pr)
            continue
        originals = [
            github for github in on_github
            if github["number"] == pr["github_number"] and github["repository"].split("/")[-1] == pr["repository"].split("/")[-1]
        ]
        if len(originals) == 1:
            originals[0]["forgejo_copy"] = pr
        else:
            kept.append(pr)
    return kept


def collect(days):
    since = window_start(days)
    prs, problems = [], []
    for host, cli in configured_hosts():
        found, error = run_json([cli, "search", "prs", "--author", "@me", *owners_searched_on(HOSTS_FILE, host), "--updated", f">={since}", "--limit", "100", "--json", "url,repository,number"])
        if error:
            problems.append(f"{host}: {error[0]}")
            continue
        for item in found:
            detail, error = run_json([cli, "pr", "view", item["url"], "--json",
                "title,body,state,isDraft,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,reviews,mergedAt,closedAt,createdAt,updatedAt,headRefName,headRefOid,baseRefName,additions,deletions,changedFiles"])
            if error:
                problems.append(f"{item['url']}: {error[0]}")
                continue
            approvals = sorted({review["author"]["login"] for review in detail.get("reviews") or [] if review["state"] == "APPROVED"})
            ticket = TICKET.search(detail["title"]) or TICKET.search(detail.get("headRefName", "").upper()) or TICKET.search(detail.get("body") or "")
            pr = {
                "host": host,
                "repository": item["repository"]["nameWithOwner"],
                "number": item["number"],
                "url": item["url"],
                "title": detail["title"],
                "summary": one_line_summary(detail.get("body"), detail["title"]),
                "ticket": ticket.group(1) if ticket else "",
                "ticket_url": linked_ticket_url(detail.get("body"), ticket and ticket.group(1)) or github_issue_url(detail.get("body"), item["url"]),
                "kind": branch_kind(detail.get("headRefName") or ""),
                "state": detail["state"],
                "draft": detail["isDraft"],
                "review": detail.get("reviewDecision") or "",
                "approvals": approvals,
                "conflicting": detail.get("mergeable") == "CONFLICTING" or detail.get("mergeStateStatus") == "DIRTY",
                "checks": check_counts(detail.get("statusCheckRollup")),
                "merged_at": detail.get("mergedAt") or "",
                "updated_at": detail["updatedAt"],
                "size": f"{detail.get('changedFiles', 0)} files, +{detail.get('additions', 0)} −{detail.get('deletions', 0)}",
                "head": detail.get("headRefOid") or "",
            }
            pr["standing"] = standing(pr)
            prs.append(pr)
    for root, token_file in configured_forges():
        forgejo_prs, forgejo_problems = collect_forgejo(root, token_file, since)
        prs += forgejo_prs
        problems += forgejo_problems
    return fold_staged_copies(prs), problems


ORDER = ["needs you", "ready to merge", "waiting on review", "draft", "forgejo only", "merged", "closed"]


def forgejo_draft_and_conflict_words(pr):
    words = ["draft"] if pr["draft"] and pr["state"] == "OPEN" else []
    if pr["conflicting"]:
        words.append("conflicts")
    return words


def forgejo_side_state(pr):
    return ", ".join(forgejo_draft_and_conflict_words(pr) or [pr["state"].lower()])


def forgejo_status_words(pr):
    words = forgejo_draft_and_conflict_words(pr)
    if pr["github_number"] is None:
        words.append("not on GitHub yet")
    else:
        words.append(f"staging copy of GitHub #{pr['github_number']}, which this report did not find")
    return ", ".join(words)


def status_words(pr):
    if is_on_forgejo(pr):
        return forgejo_status_words(pr)
    words = ["draft"] if pr["draft"] and pr["state"] == "OPEN" else []
    if pr["checks"]["failing"]:
        words.append(f"CI {pr['checks']['failing']} failing")
    elif pr["checks"]["running"]:
        words.append(f"CI {pr['checks']['running']} running")
    elif pr["checks"]["passing"]:
        words.append("CI green")
    else:
        words.append("no CI")
    if pr["conflicting"] and pr["state"] == "OPEN":
        words.append("conflicts")
    if pr["review"] == "CHANGES_REQUESTED":
        words.append("changes requested")
    if pr["approvals"]:
        words.append("approved by " + ", ".join(pr["approvals"]))
    if pr["merged_at"]:
        words.append("merged " + pr["merged_at"][:10])
    return ", ".join(words)


def github_side_state(pr):
    readiness = ["ready"] if pr["state"] == "OPEN" and not pr["draft"] else []
    return ", ".join(readiness + [status_words(pr)])


def markdown_link(pr):
    return f"[{pr['repository'].split('/')[-1]} #{pr['number']}]({pr['url']})"


def group_members(prs, group):
    return sorted((pr for pr in prs if pr["standing"] == group), key=lambda pr: pr["updated_at"], reverse=True)


def markdown(prs, days, problems):
    lines = [f"# Where I stand: PRs touched in the last {days} days", ""]
    for group in ORDER:
        members = group_members(prs, group)
        if not members:
            continue
        lines += [f"## {group.capitalize()} ({len(members)})", "", "| PR | What | State |", "| --- | --- | --- |"]
        for pr in members:
            what = (f"{pr['ticket']}: " if pr["ticket"] else "") + pr["summary"].replace("|", "\\|")
            staged = f", [staged in Forgejo]({pr['forgejo_copy']['url']})" if pr.get("forgejo_copy") else ""
            lines.append(f"| {markdown_link(pr)} | {what} | {status_words(pr)}{staged} |")
        lines.append("")
    if problems:
        lines += ["## Could not read", ""] + [f"- {problem}" for problem in problems]
    return "\n".join(lines)


def is_closed_without_merging(pr):
    return pr["state"] == "CLOSED"


def visible(prs, include_merged, include_closed=False):
    return [
        pr for pr in prs
        if (include_merged or not is_merged(pr)) and (include_closed or not is_closed_without_merging(pr))
    ]


def group_and_state(pr):
    return f"{standing(pr)} ({status_words(pr)})"


def changes(previous, current):
    before = {pr["url"]: pr for pr in previous}
    after = {pr["url"]: pr for pr in current}
    lines = []
    for url, pr in after.items():
        if url not in before:
            lines.append(f"- new: {markdown_link(pr)}: {group_and_state(pr)}")
        elif group_and_state(before[url]) != group_and_state(pr):
            lines.append(f"- changed: {markdown_link(pr)}: {group_and_state(before[url])} → {group_and_state(pr)}")
    for url, pr in before.items():
        if url not in after:
            lines.append(f"- gone: {markdown_link(pr)}: {group_and_state(pr)}")
    return lines or ["Nothing changed since the last run."]


def head_commits(github, forgejo):
    if not (github and forgejo and github.get("head") and forgejo.get("head")):
        return ""
    return "in sync" if github["head"] == forgejo["head"] else "GitHub behind Forgejo"


def pull_request_side(pr, state):
    return {"url": pr["url"], "number": pr["number"], "state": state} if pr else None


def table_row(pr):
    github = None if is_on_forgejo(pr) else pr
    forgejo = pr if is_on_forgejo(pr) else pr.get("forgejo_copy")
    return {
        "group": pr["standing"].capitalize(),
        "repository": pr["repository"],
        "title": pr["title"],
        "ticket": pr["ticket"],
        "ticket_url": (github and github["ticket_url"]) or (forgejo and forgejo["ticket_url"]) or "",
        "kind": pr["kind"],
        "summary": pr["summary"],
        "forgejo": pull_request_side(forgejo, forgejo and forgejo_side_state(forgejo)),
        "github": pull_request_side(github, github and github_side_state(github)),
        "head_commits": head_commits(github, forgejo),
    }


def page_data(prs, problems, change_lines, days, read_at, waiting, teammates):
    return {
        "read_at": read_at,
        "days": days,
        "problems": problems,
        "changes": [line.removeprefix("- ") for line in change_lines],
        "rows": [table_row(pr) for group in ORDER for pr in group_members(prs, group)],
        "waiting_for_review": waiting,
        "teammates": teammates,
    }


def cache_folder():
    cache_home = os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache")
    return os.path.join(cache_home, "where-i-stand")


def cache_path(days):
    return os.path.join(cache_folder(), f"last-{days}-days.json")


def page_data_path():
    return os.path.join(cache_folder(), "where-i-stand-prs.json")


def write_json_through_a_rename(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    handle, temporary_path = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".partial")
    with os.fdopen(handle, "w") as temporary_file:
        json.dump(data, temporary_file)
    os.replace(temporary_path, path)


def write_cache(days, prs, problems, hosts, waiting, teammates):
    write_json_through_a_rename(cache_path(days), {"written_at": utc_now().isoformat(), "hosts": hosts, "prs": prs, "problems": problems, "waiting_for_review": waiting, "teammates": teammates})


def write_page_data(data):
    write_json_through_a_rename(page_data_path(), data)


def read_cache(days):
    path = cache_path(days)
    if not os.path.exists(path):
        return None
    with open(path) as cache_file:
        return json.load(cache_file)


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc)


def cache_age(written_at, current_time):
    minutes = int((current_time - datetime.datetime.fromisoformat(written_at)).total_seconds() // 60)
    if minutes < 60:
        return f"{minutes} min"
    if minutes < 48 * 60:
        return f"{minutes // 60} h"
    return f"{minutes // (24 * 60)} d"


def main(argv=None):
    parser = argparse.ArgumentParser(description="List your pull requests from the last N days, grouped by what they need.")
    parser.add_argument("--days", type=int, default=14)
    parser.add_argument("--json", action="store_true", help="print the raw records instead of markdown")
    run_mode = parser.add_mutually_exclusive_group()
    run_mode.add_argument("--cached", action="store_true", help="print the report from the last full run's cache at once, without reading any host")
    run_mode.add_argument("--refresh", action="store_true", help="read every host and update the cache (the default)")
    parser.add_argument("--changes", action="store_true", help="after the full run, print only the pull requests that are new, gone, or changed group or state since the cache")
    parser.add_argument("--include-merged", action="store_true", help="show merged pull requests, which are hidden by default")
    parser.add_argument("--include-closed", action="store_true", help="show pull requests closed without merging, which are hidden by default")
    arguments = parser.parse_args(argv)
    if arguments.cached and arguments.changes:
        parser.error("--changes compares a full run with the cache; drop --cached")
    if arguments.cached:
        cache = read_cache(arguments.days)
        if cache is None:
            print(f"No cache yet for the last {arguments.days} days; run without --cached for the full report.")
            return 1
        print(f"from the cache, {cache_age(cache['written_at'], utc_now())} old; refreshing in the background", file=sys.stderr if arguments.json else sys.stdout)
        prs, problems, waiting, teammates = cache["prs"], cache["problems"], cache.get("waiting_for_review", []), cache.get("teammates", [])
    else:
        previous_prs = (read_cache(arguments.days) or {"prs": []})["prs"]
        prs, problems = collect(arguments.days)
        waiting, teammates, other_problems = collect_others(arguments.days, configured_hosts(), configured_teams(HOSTS_FILE), run_json, check_counts)
        problems += other_problems
        write_cache(arguments.days, prs, problems, host_names(), waiting, teammates)
    shown = visible(prs, arguments.include_merged, arguments.include_closed)
    if not arguments.cached:
        change_lines = changes(visible(previous_prs, arguments.include_merged, arguments.include_closed), shown)
        write_page_data(page_data(shown, problems, change_lines, arguments.days, utc_now().isoformat(), waiting, teammates))
    if arguments.changes:
        print("\n".join(change_lines))
    elif arguments.json:
        print(json.dumps({"prs": shown, "problems": problems, "waiting_for_review": waiting, "teammates": teammates}, indent=1))
    else:
        print(markdown(shown, arguments.days, problems))
    return 0


if __name__ == "__main__":
    sys.exit(main())
