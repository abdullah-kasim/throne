import datetime
import os
import urllib.parse

TEAM_LINE = "team"
OWNER_LINE = "owner"
YOU = "you"
OPEN = "OPEN"
REVIEW_REQUESTED = "review_requested"
PULL_REQUEST = "PullRequest"
WAITING_FIELDS = "state,isDraft,author,title,reviewRequests,reviews,createdAt,updatedAt,statusCheckRollup"
TEAMMATE_FIELDS = "reviewDecision,statusCheckRollup"
SEARCH_PAGE_SIZE = 100


class HostUnreadable(Exception):
    pass


def window_start(days):
    return (datetime.date.today() - datetime.timedelta(days=days)).isoformat()


def hosts_file_lines(hosts_file, kind):
    found = []
    if os.path.exists(hosts_file):
        with open(hosts_file) as lines:
            for line in lines:
                parts = line.split()
                if len(parts) == 3 and parts[0] == kind:
                    found.append((parts[1], parts[2]))
    return found


def configured_teams(hosts_file):
    return dict(hosts_file_lines(hosts_file, TEAM_LINE))


def owners_searched_on(hosts_file, host):
    return [flag for named_host, owner in hosts_file_lines(hosts_file, OWNER_LINE) if named_host == host for flag in ("--owner", owner)]


def host_reader(read_json, cli):
    def read(*arguments):
        value, error = read_json([cli, *arguments])
        if error:
            raise HostUnreadable(error[0])
        return value
    return read


def every_page(read, path):
    return read("api", path, "--paginate", "--slurp")


def own_login(read):
    return read("api", "user")["login"]


def own_teams(read, configured_team):
    teams = {f"{team['organization']['login']}/{team['slug']}" for page in every_page(read, "user/teams") for team in page}
    return teams | {team for team in [configured_team] if team}


def requested_pull_requests(read, since):
    notifications = every_page(read, f"notifications?all=true&since={since}T00:00:00Z")
    requested = {}
    for page in notifications:
        for notification in page:
            if notification["subject"]["type"] == PULL_REQUEST and notification["reason"] == REVIEW_REQUESTED:
                repository = notification["repository"]
                number = int(notification["subject"]["url"].rsplit("/", 1)[-1])
                url = f"{repository['html_url']}/pull/{number}"
                requested[url] = {"repository": repository["full_name"], "number": number, "url": url}
    return list(requested.values())


def waiting_on(detail, login, teams):
    requests = detail.get("reviewRequests") or []
    if any(request.get("login") == login for request in requests):
        return YOU
    team_names = [request["name"] for request in requests if request.get("slug") in teams]
    return team_names[0] if team_names else ""


def has_reviewed(detail, login):
    return any((review.get("author") or {}).get("login") == login for review in detail.get("reviews") or [])


def is_waiting_for_review(detail, login, teams):
    return detail["state"] == OPEN and waiting_on(detail, login, teams) != "" and not has_reviewed(detail, login)


def waiting_for_review(read, host, since, configured_team, count_checks):
    login = own_login(read)
    teams = own_teams(read, configured_team)
    rows, problems = [], []
    for request in requested_pull_requests(read, since):
        try:
            detail = read("pr", "view", request["url"], "--json", WAITING_FIELDS)
        except HostUnreadable as error:
            problems.append(f"{request['url']}: {error}")
            continue
        if is_waiting_for_review(detail, login, teams):
            rows.append({
                "host": host,
                **request,
                "title": detail["title"],
                "author": detail["author"]["login"],
                "waiting_on": waiting_on(detail, login, teams),
                "checks": count_checks(detail.get("statusCheckRollup")),
                "created_at": detail["createdAt"],
            })
    return rows, problems


def teammates(read, team, login):
    organisation, slug = team.split("/")
    members = [member["login"] for page in every_page(read, f"orgs/{organisation}/teams/{slug}/members") for member in page]
    return [member for member in members if member != login]


def open_pull_requests_by(read, organisation, authors, since):
    if not authors:
        return []
    query = " ".join(["is:pr", "is:open", f"org:{organisation}", f"updated:>={since}"] + [f"author:{author}" for author in authors])
    pages = every_page(read, "search/issues?" + urllib.parse.urlencode({"q": query, "per_page": SEARCH_PAGE_SIZE}))
    return [item for page in pages for item in page["items"] if item["updated_at"][:10] >= since]


def teammates_pull_requests(read, host, since, team, count_checks):
    found = open_pull_requests_by(read, team.split("/")[0], teammates(read, team, own_login(read)), since)
    rows, problems = [], []
    for item in found:
        try:
            detail = read("pr", "view", item["html_url"], "--json", TEAMMATE_FIELDS)
        except HostUnreadable as error:
            problems.append(f"{item['html_url']}: {error}")
            continue
        rows.append({
            "host": host,
            "repository": item["repository_url"].split("/repos/", 1)[1],
            "number": item["number"],
            "url": item["html_url"],
            "title": item["title"],
            "author": item["user"]["login"],
            "draft": bool(item.get("draft")),
            "review": detail.get("reviewDecision") or "",
            "checks": count_checks(detail.get("statusCheckRollup")),
            "updated_at": item["updated_at"],
        })
    return rows, problems


def rows_or_problem(host, gather):
    try:
        return gather()
    except HostUnreadable as error:
        return [], [f"{host}: {error}"]


def collect_others(days, hosts, teams, read_json, count_checks):
    since = window_start(days)
    waiting, teammate_rows, problems = [], [], []
    for host, cli in hosts:
        read = host_reader(read_json, cli)
        host_waiting, waiting_problems = rows_or_problem(host, lambda: waiting_for_review(read, host, since, teams.get(host), count_checks))
        host_teammates, teammate_problems = rows_or_problem(host, lambda: teammates_pull_requests(read, host, since, teams[host], count_checks)) if host in teams else ([], [])
        waiting += host_waiting
        teammate_rows += host_teammates
        problems += waiting_problems + teammate_problems
    waiting.sort(key=lambda row: row["created_at"])
    teammate_rows.sort(key=lambda row: row["updated_at"], reverse=True)
    return waiting, teammate_rows, problems
