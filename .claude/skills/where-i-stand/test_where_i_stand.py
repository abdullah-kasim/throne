import contextlib
import io
import json
import os
import unittest
from unittest import mock

import where_i_stand
from test_review_requests_and_teammates import ReviewRequestsAndTeammatesTest, ScratchCacheAndHostsTest


def pull_request(number, state="OPEN", draft=False, review="", approvals=(), conflicting=False, failing=0, repository="shop/storefront"):
    pr = {
        "host": "github.com",
        "repository": repository,
        "number": number,
        "url": f"https://github.com/{repository}/pull/{number}",
        "title": f"Pull request {number}",
        "summary": f"Summary of pull request {number}",
        "ticket": "",
        "ticket_url": "",
        "kind": "",
        "state": state,
        "draft": draft,
        "review": review,
        "approvals": list(approvals),
        "conflicting": conflicting,
        "checks": {"passing": 0 if failing else 3, "failing": failing, "running": 0},
        "merged_at": "2026-01-02T10:00:00Z" if state == "MERGED" else "",
        "updated_at": f"2026-01-0{number % 9 + 1}T10:00:00Z",
        "size": "2 files, +10 −3",
        "head": "c0ffee",
    }
    pr["standing"] = where_i_stand.standing(pr)
    return pr


def forgejo_pull_request(number, title, state="open", repository="staging/storefront", head="c0ffee", body=None):
    item = {
        "number": number,
        "title": title,
        "body": body or f"Summary of staged pull request {number}.",
        "state": state,
        "html_url": f"https://forge.example.com/{repository}/pulls/{number}",
        "updated_at": "2026-01-05T10:00:00Z",
        "repository": {"full_name": repository},
        "pull_request": {"merged": False, "merged_at": None, "draft": False},
    }
    detail = {"mergeable": True, "head": {"ref": "add/gift-cards", "sha": head}, "changed_files": 2, "additions": 10, "deletions": 3}
    return where_i_stand.forgejo_record("forge.example.com", item, detail)


def github_search_and_detail(number, body, head_branch):
    url = f"https://github.com/shop/storefront/pull/{number}"
    search = [{"url": url, "repository": {"nameWithOwner": "shop/storefront"}, "number": number}]
    detail = {
        "title": f"Pull request {number}",
        "body": body,
        "state": "OPEN",
        "isDraft": False,
        "statusCheckRollup": [],
        "reviews": [],
        "updatedAt": "2026-01-05T10:00:00Z",
        "headRefName": head_branch,
        "headRefOid": "c0ffee",
    }
    return [(search, None), (detail, None)]


def collect_github_pull_request(number, body, head_branch="add/gift-cards"):
    with mock.patch.object(where_i_stand, "run_json", side_effect=github_search_and_detail(number, body, head_branch)):
        prs, problems = where_i_stand.collect(14)
    return prs


def read_page_data():
    with open(where_i_stand.page_data_path()) as page_data_file:
        return json.load(page_data_file)


class WhereIStandTest(ScratchCacheAndHostsTest):
    def run_main(self, arguments, prs=None, problems=()):
        fetch = mock.Mock(return_value=(prs or [], list(problems)))
        output = io.StringIO()
        with mock.patch.object(where_i_stand, "collect", fetch), mock.patch.object(where_i_stand, "collect_others", return_value=([], [], [])), contextlib.redirect_stdout(output):
            exit_status = where_i_stand.main(arguments)
        return exit_status, output.getvalue(), fetch

    def test_a_full_run_writes_a_cache_that_a_later_cached_run_reads_back_exactly_one_file_per_days_window_written_through_a_temp_file_and_a_rename(self):
        prs = [pull_request(1), pull_request(2, state="MERGED")]
        with mock.patch.object(where_i_stand.os, "replace", wraps=os.replace) as rename:
            self.run_main(["--days", "7"], prs, ["git.example.com: could not connect"])
            self.run_main(["--days", "14"], [pull_request(3)])
        cache_renames = [call[0] for call in rename.call_args_list if call[0][1] != where_i_stand.page_data_path()]
        self.assertEqual(len(cache_renames), 2)
        temporary_path, cache_path = cache_renames[0]
        self.assertEqual(os.path.dirname(temporary_path), os.path.dirname(cache_path))
        self.assertEqual(cache_path, where_i_stand.cache_path(7))
        self.assertEqual(sorted(os.listdir(os.path.join(self.cache_home, "where-i-stand"))), ["last-14-days.json", "last-7-days.json", "where-i-stand-prs.json"])
        cache = where_i_stand.read_cache(7)
        self.assertEqual(cache["prs"], prs)
        self.assertEqual(cache["problems"], ["git.example.com: could not connect"])
        self.assertEqual(cache["hosts"], ["github.com"])
        self.assertEqual(where_i_stand.cache_age(cache["written_at"], where_i_stand.utc_now()), "0 min")

    def test_a_cached_run_prints_the_report_from_the_cache_with_its_age_on_the_first_line_and_never_calls_collect(self):
        prs = [pull_request(1, failing=2), pull_request(2, draft=True)]
        _, full_report, _ = self.run_main([], prs)
        exit_status, cached_report, fetch = self.run_main(["--cached"])
        fetch.assert_not_called()
        self.assertEqual(exit_status, 0)
        first_line, report = cached_report.split("\n", 1)
        self.assertEqual(first_line, "from the cache, 0 min old; refreshing in the background")
        self.assertEqual(report, full_report)

    def test_a_cached_run_with_no_cache_says_so_in_one_line_and_exits_non_zero(self):
        exit_status, output, fetch = self.run_main(["--cached"])
        fetch.assert_not_called()
        self.assertEqual(exit_status, 1)
        self.assertEqual(output.strip().splitlines(), ["No cache yet for the last 14 days; run without --cached for the full report."])

    def test_changes_lists_a_pull_request_whose_group_or_state_changed_with_its_old_and_new_state(self):
        self.run_main([], [pull_request(1, draft=True, conflicting=True)])
        _, output, _ = self.run_main(["--refresh", "--changes"], [pull_request(1, review="APPROVED", approvals=["reviewer"])])
        self.assertEqual(output.strip().splitlines(), [
            "- changed: [storefront #1](https://github.com/shop/storefront/pull/1): needs you (draft, CI green, conflicts) → ready to merge (CI green, approved by reviewer)",
        ])

    def test_changes_lists_a_pull_request_that_is_new_since_the_last_run(self):
        self.run_main([], [pull_request(1)])
        _, output, _ = self.run_main(["--refresh", "--changes"], [pull_request(1), pull_request(2, draft=True)])
        self.assertEqual(output.strip().splitlines(), ["- new: [storefront #2](https://github.com/shop/storefront/pull/2): draft (draft, CI green)"])

    def test_changes_lists_a_pull_request_that_is_gone_since_the_last_run(self):
        self.run_main([], [pull_request(1), pull_request(2)])
        _, output, _ = self.run_main(["--refresh", "--changes"], [pull_request(1)])
        self.assertEqual(output.strip().splitlines(), ["- gone: [storefront #2](https://github.com/shop/storefront/pull/2): waiting on review (CI green)"])

    def test_changes_prints_one_line_when_nothing_changed(self):
        self.run_main([], [pull_request(1), pull_request(2)])
        _, output, _ = self.run_main(["--refresh", "--changes"], [pull_request(1), pull_request(2)])
        self.assertEqual(output.strip().splitlines(), ["Nothing changed since the last run."])

    def test_merged_pull_requests_are_hidden_from_the_markdown_and_changes_by_default(self):
        self.run_main([], [pull_request(1), pull_request(2, state="MERGED")])
        _, report, _ = self.run_main([], [pull_request(1), pull_request(2, state="MERGED"), pull_request(3, state="CLOSED")])
        _, change_report, _ = self.run_main(["--changes"], [pull_request(1, state="MERGED"), pull_request(2, state="MERGED"), pull_request(3, state="CLOSED"), pull_request(4, state="MERGED")])
        self.assertNotIn("## Merged", report)
        self.assertEqual(change_report.strip().splitlines(), ["- gone: [storefront #1](https://github.com/shop/storefront/pull/1): waiting on review (CI green)"])

    def test_include_merged_brings_merged_pull_requests_back(self):
        self.run_main([], [pull_request(1)])
        _, report, _ = self.run_main(["--include-merged"], [pull_request(1), pull_request(2, state="MERGED")])
        rows = read_page_data()["rows"]
        _, change_report, _ = self.run_main(["--changes", "--include-merged"], [pull_request(1, state="MERGED"), pull_request(2, state="MERGED")])
        self.assertIn("## Merged (1)", report)
        self.assertEqual([row["group"] for row in rows], ["Waiting on review", "Merged"])
        self.assertEqual(change_report.strip().splitlines(), [
            "- changed: [storefront #1](https://github.com/shop/storefront/pull/1): waiting on review (CI green) → merged (CI green, merged 2026-01-02)",
        ])

    def test_closed_pull_requests_are_hidden_from_the_markdown_the_records_and_changes_by_default(self):
        self.run_main([], [pull_request(1), pull_request(2)])
        _, report, _ = self.run_main([], [pull_request(1), pull_request(3, state="CLOSED")])
        _, records, _ = self.run_main(["--json"], [pull_request(1), pull_request(3, state="CLOSED")])
        self.assertNotIn("## Closed", report)
        self.assertNotIn("/pull/3", records)

    def test_a_pull_request_closed_since_the_last_run_shows_as_gone_in_changes(self):
        self.run_main([], [pull_request(1), pull_request(2)])
        _, change_report, _ = self.run_main(["--changes"], [pull_request(1), pull_request(2, state="CLOSED")])
        self.assertEqual(change_report.strip().splitlines(), ["- gone: [storefront #2](https://github.com/shop/storefront/pull/2): waiting on review (CI green)"])

    def test_include_closed_brings_closed_pull_requests_back(self):
        _, report, _ = self.run_main(["--include-closed"], [pull_request(1), pull_request(3, state="CLOSED")])
        self.assertIn("## Closed (1)", report)
        self.assertEqual([row["group"] for row in read_page_data()["rows"]], ["Waiting on review", "Closed"])

    def test_include_merged_and_include_closed_together_show_both_finished_groups(self):
        _, report, _ = self.run_main(["--include-merged", "--include-closed"], [pull_request(1), pull_request(2, state="MERGED"), pull_request(3, state="CLOSED")])
        self.assertIn("## Merged (1)", report)
        self.assertIn("## Closed (1)", report)

    def test_a_staging_title_gives_up_its_draft_prefix_and_its_github_marker(self):
        self.assertEqual(where_i_stand.split_staging_title("WIP: [GH-##] Add gift cards"), {"draft": True, "github_number": None, "title": "Add gift cards"})
        self.assertEqual(where_i_stand.split_staging_title("[GH-31] Add gift cards"), {"draft": False, "github_number": 31, "title": "Add gift cards"})
        self.assertEqual(where_i_stand.split_staging_title("Add gift cards"), {"draft": False, "github_number": None, "title": "Add gift cards"})

    def test_a_forgejo_pull_request_that_is_not_on_github_yet_gets_its_own_group_with_a_clean_title(self):
        staged = forgejo_pull_request(4, "WIP: [GH-##] Add gift cards")
        _, report, _ = self.run_main([], [pull_request(1), staged])
        self.assertEqual(staged["title"], "Add gift cards")
        self.assertIn("## Forgejo only (1)", report)
        self.assertIn("| [storefront #4](https://forge.example.com/staging/storefront/pulls/4) | Summary of staged pull request 4. | draft, not on GitHub yet |", report)

    def test_a_forgejo_copy_of_a_listed_github_pull_request_is_folded_into_that_row_and_not_listed_twice(self):
        kept = where_i_stand.fold_staged_copies([pull_request(31), forgejo_pull_request(4, "[GH-31] Add gift cards")])
        _, report, _ = self.run_main([], kept)
        self.assertEqual([pr["number"] for pr in kept], [31])
        self.assertIn("CI green, [staged in Forgejo](https://forge.example.com/staging/storefront/pulls/4) |", report)
        self.assertNotIn("## Forgejo only", report)

    def test_a_forgejo_copy_whose_github_pull_request_was_not_found_stays_listed_and_says_so(self):
        kept = where_i_stand.fold_staged_copies([pull_request(1), forgejo_pull_request(4, "[GH-31] Add gift cards")])
        _, report, _ = self.run_main([], kept)
        self.assertEqual([pr["number"] for pr in kept], [1, 4])
        self.assertIn("staging copy of GitHub #31, which this report did not find", report)

    def test_a_closed_forgejo_pull_request_is_hidden_like_any_closed_one(self):
        _, report, _ = self.run_main([], [pull_request(1), forgejo_pull_request(4, "[GH-##] Add gift cards", state="closed")])
        self.assertNotIn("forge.example.com", report)

    def test_a_forgejo_line_in_the_hosts_file_names_the_root_address_and_the_token_file_and_leaves_the_github_hosts_alone(self):
        hosts_file = os.path.join(self.cache_home, "hosts")
        with open(hosts_file, "w") as hosts:
            hosts.write("git.example.com ghe\nforgejo https://forge.example.com:8443/ /keys/forge-token\n")
        with mock.patch.object(where_i_stand, "HOSTS_FILE", hosts_file):
            self.assertEqual(where_i_stand.configured_hosts(), [("github.com", "gh"), ("git.example.com", "ghe")])
            self.assertEqual(where_i_stand.configured_forges(), [("https://forge.example.com:8443", "/keys/forge-token")])
            self.assertEqual(where_i_stand.host_names(), ["github.com", "git.example.com", "forge.example.com:8443"])

    def test_the_readers_search_on_a_host_carries_only_the_owners_its_owner_lines_name(self):
        hosts_file = os.path.join(self.cache_home, "hosts")
        with open(hosts_file, "w") as hosts:
            hosts.write("git.example.com ghe\nowner github.com bakery\nowner github.com pastry-shop\n")
        search = mock.Mock(return_value=([], None))
        with mock.patch.object(where_i_stand, "HOSTS_FILE", hosts_file), mock.patch.object(where_i_stand, "run_json", search):
            where_i_stand.collect(14)
        searches = {command[0]: command for command, in (call.args for call in search.call_args_list)}
        self.assertEqual(search.call_count, 2)
        self.assertIn("--owner bakery --owner pastry-shop", " ".join(searches["gh"]))
        self.assertNotIn("--owner", searches["ghe"])

    def test_a_forgejo_host_whose_token_file_is_missing_is_reported_as_unreadable(self):
        prs, problems = where_i_stand.collect_forgejo("https://forge.example.com", os.path.join(self.cache_home, "no-token"), "2026-01-01")
        self.assertEqual(prs, [])
        self.assertIn("forge.example.com: cannot read its token file", problems[0])

    def test_the_page_data_file_never_names_a_token_file(self):
        missing_token_file = os.path.join(self.cache_home, "forge-token")
        hosts_file = os.path.join(self.cache_home, "hosts")
        with open(hosts_file, "w") as hosts:
            hosts.write(f"forgejo https://forge.example.com {missing_token_file}\n")
        with mock.patch.object(where_i_stand, "HOSTS_FILE", hosts_file), mock.patch.object(where_i_stand, "run_json", return_value=([], None)), mock.patch.object(where_i_stand, "collect_others", return_value=([], [], [])), contextlib.redirect_stdout(io.StringIO()):
            where_i_stand.main([])
        with open(where_i_stand.page_data_path()) as page_data_file:
            page_data_text = page_data_file.read()
        self.assertIn("forge.example.com: cannot read its token file", page_data_text)
        self.assertNotIn(missing_token_file, page_data_text)

    def test_a_full_run_writes_the_page_data_file_with_the_read_time_the_window_the_problems_the_change_lines_and_the_rows(self):
        self.run_main(["--days", "7"], [pull_request(1)], ["git.example.com: could not connect"])
        data = read_page_data()
        self.assertEqual(where_i_stand.cache_age(data["read_at"], where_i_stand.utc_now()), "0 min")
        self.assertEqual(data["days"], 7)
        self.assertEqual(data["problems"], ["git.example.com: could not connect"])
        self.assertEqual(data["changes"], ["new: [storefront #1](https://github.com/shop/storefront/pull/1): waiting on review (CI green)"])
        self.assertEqual(data["rows"], [{
            "group": "Waiting on review",
            "repository": "shop/storefront",
            "title": "Pull request 1",
            "ticket": "",
            "ticket_url": "",
            "kind": "",
            "summary": "Summary of pull request 1",
            "forgejo": None,
            "github": {"url": "https://github.com/shop/storefront/pull/1", "number": 1, "state": "ready, CI green"},
            "head_commits": "",
        }])

    def test_a_forgejo_pull_request_and_its_github_twin_are_one_row_in_the_page_data_file_with_both_sides_links_and_states(self):
        self.run_main([], where_i_stand.fold_staged_copies([pull_request(31, draft=True), forgejo_pull_request(4, "WIP: [GH-31] Add gift cards")]))
        [row] = read_page_data()["rows"]
        self.assertEqual(row["group"], "Draft")
        self.assertEqual(row["forgejo"], {"url": "https://forge.example.com/staging/storefront/pulls/4", "number": 4, "state": "draft"})
        self.assertEqual(row["github"], {"url": "https://github.com/shop/storefront/pull/31", "number": 31, "state": "draft, CI green"})

    def test_a_forgejo_pull_request_that_is_not_on_github_yet_is_a_row_of_its_own_with_no_github_side(self):
        self.run_main([], where_i_stand.fold_staged_copies([forgejo_pull_request(4, "[GH-##] Add gift cards")]))
        [row] = read_page_data()["rows"]
        self.assertEqual(row["group"], "Forgejo only")
        self.assertEqual(row["repository"], "staging/storefront")
        self.assertEqual(row["title"], "Add gift cards")
        self.assertEqual(row["forgejo"], {"url": "https://forge.example.com/staging/storefront/pulls/4", "number": 4, "state": "open"})
        self.assertIsNone(row["github"])
        self.assertEqual(row["head_commits"], "")

    def test_a_github_pull_request_with_no_forgejo_copy_is_a_row_with_no_forgejo_side(self):
        self.run_main([], [pull_request(1, failing=2, conflicting=True)])
        [row] = read_page_data()["rows"]
        self.assertIsNone(row["forgejo"])
        self.assertEqual(row["github"]["state"], "ready, CI 2 failing, conflicts")

    def test_the_page_data_file_says_the_two_sides_are_in_sync_when_they_hold_the_same_head_commit(self):
        self.run_main([], where_i_stand.fold_staged_copies([pull_request(31), forgejo_pull_request(4, "[GH-31] Add gift cards")]))
        self.assertEqual([row["head_commits"] for row in read_page_data()["rows"]], ["in sync"])

    def test_the_page_data_file_says_github_is_behind_forgejo_when_the_two_head_commits_differ(self):
        self.run_main([], where_i_stand.fold_staged_copies([pull_request(32), forgejo_pull_request(5, "[GH-32] Add gift wrap", head="facade")]))
        self.assertEqual([row["head_commits"] for row in read_page_data()["rows"]], ["GitHub behind Forgejo"])

    def test_a_pull_request_row_links_the_ticket_its_body_links_to(self):
        prs = collect_github_pull_request(31, "Adds gift cards, see https://docs.example.com/cards.\n\nTicket: [SHOP-12](https://tracker.example.com/shop/issue/shop-12/gift-cards)")
        staged = forgejo_pull_request(4, "[GH-##] Add gift wrap", body="Wraps gifts. https://tracker.example.com/shop/issue/SHOP-13")
        self.run_main([], prs + [staged])
        self.assertEqual({row["title"]: (row["ticket"], row["ticket_url"]) for row in read_page_data()["rows"]}, {
            "Pull request 31": ("SHOP-12", "https://tracker.example.com/shop/issue/shop-12/gift-cards"),
            "Add gift wrap": ("SHOP-13", "https://tracker.example.com/shop/issue/SHOP-13"),
        })

    def test_a_github_pull_request_whose_body_has_no_ticket_link_takes_the_ticket_link_of_its_forgejo_copy(self):
        prs = collect_github_pull_request(31, "Adds gift cards.")
        staged = forgejo_pull_request(4, "[GH-31] Add gift cards", body="Ticket: [SHOP-12](https://tracker.example.com/shop/issue/SHOP-12)")
        self.run_main([], where_i_stand.fold_staged_copies(prs + [staged]))
        self.assertEqual([row["ticket_url"] for row in read_page_data()["rows"]], ["https://tracker.example.com/shop/issue/SHOP-12"])

    def test_a_github_pull_request_that_fixes_an_issue_links_that_issue_as_its_ticket(self):
        prs = collect_github_pull_request(31, "Adds gift cards.\n\ncloses #7")
        prs += collect_github_pull_request(32, "Adds gift wrap, asked for in https://github.com/shop/storefront/issues/9.")
        self.run_main([], prs)
        self.assertEqual({row["github"]["number"]: row["ticket_url"] for row in read_page_data()["rows"]}, {
            31: "https://github.com/shop/storefront/issues/7",
            32: "https://github.com/shop/storefront/issues/9",
        })

    def test_a_pull_request_with_no_ticket_link_has_an_empty_ticket_link(self):
        prs = collect_github_pull_request(31, "Adds gift cards for SHOP-12, see https://docs.example.com/cards and #7.")
        self.run_main([], prs + [forgejo_pull_request(4, "[GH-##] Add gift wrap")])
        self.assertEqual([row["ticket_url"] for row in read_page_data()["rows"]], ["", ""])

    def test_a_pull_request_row_says_what_sort_of_work_its_branch_name_declares(self):
        branches = {31: "fix/card-total", 32: "add/gift-cards", 33: "update/checkout-copy", 34: "try/one-page-checkout", 35: "remove/old-coupons", 36: "gift-cards"}
        prs = [pr for number, branch in branches.items() for pr in collect_github_pull_request(number, "", branch)]
        self.run_main([], prs + [forgejo_pull_request(4, "[GH-##] Add gift wrap")])
        self.assertEqual({(row["github"] or row["forgejo"])["url"].split("/")[-1]: row["kind"] for row in read_page_data()["rows"]}, {
            "31": "bug fix", "32": "new feature", "33": "change", "34": "experiment", "35": "removal", "36": "", "4": "new feature",
        })

    def test_the_page_data_file_leaves_out_merged_and_closed_pull_requests_by_default_and_orders_rows_by_group(self):
        prs = [
            pull_request(1, draft=True),
            pull_request(2, state="MERGED"),
            pull_request(3, state="CLOSED"),
            pull_request(4),
            pull_request(5, review="APPROVED", approvals=["reviewer"]),
            pull_request(6, failing=1),
            pull_request(7),
            forgejo_pull_request(8, "[GH-##] Add gift cards"),
        ]
        self.run_main([], prs)
        rows = read_page_data()["rows"]
        self.assertEqual([(row["group"], (row["github"] or row["forgejo"])["number"]) for row in rows], [
            ("Needs you", 6),
            ("Ready to merge", 5),
            ("Waiting on review", 7),
            ("Waiting on review", 4),
            ("Draft", 1),
            ("Forgejo only", 8),
        ])

    def test_the_change_lines_are_written_into_the_page_data_file_on_every_full_run(self):
        self.run_main([], [pull_request(1), pull_request(2)])
        self.run_main(["--refresh"], [pull_request(1)])
        self.assertEqual(read_page_data()["changes"], ["gone: [storefront #2](https://github.com/shop/storefront/pull/2): waiting on review (CI green)"])
        self.run_main(["--refresh", "--changes"], [pull_request(1)])
        self.assertEqual(read_page_data()["changes"], ["Nothing changed since the last run."])

    def test_a_cached_run_leaves_the_page_data_file_untouched(self):
        self.run_main([], [pull_request(1)])
        before = read_page_data()
        with mock.patch.object(where_i_stand, "write_page_data", wraps=where_i_stand.write_page_data) as write:
            self.run_main(["--cached"])
        write.assert_not_called()
        self.assertEqual(read_page_data(), before)

    def test_the_page_data_file_is_written_through_a_temporary_file_and_a_rename(self):
        with mock.patch.object(where_i_stand.os, "replace", wraps=os.replace) as rename:
            self.run_main([], [pull_request(1)])
        temporary_path, page_data_path = rename.call_args_list[-1][0]
        self.assertEqual(page_data_path, where_i_stand.page_data_path())
        self.assertEqual(os.path.dirname(temporary_path), os.path.dirname(page_data_path))
        self.assertNotEqual(temporary_path, page_data_path)


if __name__ == "__main__":
    unittest.main()
