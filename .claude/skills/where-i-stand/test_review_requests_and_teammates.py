import contextlib
import datetime
import io
import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

import review_requests_and_teammates
import where_i_stand

PASTRY_TEAM = {"organization": {"login": "bakery"}, "slug": "pastry", "name": "Pastry"}
BREAD_TEAM = {"organization": {"login": "bakery"}, "slug": "bread", "name": "Bread"}
SEARCH_PATH = "search/issues"
TODAY = f"{datetime.date.today().isoformat()}T09:00:00Z"
YESTERDAY = f"{(datetime.date.today() - datetime.timedelta(days=1)).isoformat()}T09:00:00Z"


def review_notification(number, reason="review_requested", subject_type="PullRequest", repository="bakery/ovens"):
    return {
        "reason": reason,
        "subject": {"type": subject_type, "url": f"https://api.github.com/repos/{repository}/pulls/{number}"},
        "repository": {"full_name": repository, "html_url": f"https://github.com/{repository}"},
    }


def requested_detail(requests, state="OPEN", reviews=(), created_at="2026-10-17T09:00:00Z", author="baker-two"):
    return {
        "state": state,
        "isDraft": False,
        "author": {"login": author},
        "title": "Raise the oven limit",
        "reviewRequests": list(requests),
        "reviews": list(reviews),
        "createdAt": created_at,
        "updatedAt": "2026-10-18T09:00:00Z",
        "statusCheckRollup": [{"conclusion": "SUCCESS"}, {"conclusion": "SUCCESS"}, {"conclusion": "SUCCESS"}, {"status": "IN_PROGRESS"}],
    }


def asked_of_you():
    return {"__typename": "User", "login": "baker-one"}


def asked_of_team(team):
    return {"__typename": "Team", "name": team["name"], "slug": f"{team['organization']['login']}/{team['slug']}"}


def search_result(number, author, updated_at=TODAY, draft=False, repository="bakery/ovens"):
    return {
        "number": number,
        "html_url": f"https://github.com/{repository}/pull/{number}",
        "repository_url": f"https://api.github.com/repos/{repository}",
        "title": f"Rise times {number}",
        "user": {"login": author},
        "draft": draft,
        "updated_at": updated_at,
    }


def pull_request_url(number, repository="bakery/ovens"):
    return f"https://github.com/{repository}/pull/{number}"


class FakeHost:
    def __init__(self, notifications=(), details=None, teams=(PASTRY_TEAM,), members=("baker-one", "baker-three"), found=(), unreadable=()):
        self.answers = {
            "user": {"login": "baker-one"},
            "user/teams": [list(teams)],
            "notifications": [list(notifications)],
            "orgs/bakery/teams/pastry/members": [[{"login": member} for member in members]],
            SEARCH_PATH: [{"items": list(found)}],
            **(details or {}),
        }
        for path in unreadable:
            self.answers.pop(path)
        self.commands = []

    def run_json(self, command):
        self.commands.append(command)
        key = command[3] if command[1] == "pr" else command[2].split("?")[0]
        if key not in self.answers:
            return None, ["HTTP 404: Not Found"]
        return self.answers[key], None

    def search_queries(self):
        return [command[2] for command in self.commands if command[2].startswith(SEARCH_PATH)]


def collect_from(fake, teams=None):
    return review_requests_and_teammates.collect_others(14, [("github.com", "gh")], {"github.com": "bakery/pastry"} if teams is None else teams, fake.run_json, where_i_stand.check_counts)


def waiting_from(fake):
    waiting, teammates, problems = collect_from(fake)
    return waiting


class ScratchCacheAndHostsTest(unittest.TestCase):
    def setUp(self):
        self.cache_home = tempfile.mkdtemp()
        self.environment = mock.patch.dict(os.environ, {"XDG_CACHE_HOME": self.cache_home})
        self.environment.start()
        self.hosts_file = mock.patch.object(where_i_stand, "HOSTS_FILE", os.path.join(self.cache_home, "no-hosts-file"))
        self.hosts_file.start()

    def tearDown(self):
        self.hosts_file.stop()
        self.environment.stop()
        shutil.rmtree(self.cache_home)


class ReviewRequestsAndTeammatesTest(ScratchCacheAndHostsTest):
    def run_main(self, arguments, fake, prs=()):
        output = io.StringIO()
        with mock.patch.object(where_i_stand, "collect", return_value=(list(prs), [])), mock.patch.object(where_i_stand, "run_json", fake.run_json), contextlib.redirect_stdout(output):
            where_i_stand.main(arguments)
        return output.getvalue()

    def test_a_team_line_in_the_hosts_file_names_the_team_and_the_other_host_readers_ignore_it(self):
        hosts_file = os.path.join(self.cache_home, "hosts")
        with open(hosts_file, "w") as hosts:
            hosts.write("git.example.com ghe\nteam git.example.com bakery/pastry\nforgejo https://forge.example.com /keys/forge-token\n")
        with mock.patch.object(where_i_stand, "HOSTS_FILE", hosts_file):
            self.assertEqual(review_requests_and_teammates.configured_teams(hosts_file), {"git.example.com": "bakery/pastry"})
            self.assertEqual(where_i_stand.configured_hosts(), [("github.com", "gh"), ("git.example.com", "ghe")])
            self.assertEqual(where_i_stand.configured_forges(), [("https://forge.example.com", "/keys/forge-token")])
            self.assertEqual(where_i_stand.host_names(), ["github.com", "git.example.com", "forge.example.com"])

    def test_an_open_pull_request_whose_review_is_requested_of_you_is_waiting_on_you(self):
        fake = FakeHost([review_notification(12)], {pull_request_url(12): requested_detail([asked_of_you(), asked_of_team(PASTRY_TEAM)])})
        self.assertEqual(waiting_from(fake), [{
            "host": "github.com", "repository": "bakery/ovens", "number": 12, "url": pull_request_url(12),
            "title": "Raise the oven limit", "author": "baker-two", "waiting_on": "you",
            "checks": {"passing": 3, "failing": 0, "running": 1}, "created_at": "2026-10-17T09:00:00Z",
        }])

    def test_an_open_pull_request_whose_review_is_requested_of_your_team_is_waiting_on_that_team(self):
        fake = FakeHost([review_notification(12), review_notification(13)], {
            pull_request_url(12): requested_detail([asked_of_team(PASTRY_TEAM)]),
            pull_request_url(13): requested_detail([asked_of_team(BREAD_TEAM)]),
        }, teams=[BREAD_TEAM])
        self.assertEqual([(row["number"], row["waiting_on"]) for row in waiting_from(fake)], [(12, "Pastry"), (13, "Bread")])

    def test_a_requested_pull_request_that_was_closed_is_not_waiting(self):
        fake = FakeHost([review_notification(12)], {pull_request_url(12): requested_detail([asked_of_you()], state="CLOSED")})
        self.assertEqual(waiting_from(fake), [])

    def test_a_pull_request_no_longer_requested_of_you_or_your_teams_is_not_waiting(self):
        fake = FakeHost([review_notification(12)], {pull_request_url(12): requested_detail([{"__typename": "User", "login": "baker-four"}, asked_of_team({**BREAD_TEAM, "slug": "rye"})])})
        self.assertEqual(waiting_from(fake), [])

    def test_a_notification_that_is_not_a_review_request_for_a_pull_request_is_not_read(self):
        fake = FakeHost([review_notification(12, subject_type="Issue"), review_notification(13, reason="mention")])
        self.assertEqual(waiting_from(fake), [])
        self.assertFalse([command for command in fake.commands if command[1] == "pr"])

    def test_a_pull_request_asked_of_your_team_that_you_already_reviewed_is_not_waiting(self):
        for state in ("APPROVED", "CHANGES_REQUESTED", "COMMENTED"):
            reviewed = [{"author": {"login": "baker-two"}, "state": "APPROVED"}, {"author": {"login": "baker-one"}, "state": state}]
            fake = FakeHost([review_notification(12)], {pull_request_url(12): requested_detail([asked_of_team(PASTRY_TEAM)], reviews=reviewed)})
            self.assertEqual(waiting_from(fake), [], state)

    def test_a_pull_request_you_only_left_a_conversation_comment_on_is_still_waiting(self):
        fake = FakeHost([review_notification(12)], {pull_request_url(12): requested_detail([asked_of_team(PASTRY_TEAM)], reviews=[{"author": {"login": "baker-two"}, "state": "APPROVED"}])})
        self.assertEqual([row["waiting_on"] for row in waiting_from(fake)], ["Pastry"])

    def test_the_waiting_list_puts_the_longest_waiting_pull_request_first_and_lists_each_once(self):
        fake = FakeHost([review_notification(12), review_notification(13), review_notification(12)], {
            pull_request_url(12): requested_detail([asked_of_you()], created_at="2026-10-17T09:00:00Z"),
            pull_request_url(13): requested_detail([asked_of_you()], created_at="2026-10-10T09:00:00Z"),
        })
        self.assertEqual([row["number"] for row in waiting_from(fake)], [13, 12])

    def test_your_teammates_open_pull_requests_are_read_in_one_search_that_leaves_you_out(self):
        fake = FakeHost(members=["baker-one", "baker-three", "baker-five"], found=[
            search_result(14, "baker-three", updated_at=YESTERDAY),
            search_result(15, "baker-five", updated_at=TODAY, draft=True),
        ], details={pull_request_url(14): {"reviewDecision": "APPROVED", "statusCheckRollup": [{"conclusion": "FAILURE"}]}, pull_request_url(15): {"reviewDecision": None, "statusCheckRollup": []}})
        waiting, teammates, problems = collect_from(fake)
        [query] = fake.search_queries()
        self.assertIn("author%3Abaker-three+author%3Abaker-five", query)
        self.assertNotIn("baker-one", query)
        self.assertEqual(teammates, [
            {"host": "github.com", "repository": "bakery/ovens", "number": 15, "url": pull_request_url(15), "title": "Rise times 15", "author": "baker-five",
             "draft": True, "review": "", "checks": {"passing": 0, "failing": 0, "running": 0}, "updated_at": TODAY},
            {"host": "github.com", "repository": "bakery/ovens", "number": 14, "url": pull_request_url(14), "title": "Rise times 14", "author": "baker-three",
             "draft": False, "review": "APPROVED", "checks": {"passing": 0, "failing": 1, "running": 0}, "updated_at": YESTERDAY},
        ])

    def test_a_teammates_pull_request_updated_before_the_window_is_left_out(self):
        fake = FakeHost(found=[search_result(14, "baker-three", updated_at="2000-01-01T09:00:00Z")], details={pull_request_url(14): {"reviewDecision": "", "statusCheckRollup": []}})
        waiting, teammates, problems = collect_from(fake)
        self.assertEqual((teammates, problems), ([], []))

    def test_a_host_with_no_team_line_gets_no_teammates_list(self):
        fake = FakeHost(found=[search_result(14, "baker-three")])
        waiting, teammates, problems = collect_from(fake, teams={})
        self.assertEqual((teammates, fake.search_queries()), ([], []))

    def test_a_host_whose_feed_team_or_search_cannot_be_read_is_named_in_problems(self):
        for unreadable in ("notifications", "orgs/bakery/teams/pastry/members", SEARCH_PATH):
            waiting, teammates, problems = collect_from(FakeHost(unreadable=[unreadable]))
            self.assertEqual(problems, ["github.com: HTTP 404: Not Found"], unreadable)

    def test_a_pull_request_that_cannot_be_read_is_named_in_problems_by_its_address(self):
        waiting, teammates, problems = collect_from(FakeHost([review_notification(12)]))
        self.assertEqual(problems, [f"{pull_request_url(12)}: HTTP 404: Not Found"])

    def test_every_call_to_a_host_only_reads(self):
        fake = FakeHost([review_notification(12)], {pull_request_url(12): requested_detail([asked_of_you()])}, found=[search_result(14, "baker-three")])
        collect_from(fake)
        self.assertFalse([command for command in fake.commands if {"-X", "--method", "-f", "-F", "--input"} & set(command)])

    def test_a_full_run_writes_both_lists_into_the_page_data_file_and_the_cache_and_a_cached_run_prints_them(self):
        fake = FakeHost([review_notification(12)], {pull_request_url(12): requested_detail([asked_of_you()])})
        self.run_main([], fake)
        with open(where_i_stand.page_data_path()) as page_data_file:
            data = json.load(page_data_file)
        cached = json.loads(self.run_main(["--cached", "--json"], FakeHost(unreadable=["user"])))
        self.assertEqual([row["number"] for row in data["waiting_for_review"]], [12])
        self.assertEqual(data["teammates"], [])
        self.assertEqual(cached["waiting_for_review"], data["waiting_for_review"])
        self.assertEqual(cached["teammates"], [])

    def test_a_cache_written_before_the_lists_existed_reads_as_empty_lists(self):
        os.makedirs(where_i_stand.cache_folder())
        with open(where_i_stand.cache_path(14), "w") as cache_file:
            json.dump({"written_at": where_i_stand.utc_now().isoformat(), "hosts": [], "prs": [], "problems": []}, cache_file)
        cached = json.loads(self.run_main(["--cached", "--json"], FakeHost()))
        self.assertEqual((cached["waiting_for_review"], cached["teammates"]), ([], []))

    def test_changes_stays_about_your_own_pull_requests(self):
        fake = FakeHost([review_notification(12)], {pull_request_url(12): requested_detail([asked_of_you()])})
        self.run_main([], FakeHost())
        self.assertEqual(self.run_main(["--refresh", "--changes"], fake).strip().splitlines(), ["Nothing changed since the last run."])


if __name__ == "__main__":
    unittest.main()
