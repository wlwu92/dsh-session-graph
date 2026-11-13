#!/usr/bin/env python3
"""Unit tests for the summarizer pipeline (no network, no real sessions).

Run with `python3 test/summarize_sessions_test.py` (or `npm test`).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "lib"))

import summarize_sessions as summarizer  # noqa: E402


def make_event(kind: str, seq: int, text: str = "", source: str = "") -> dict:
    if kind == "user/message":
        return {
            "type": kind,
            "seq": seq,
            "data": {
                "source": {"kind": source or "user"},
                "content": [{"type": "text", "text": text}],
            },
        }
    if kind == "assistant/message":
        return {
            "type": kind,
            "seq": seq,
            "data": {
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": text}],
                }
            },
        }
    if kind == "tool/result":
        return {
            "type": kind,
            "seq": seq,
            "data": {"message": {"role": "tool", "content": [{"type": "text", "text": text}]}},
        }
    return {"type": kind, "seq": seq, "data": {}}


def zstd_available() -> bool:
    return shutil.which("zstd") is not None


class EvidenceTest(unittest.TestCase):
    def test_url_and_word_evidence(self) -> None:
        catalog = [{"number": 646, "headRefName": "fix/query-schema-forward-compat"}]
        events = [
            make_event("user/message", 4, "please land PR https://github.com/acme/demo/pull/646"),
            make_event("assistant/message", 10, "merged #646 on fix/query-schema-forward-compat"),
        ]
        evidence = summarizer.grep_pr_evidence(events, "acme/demo", catalog)
        self.assertEqual([item["number"] for item in evidence], [646])
        self.assertIn("pull/646", evidence[0]["url"])

    def test_bulk_tool_listing_is_not_evidence(self) -> None:
        catalog = [{"number": number} for number in range(600, 610)]
        urls = "\n".join(
            f'{{"number":{number},"url":"https://github.com/acme/demo/pull/{number}"}}'
            for number in range(600, 610)
        )
        evidence = summarizer.grep_pr_evidence(
            [make_event("tool/result", 20, urls)], "acme/demo", catalog
        )
        self.assertEqual(evidence, [])

    def test_foreign_repo_is_ignored(self) -> None:
        events = [make_event("assistant/message", 5, "https://github.com/other/repo/pull/9")]
        self.assertEqual(summarizer.grep_pr_evidence(events, "acme/demo", []), [])


class BudgetTest(unittest.TestCase):
    def test_large_user_message_is_trimmed_under_budget(self) -> None:
        bundle = {
            "incremental": False,
            "previousSummary": None,
            "userMessages": [{"seq": 1, "text": "新需求 " * 40_000}],
            "turnSummaries": [],
            "recentOutputs": [],
            "prEvidence": [{"number": 1, "url": "", "source": "assistant", "snippet": "x" * 300}],
        }
        prompt, tokens = summarizer.pack_summary_input(bundle, None, [])
        self.assertLessEqual(tokens, summarizer.MAX_SUMMARY_TOKENS)
        self.assertLessEqual(summarizer.estimate_tokens(prompt), summarizer.MAX_SUMMARY_TOKENS)


class CredentialTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_credentials_file_carries_the_account_token(self) -> None:
        (self.tmp / ".credentials.yaml").write_text(
            "version: 1\n"
            "records:\n"
            "  client-connection/browser-session:\n"
            "    kind: grant\n"
            "    payload:\n"
            "      secret: not-the-token\n"
            "  deepseek-account-platform/default:\n"
            "    kind: grant\n"
            "    payload:\n"
            "      version: 1\n"
            "      token: \"tok-123\"\n"
            "      issuer: https://platform.deepseek.com\n"
            "refs:\n"
            "  DEEPSEEK_API_KEY: sk-test\n"
        )
        self.assertEqual(summarizer.account_token_from_file(self.tmp), "tok-123")
        self.assertEqual(
            summarizer.credential_from_file(self.tmp, "DEEPSEEK_API_KEY"), "sk-test"
        )

    def test_auto_prefers_the_account_route_on_the_public_endpoint(self) -> None:
        credentials = summarizer.resolve_credentials(
            "auto",
            base_url=summarizer.DEFAULT_BASE_URL,
            account_token="tok",
            api_key="sk",
            api_key_source="env",
        )
        self.assertEqual([item[0] for item in credentials], ["account", "api-key"])

    def test_auto_prefers_the_api_key_for_a_custom_proxy(self) -> None:
        credentials = summarizer.resolve_credentials(
            "auto",
            base_url="https://proxy.example/anthropic",
            account_token="tok",
            api_key="sk",
            api_key_source="env",
        )
        self.assertEqual([item[0] for item in credentials], ["api-key", "account"])

    def test_explicit_auth_selects_one_route(self) -> None:
        account = summarizer.resolve_credentials(
            "account",
            base_url=summarizer.DEFAULT_BASE_URL,
            account_token="tok",
            api_key="sk",
            api_key_source="env",
        )
        api = summarizer.resolve_credentials(
            "api-key",
            base_url=summarizer.DEFAULT_BASE_URL,
            account_token="tok",
            api_key="sk",
            api_key_source="env",
        )
        self.assertEqual([item[0] for item in account], ["account"])
        self.assertEqual([item[0] for item in api], ["api-key"])

    def test_call_llm_sends_the_selected_auth_header(self) -> None:
        seen: list[dict] = []

        class Response:
            def __enter__(self) -> "Response":
                return self

            def __exit__(self, *_args: object) -> bool:
                return False

            def read(self) -> bytes:
                return json.dumps(
                    {
                        "content": [{"type": "text", "text": "ok"}],
                        "usage": {"input_tokens": 1, "output_tokens": 1},
                    }
                ).encode()

        def fake_urlopen(request: object, timeout: int) -> Response:
            seen.append({str(key).lower(): value for key, value in request.headers.items()})
            return Response()

        original = summarizer.urllib.request.urlopen
        summarizer.urllib.request.urlopen = fake_urlopen  # type: ignore[assignment]
        self.addCleanup(setattr, summarizer.urllib.request, "urlopen", original)
        summarizer.call_llm(
            "https://api.deepseek.com/anthropic",
            "deepseek-flash",
            "tok-1",
            "hi",
            5,
            auth="account",
        )
        summarizer.call_llm(
            "https://api.deepseek.com/anthropic",
            "deepseek-flash",
            "sk-1",
            "hi",
            5,
            auth="api-key",
        )
        self.assertEqual(seen[0].get("x-dsh-auth-token"), "tok-1")
        self.assertNotIn("x-api-key", seen[0])
        self.assertEqual(seen[1].get("x-api-key"), "sk-1")
        self.assertNotIn("x-dsh-auth-token", seen[1])

    def test_call_model_falls_back_only_on_auth_rejections(self) -> None:
        seen: list[str] = []

        def fake(base: str, model: str, credential: str, prompt: str, timeout: int, *,
                 auth: str = "api-key", **_: object) -> str:
            seen.append(auth)
            if auth == "account":
                raise RuntimeError("HTTP 401: account token rejected")
            return "ok"

        original = summarizer.call_llm
        summarizer.call_llm = fake  # type: ignore[assignment]
        self.addCleanup(setattr, summarizer, "call_llm", original)
        self.addCleanup(summarizer.USAGE.update, {"auth_failed": False})
        credentials = [("account", "tok", "DSH account token"), ("api-key", "sk", "env")]
        self.assertEqual(
            summarizer.call_model(
                credentials, "https://api.deepseek.com/anthropic", "deepseek-flash", "p", 5,
                max_tokens=1, system="s",
            ),
            "ok",
        )
        self.assertEqual(seen, ["account", "api-key"])
        self.assertFalse(summarizer.USAGE["auth_failed"])

        seen.clear()

        def reject(*_args: object, **_kwargs: object) -> str:
            raise RuntimeError("HTTP 400: model rejected the prompt")

        summarizer.call_llm = reject  # type: ignore[assignment]
        self.assertIsNone(
            summarizer.call_model(
                credentials, "https://api.deepseek.com/anthropic", "deepseek-flash", "p", 5,
                max_tokens=1, system="s",
            )
        )
        self.assertEqual(seen, [])
        self.assertFalse(summarizer.USAGE["auth_failed"])


class FreshnessTest(unittest.TestCase):
    def entry(self, **overrides: object) -> dict:
        entry = {
            "summary": "已交付。",
            "summarizedTaxonomy": "t",
            "summarizedVersion": summarizer.SUMMARY_VERSION,
            "summarizedTurnSeq": 7,
            "summarizedSeq": 9,
            "summarizedTurnOpen": False,
        }
        entry.update(overrides)
        return entry

    def test_provisional_open_turn_summary_is_never_current(self) -> None:
        entry = self.entry(summarizedTurnOpen=True)
        self.assertFalse(
            summarizer.summary_is_current(entry, {"turnSeq": 7, "turnOpen": False}, "t")
        )

    def test_finished_unchanged_summary_is_current(self) -> None:
        self.assertTrue(
            summarizer.summary_is_current(self.entry(), {"turnSeq": 7, "turnOpen": False}, "t")
        )


@unittest.skipUnless(zstd_available(), "zstd is required to write a synthetic session log")
class MainPipelineTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = self.tmp / "home"
        self.project = self.tmp / "project"
        self.project.mkdir()
        (self.home / "storages" / "session_projcache" / "sessions").mkdir(parents=True)
        (self.home / "storages" / "workspace.json").write_text(
            json.dumps(
                {
                    "tables": {"workspaces": {}},
                    "global": {"archivedSessionIds": []},
                }
            )
        )
        self.session_id = "session-test-0001"
        self.events = [
            make_event("user/message", 4, "please ship https://github.com/acme/demo/pull/646"),
            make_event("assistant/message", 10, "shipped PR https://github.com/acme/demo/pull/646"),
            make_event("turn/end", 12),
        ]
        self.turns = [
            {"seq": 4, "prompt": "please ship", "response": "shipped #646"},
        ]
        self.open_turn = False
        self.write_session()
        self.graph = self.tmp / "DSH_SESSION_GRAPH.md"
        self.write_graph(
            {
                "version": 3,
                "title": "demo",
                "repo": "acme/demo",
                "taxonomy": {
                    "dimensions": [
                        {
                            "id": "delivery",
                            "name": "交付",
                            "tags": [{"id": "release", "name": "发布"}],
                        }
                    ],
                    "updatedAt": "2026-01-01T00:00:00+00:00",
                },
                "pullRequests": [
                    {
                        "number": 646,
                        "title": "ship it",
                        "url": "https://github.com/acme/demo/pull/646",
                        "state": "OPEN",
                    }
                ],
                "sessions": [],
            }
        )
        self.prompts: list[str] = []
        summarizer.USAGE.update(
            {"calls": 0, "input": 0, "output": 0, "auth_failed": False}
        )
        self._original_call = summarizer.call_llm
        summarizer.call_llm = self.fake_call  # type: ignore[assignment]
        self.addCleanup(setattr, summarizer, "call_llm", self._original_call)
        os.environ["DSH_SESSION_GRAPH_BACKGROUND_PR"] = "0"
        self.addCleanup(os.environ.pop, "DSH_SESSION_GRAPH_BACKGROUND_PR", None)
        previous_key = os.environ.get("DEEPSEEK_API_KEY")
        os.environ["DEEPSEEK_API_KEY"] = "test-key"
        self.addCleanup(
            lambda: os.environ.__setitem__("DEEPSEEK_API_KEY", previous_key)
            if previous_key is not None
            else os.environ.pop("DEEPSEEK_API_KEY", None)
        )

    def fake_call(self, base: str, model: str, api_key: str, prompt: str, timeout: int, **_: object) -> str:
        self.prompts.append(prompt)
        return json.dumps(
            {
                "title": "交付：透传字段",
                "summary": "把字段透传给前端。",
                "dimensions": {"delivery": ["release"]},
                "prs": [646],
            },
            ensure_ascii=False,
        )

    def write_session(self) -> None:
        rows = {
            "workingDirectory": {"val": str(self.project), "seq": 60},
            "title": {"val": "Old title", "seq": 60},
            "turnOutline": {"val": {"turns": self.turns}, "seq": 60},
            "turnBoundary": {
                "val": {"openTurnStartSeq": 4 if self.open_turn else None},
                "seq": 60,
            },
        }
        (self.home / "storages" / "session_projcache" / "sessions" / f"{self.session_id}.json").write_text(
            json.dumps(
                {
                    "record": {
                        "rows": rows,
                        "identity": {"cwd": str(self.project), "createdAt": 1},
                    }
                }
            )
        )
        log_dir = self.home / "sessions" / "--project--" / self.session_id
        log_dir.mkdir(parents=True, exist_ok=True)
        raw = "\n".join(json.dumps(event) for event in self.events) + "\n"
        compressed = subprocess.run(
            ["zstd", "-q", "-c"],
            input=raw.encode(),
            capture_output=True,
            check=True,
        ).stdout
        (log_dir / "session.v4.jsonl.zstd").write_bytes(compressed)

    def write_graph(self, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False, indent=2)
        self.graph.write_text(f"# 会话图\n\n```json\n{body}\n```\n")

    def read_graph(self) -> dict:
        text = self.graph.read_text()
        start = text.index("```json") + 7
        end = text.index("```", start)
        return json.loads(text[start:end])

    def run_main(self, *extra: str) -> None:
        original_argv = sys.argv
        sys.argv = [
            "summarize_sessions",
            "--project",
            str(self.project),
            "--graph",
            str(self.graph),
            "--dsh-home",
            str(self.home),
            "--mode",
            "sessions",
            "--write",
            "--no-prs",
            "--quiet",
            *extra,
        ]
        try:
            summarizer.main()
        finally:
            sys.argv = original_argv

    def run_prs(self, *extra: str) -> None:
        original_argv = sys.argv
        sys.argv = [
            "summarize_sessions",
            "--project",
            str(self.project),
            "--graph",
            str(self.graph),
            "--dsh-home",
            str(self.home),
            "--mode",
            "prs",
            "--write",
            "--quiet",
            *extra,
        ]
        try:
            summarizer.main()
        finally:
            sys.argv = original_argv

    def test_summary_owns_pr_association_and_bookmarks(self) -> None:
        self.run_main("--force")
        payload = self.read_graph()
        entry = payload["sessions"][0]
        self.assertEqual(entry["pullRequests"], [646])
        self.assertEqual(entry["summarizedVersion"], summarizer.SUMMARY_VERSION)
        self.assertEqual(entry["summarizedSeq"], 12)
        self.assertEqual(entry["summarizedTurnSeq"], 4)
        self.assertIn("please ship https://github.com/acme/demo/pull/646", self.prompts[0])
        self.assertIn('"number": 646', self.prompts[0])
        # Summaries never touch the GitHub catalog timestamp.
        self.assertNotIn("prUpdatedAt", payload)

    def test_auth_failure_is_not_reported_as_a_successful_no_op(self) -> None:
        def reject(*_args: object, **_kwargs: object) -> str:
            raise RuntimeError("HTTP 401: invalid api key")

        summarizer.call_llm = reject  # type: ignore[assignment]
        with self.assertRaises(SystemExit) as caught:
            self.run_main()
        self.assertEqual(caught.exception.code, 1)
        self.assertEqual(self.read_graph()["sessions"], [])

    def test_incremental_reuses_previous_summary(self) -> None:
        self.run_main("--force")
        first = self.read_graph()["sessions"][0]
        # A new turn arrives after the first summary.
        self.events.extend(
            [
                make_event("user/message", 42, "now add a second change"),
                make_event(
                    "assistant/message",
                    50,
                    "done https://github.com/acme/demo/pull/700",
                ),
                make_event("turn/end", 52),
            ]
        )
        self.turns.append({"seq": 42, "prompt": "now add a second change", "response": "done #700"})
        self.write_session()
        self.run_main()
        payload = self.read_graph()
        entry = payload["sessions"][0]
        prompt = self.prompts[-1]
        self.assertIn(json.dumps(first["summary"], ensure_ascii=False)[1:-1], prompt)
        self.assertIn("now add a second change", prompt)
        # Old user text is not re-sent in incremental mode.
        self.assertNotIn("please ship https://github.com/acme/demo/pull/646", prompt)
        self.assertEqual(entry["pullRequests"], [646, 700])
        self.assertEqual(entry["summarizedTurnSeq"], 42)
        self.assertEqual(entry["summarizedSeq"], 52)

    def test_progress_file_is_written_for_the_panel(self) -> None:
        self.run_main("--force")
        progress_path = self.project / summarizer.PROGRESS_FILENAME
        self.assertTrue(progress_path.exists(), "the panel needs a progress file while the command runs")
        data = json.loads(progress_path.read_text())
        self.assertEqual(data["state"], "done")
        self.assertEqual(data["phase"], "done")
        self.assertEqual(data["total"], 1)
        self.assertEqual(data["completed"], 1)
        self.assertIn("updatedAt", data)

    def test_progress_total_excludes_up_to_date_sessions(self) -> None:
        self.run_main("--force")
        reports = []
        original = summarizer.write_progress
        summarizer.write_progress = (  # type: ignore[assignment]
            lambda _path, **fields: reports.append(fields)
        )
        try:
            self.run_main()
        finally:
            summarizer.write_progress = original  # type: ignore[assignment]
        session_reports = [item for item in reports if item.get("phase") == "sessions"]
        self.assertTrue(session_reports, "the session phase must still be published")
        self.assertEqual(session_reports[0]["total"], 0, "an up-to-date session is not pending work")
        self.assertEqual(session_reports[0]["skipped"], 1)
        self.assertEqual(reports[-1]["total"], 0)

    def test_progress_reports_total_and_completed_sessions(self) -> None:
        reports = []
        original = summarizer.write_progress
        summarizer.write_progress = (  # type: ignore[assignment]
            lambda _path, **fields: reports.append(fields)
        )
        try:
            self.run_main("--force")
        finally:
            summarizer.write_progress = original  # type: ignore[assignment]
        session_reports = [item for item in reports if item.get("phase") == "sessions"]
        self.assertTrue(session_reports, "session progress must be published")
        self.assertEqual(session_reports[0]["total"], 1)
        self.assertTrue(any(item.get("completed") == 1 for item in session_reports))
        self.assertTrue(any(item.get("current") for item in session_reports))
        self.assertEqual(reports[-1]["phase"], "done")

    def test_pr_refresh_if_stale_skips_a_fresh_catalog(self) -> None:
        payload = self.read_graph()
        payload["prUpdatedAt"] = summarizer.now_iso()
        self.write_graph(payload)
        original = summarizer.gh_pr_catalog
        summarizer.gh_pr_catalog = lambda *_args, **_kwargs: (_ for _ in ()).throw(  # type: ignore[assignment]
            AssertionError("a fresh catalog must not call gh")
        )
        try:
            self.run_prs("--if-stale")
        finally:
            summarizer.gh_pr_catalog = original  # type: ignore[assignment]
        self.assertIn("prUpdatedAt", self.read_graph())

    def test_pr_refresh_if_stale_refreshes_an_old_catalog(self) -> None:
        payload = self.read_graph()
        payload["prUpdatedAt"] = "2020-01-01T00:00:00+00:00"
        self.write_graph(payload)
        calls = []

        def fake_catalog(repo: str, limit: int = 300) -> list[dict]:
            calls.append((repo, limit))
            return [{"number": 646, "title": "ship it", "state": "MERGED", "url": ""}]

        original = summarizer.gh_pr_catalog
        summarizer.gh_pr_catalog = fake_catalog  # type: ignore[assignment]
        try:
            self.run_prs("--if-stale")
        finally:
            summarizer.gh_pr_catalog = original  # type: ignore[assignment]
        self.assertEqual(calls, [("acme/demo", 300)])
        self.assertEqual(self.read_graph()["pullRequests"][0]["state"], "MERGED")

    def test_pr_refresh_keeps_linked_prs_outside_the_limit(self) -> None:
        payload = self.read_graph()
        payload["prUpdatedAt"] = "2020-01-01T00:00:00+00:00"
        payload["pullRequests"] = [
            {"number": 500, "title": "old but merged", "state": "MERGED", "url": ""},
            {"number": 646, "title": "ship it", "state": "OPEN", "url": ""},
        ]
        payload["sessions"] = [{"session": self.session_id, "pullRequests": [500, 646]}]
        self.write_graph(payload)
        original = summarizer.gh_pr_catalog
        # A capped `gh pr list` no longer returns the older PR 500.
        summarizer.gh_pr_catalog = lambda *_args, **_kwargs: [  # type: ignore[assignment]
            {"number": 646, "title": "ship it", "state": "MERGED", "url": ""}
        ]
        try:
            self.run_prs("--if-stale")
        finally:
            summarizer.gh_pr_catalog = original  # type: ignore[assignment]
        catalog = {pr["number"]: pr for pr in self.read_graph()["pullRequests"]}
        self.assertEqual(set(catalog), {500, 646}, "a linked PR must not disappear from the catalog")
        self.assertEqual(catalog[500]["state"], "MERGED", "keep the last known state, not UNKNOWN")
        self.assertEqual(catalog[500]["title"], "old but merged")
        self.assertEqual(catalog[646]["state"], "MERGED")

    def test_pr_refresh_write_keeps_sessions_added_meanwhile(self) -> None:
        payload = self.read_graph()
        payload["pullRequests"] = [{"number": 646, "title": "ship it", "state": "OPEN", "url": ""}]
        payload["sessions"] = [{"session": "session-old", "title": "old"}]
        self.write_graph(payload)
        stale_text, stale = summarizer.graph_json(self.graph)

        # A summary run lands between the refresh's read and its write.
        fresh = dict(payload)
        fresh["sessions"] = [{"session": "session-old", "title": "old"}, {"session": "session-new", "title": "new"}]
        fresh["updatedAt"] = summarizer.now_iso()
        self.write_graph(fresh)

        stale["pullRequests"] = [{"number": 646, "title": "ship it", "state": "MERGED", "url": ""}]
        stale["prUpdatedAt"] = summarizer.now_iso()
        summarizer.write_graph_file(
            self.graph, stale_text, stale, owner="prs", pr_updated=True
        )

        written = self.read_graph()
        self.assertEqual([entry["session"] for entry in written["sessions"]], ["session-old", "session-new"])
        self.assertEqual(written["pullRequests"][0]["state"], "MERGED")

    def test_summary_write_keeps_a_newer_pr_catalog(self) -> None:
        payload = self.read_graph()
        payload["pullRequests"] = [{"number": 646, "title": "ship it", "state": "OPEN", "url": ""}]
        payload["prUpdatedAt"] = "2020-01-01T00:00:00+00:00"
        self.write_graph(payload)
        stale_text, stale = summarizer.graph_json(self.graph)

        # The detached refresh lands while the summary is still calling the model.
        refreshed = dict(payload)
        refreshed["pullRequests"] = [{"number": 646, "title": "ship it", "state": "MERGED", "url": ""}]
        refreshed["prUpdatedAt"] = summarizer.now_iso()
        self.write_graph(refreshed)

        stale["sessions"] = [{"session": self.session_id, "pullRequests": [646]}]
        summarizer.write_graph_file(self.graph, stale_text, stale)

        written = self.read_graph()
        self.assertEqual(written["pullRequests"][0]["state"], "MERGED", "the summary must not restore the stale catalog")
        self.assertEqual(written["prUpdatedAt"], refreshed["prUpdatedAt"])
        self.assertEqual(written["sessions"][0]["session"], self.session_id)

    def test_failed_summary_still_schedules_pr_refresh(self) -> None:
        payload = self.read_graph()
        payload["prUpdatedAt"] = "2020-01-01T00:00:00+00:00"
        self.write_graph(payload)
        calls = []
        original_schedule = summarizer.schedule_background_pr_refresh
        summarizer.schedule_background_pr_refresh = lambda *args, **kwargs: calls.append(args)  # type: ignore[assignment]
        self.addCleanup(setattr, summarizer, "schedule_background_pr_refresh", original_schedule)

        def reject(*_args: object, **_kwargs: object) -> str:
            raise RuntimeError("HTTP 500: model unavailable")

        summarizer.call_llm = reject  # type: ignore[assignment]
        original_argv = sys.argv
        sys.argv = [
            "summarize_sessions",
            "--project", str(self.project),
            "--graph", str(self.graph),
            "--dsh-home", str(self.home),
            "--mode", "sessions",
            "--write",
            "--quiet",
        ]
        try:
            with self.assertRaises(SystemExit):
                summarizer.main()
        finally:
            sys.argv = original_argv
        self.assertEqual(len(calls), 1, "a failed summary must still start the PR refresh")

    def test_single_turn_summary_refreshes_after_the_turn_ends(self) -> None:
        # The session's only turn is still running when the user promotes it.
        self.open_turn = True
        self.write_session()
        self.run_main()
        first = self.read_graph()["sessions"][0]
        self.assertTrue(first["summarizedTurnOpen"])
        self.assertEqual(first["summarizedTurnSeq"], 4)
        self.assertEqual(len(self.prompts), 1)

        # The turn finishes: the turn seq stays 4, only the open flag changes.
        self.open_turn = False
        self.write_session()
        self.run_main()
        second = self.read_graph()["sessions"][0]
        self.assertFalse(second["summarizedTurnOpen"])
        self.assertEqual(len(self.prompts), 2)
        self.assertEqual(second["summarizedTurnSeq"], 4)

        # Once finished, the entry is fresh and the next run is a no-op.
        self.run_main()
        self.assertEqual(len(self.prompts), 2)


if __name__ == "__main__":
    unittest.main()
