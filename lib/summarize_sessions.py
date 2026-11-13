#!/usr/bin/env python3
"""Summarize DSH sessions into a project's DSH_SESSION_GRAPH.md.

The graph has three layers:

- project taxonomy: a handful of long-running dimensions, each with reusable tags;
- project pull requests: the PR catalog, refreshed from GitHub in the background;
- per-session entries: title, summary, dimension tags, related PRs and dependsOn.

Dry-run by default: reads local data, prints the prompts, and makes no API calls
or file writes. Pass --write to call the model and update the graph file.

Summary generation owns every card field, including PR association. There is no
separate PR-linking pass: PR numbers are extracted from the evidence bundle that
feeds the same summary call. The input is bounded and is never the whole session:

- user messages verbatim (kept as long as the token budget allows);
- the per-turn model summaries already stored in the projcache turnOutline;
- the last one or two full assistant outputs;
- PR evidence grepped out of the event log (PR URLs, `PR #123`, PR head branches)
  reduced to short snippets.

The assembled prompt is held under MAX_SUMMARY_TOKENS (20k); fixed instructions
and taxonomy are counted before the variable sections are packed.

Summaries are incremental. An entry stores the last summarized content seq, the
last summarized turn seq, whether that turn was still running, and the summary
schema version (`summarizedSeq` / `summarizedTurnSeq` / `summarizedTurnOpen` /
`summarizedVersion`). A changed session is re-summarized from the previous
summary plus only the newer turns. Pass --force to redo an up-to-date session
from a full rebuild.

GitHub is a background concern: summarization never calls `gh`. The catalog is
refreshed by `--mode prs` (also used by `/summarize-prs`), by a detached refresh
spawned after a summary run, and by the Host's 90-second background timer; the
latter two pass `--if-stale` so `prUpdatedAt` throttles repeated `gh` calls.

Archived sessions are frozen: they are skipped by default (even with --all and
even when the graph file already lists them). Pass --include-archived to
summarize them anyway.

The model route follows DSH's own default (deepseek-account / deepseek-flash on
the Anthropic Messages API). Like DSH, it first uses the signed-in account token
(`.credentials.yaml` record `deepseek-account-platform/default`, sent as
`x-dsh-auth-token`) and falls back to `$DEEPSEEK_API_KEY` (`x-api-key`). Point it
at a proxy with --base-url/--model/--api-key-env or the DSH_SUMMARY_BASE_URL /
DSH_SUMMARY_MODEL / DSH_SUMMARY_API_KEY_ENV environment variables; --auth picks
one credential explicitly. An authentication failure is reported (non-zero exit)
instead of silently writing no entries.

A summary taken while the session's turn is still running is provisional: the
entry records `summarizedTurnOpen`, and the next run re-summarizes it once the
turn has ended. That matters most for a session with only one turn, whose turn
seq never changes again.
"""

from __future__ import annotations

import argparse
import atexit
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

# Same precedence DSH uses: $DSH_HOME, then ~/.dsh.
DEFAULT_HOME = Path("~/.dsh").expanduser()
# Match DSH's own default route (agent-default-model: deepseek-official /
# deepseek-flash). Both endpoints speak Anthropic Messages, so a proxy route only
# needs --base-url/--model/--api-key-env overrides.
DEFAULT_BASE_URL = "https://api.deepseek.com/anthropic"
DEFAULT_MODEL = "deepseek-flash"
DEFAULT_API_KEY_ENV = "DEEPSEEK_API_KEY"
# DSH stores its signed-in account token under this credentials record; the
# `/anthropic` endpoint accepts it through the same header DSH uses.
ACCOUNT_CREDENTIAL = "deepseek-account-platform/default"
ACCOUNT_TOKEN_HEADER = "x-dsh-auth-token"
USAGE = {"calls": 0, "input": 0, "output": 0, "auth_failed": False}
DIMENSION_LIMIT = 10
TAG_LIMIT = 12

# Bump when the summary prompt/entry contract changes: entries written by an
# older summarizer are rebuilt from the full session once. Version 3 adds
# `summarizedTurnOpen`, so a provisional mid-turn summary is refreshed after the
# turn ends (single-turn sessions otherwise never change their turn seq).
SUMMARY_VERSION = 3
MAX_SUMMARY_TOKENS = 20_000
PR_EVIDENCE_LIMIT = 12
RECENT_OUTPUT_CHARS = 2_000
USER_MESSAGE_CHARS = 8_000
PR_BACKGROUND_REFRESH_SECONDS = 60
PROGRESS_FILENAME = ".dsh-session-graph.progress.json"
CONTENT_EVENT_TYPES = {"user/message", "assistant/message", "turn/end"}
AUTH_ERROR_RE = re.compile(r"\bHTTP (?:401|403)\b|authentication", re.IGNORECASE)
PR_URL_RE = re.compile(r"https?://github\.com/([\w.-]+/[\w.-]+)/pull/(\d+)", re.IGNORECASE)
PR_WORD_RE = re.compile(r"(?i)\b(?:PR|pull\s*request)\b[^\n#]{0,30}#?(\d{2,5})\b")


def is_auth_error(error: object) -> bool:
    """True when the model route rejected the credential rather than the request."""
    return bool(AUTH_ERROR_RE.search(str(error)))


def read_events(log_path: Path) -> list[dict]:
    try:
        raw = subprocess.run(
            ["zstd", "-dc", str(log_path)],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    except FileNotFoundError:
        print(
            "zstd is not installed; summarizing from turnOutline only (no PR evidence)",
            file=sys.stderr,
        )
        return []
    except subprocess.CalledProcessError as exc:
        print(f"skip {log_path}: {exc.stderr.strip()}", file=sys.stderr)
        return []
    events = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def _join_blocks(blocks: object) -> str:
    if not isinstance(blocks, list):
        return ""
    return "\n".join(
        str(block.get("text") or "")
        for block in blocks
        if isinstance(block, dict) and block.get("type") == "text"
    ).strip()


def event_text(event: dict) -> str:
    """Return the human-visible text of one event (no reasoning blocks)."""
    kind = event.get("type")
    data = event.get("data") or {}
    if not isinstance(data, dict):
        return ""
    if kind == "user/message":
        return _join_blocks(data.get("content"))
    if kind == "assistant/message":
        message = data.get("message") or {}
        return _join_blocks(message.get("content") if isinstance(message, dict) else None)
    if kind == "tool/result":
        message = data.get("message") or {}
        return _join_blocks(message.get("content") if isinstance(message, dict) else None)
    if kind == "command/done":
        return str(data.get("text") or "").strip()
    return ""


def event_kind(event: dict) -> str:
    kind = str(event.get("type") or "")
    if kind == "assistant/message":
        return "assistant"
    if kind == "user/message":
        data = event.get("data")
        source = data.get("source") if isinstance(data, dict) else None
        if not isinstance(source, dict):
            source = {}
        return "user" if source.get("kind") == "user" else "other"
    if kind == "tool/result":
        return "tool"
    return "other"


def human_messages(events: list[dict], limit: int) -> list[str]:
    messages: list[str] = []
    for event in events:
        if event_kind(event) != "user":
            continue
        text = event_text(event)
        if text:
            messages.append(text[:2000])
    return messages[-limit:]


def content_seq_of(events: list[dict], fallback: int = 0) -> int:
    """Highest seq of an event that changes what a summary should say."""
    seqs = [
        int(event.get("seq") or 0)
        for event in events
        if event.get("type") in CONTENT_EVENT_TYPES
    ]
    return max(seqs, default=fallback)


def find_log(home: Path, session_id: str) -> Path | None:
    root = home / "sessions"
    if not root.exists():
        return None
    matches = list(root.glob(f"*/{session_id}/session.v4.jsonl.zstd"))
    return matches[0] if matches else None


def load_workspace(home: Path) -> tuple[dict, set[str]]:
    path = home / "storages" / "workspace.json"
    doc = json.loads(path.read_text())
    return doc["tables"]["workspaces"], set(doc.get("global", {}).get("archivedSessionIds", []))


def load_sessions(home: Path) -> dict[str, dict]:
    cache = home / "storages" / "session_projcache" / "sessions"
    sessions = {}
    for path in cache.glob("*.json"):
        try:
            record = json.loads(path.read_text())["record"]
        except (OSError, KeyError, TypeError, json.JSONDecodeError):
            continue
        rows = record.get("rows") or {}
        identity = record.get("identity") or {}
        sid = path.stem
        cwd = (rows.get("workingDirectory") or {}).get("val") or identity.get("cwd") or ""
        title = (rows.get("title") or {}).get("val") or ""
        first = (((rows.get("titleInput") or {}).get("val") or {}).get("first") or {}).get("text", "")
        outline = (rows.get("turnOutline") or {}).get("val") or {}
        # Every row carries the event seq it was last written at. Command and
        # summary-title events bump every row, so the row seq is not a stable
        # content marker; it is kept for diagnostics only.
        seq = max(
            (
                row.get("seq") or 0
                for name, row in rows.items()
                if isinstance(row, dict) and name != "title"
            ),
            default=0,
        )
        turns = outline.get("turns") or []
        # The last turn seq is the freshness bookmark: it only moves when the
        # user starts a new turn, not when the summarizer writes a title back.
        turn_seq = max(
            (
                int(turn.get("seq") or 0)
                for turn in turns
                if isinstance(turn, dict)
            ),
            default=0,
        )
        # `turnSeq` is the turn *start* and never moves when that turn finishes.
        # Track whether a turn is still running so a summary written mid-turn can
        # be refreshed once the final answer exists (the only refresh point a
        # single-turn session will ever get).
        boundary = (rows.get("turnBoundary") or {}).get("val")
        if isinstance(boundary, dict) and "openTurnStartSeq" in boundary:
            turn_open = boundary.get("openTurnStartSeq") is not None
        else:
            stats = (rows.get("sessionStats") or {}).get("val")
            turn_open = isinstance(stats, dict) and stats.get("openStep") is not None
        sessions[sid] = {
            "id": sid,
            "cwd": cwd,
            "title": title or (first.splitlines()[0][:80] if first.splitlines() else ""),
            "created": identity.get("createdAt", 0),
            "seq": int(seq),
            "turnSeq": turn_seq,
            "turnOpen": bool(turn_open),
            "turns": turns,
        }
    return sessions


def summary_is_current(entry: dict | None, session: dict, taxonomy_updated: str) -> bool:
    """True when `entry` was summarized from this exact session state and taxonomy.

    Entries from an older summary schema are always rebuilt once. For current
    entries the cheap check uses the last turn seq; a missing turn bookmark falls
    back to the content bookmark and is backfilled on the next write. A summary
    taken while the turn was still running is provisional by definition, so it is
    never considered current: the next run refreshes it from the finished turn.
    """
    if not isinstance(entry, dict):
        return False
    if str(entry.get("summary") or "").strip() == "":
        return False
    if entry.get("summarizedTaxonomy") != taxonomy_updated:
        return False
    if entry.get("summarizedVersion") != SUMMARY_VERSION:
        return False
    if entry.get("summarizedTurnOpen") is True:
        return False
    turn_seq = int(session.get("turnSeq") or 0)
    stored_turn = entry.get("summarizedTurnSeq")
    if stored_turn is not None:
        return int(stored_turn) == turn_seq
    return int(entry.get("summarizedSeq") or 0) >= turn_seq


def in_project(cwd: str, project: Path) -> bool:
    if not cwd:
        return False
    try:
        Path(cwd).resolve().relative_to(project.resolve())
        return True
    except ValueError:
        return False


def graph_json(path: Path) -> tuple[str, dict]:
    text = path.read_text() if path.exists() else ""
    match = re.search(r"```json\s*([\s\S]*?)```", text)
    if match:
        return text, json.loads(match.group(1))
    if text.strip().startswith("{"):
        return text, json.loads(text)
    return text, {"version": 3, "title": path.parent.name, "sessions": []}


def ordered_payload(payload: dict) -> dict:
    """Keep the hand-editable fields at the top and the PR catalog before sessions."""
    keys = [
        "version",
        "title",
        "repo",
        "taxonomy",
        "prUpdatedAt",
        "updatedAt",
        "pullRequests",
        "sessions",
    ]
    ordered = {key: payload[key] for key in keys if key in payload}
    for key, value in payload.items():
        if key not in ordered:
            ordered[key] = value
    return ordered


def replace_graph_json(text: str, payload: dict) -> str:
    body = json.dumps(ordered_payload(payload), ensure_ascii=False, indent=2)
    if re.search(r"```json\s*[\s\S]*?```", text):
        return re.sub(r"```json\s*[\s\S]*?```", "```json\n" + body + "\n```", text, count=1)
    return f"# 会话图\n\n```json\n{body}\n```\n"


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def detect_repo(project: Path) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", str(project), "remote", "get-url", "origin"],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    url = result.stdout.strip()
    if "github.com" not in url:
        return ""
    tail = url.split("github.com", 1)[1].lstrip(":/").removesuffix(".git").strip("/")
    parts = [part for part in tail.split("/") if part]
    return "/".join(parts[:2]) if len(parts) >= 2 else ""


def gh_pr_catalog(repo: str, limit: int = 300) -> list[dict] | None:
    """Return the catalog, or None when GitHub could not be queried."""
    if repo == "":
        return None
    fields = (
        "number,title,state,url,headRefName,author,mergedAt,updatedAt,isDraft,closedAt"
    )
    try:
        result = subprocess.run(
            [
                "gh",
                "pr",
                "list",
                "--repo",
                repo,
                "--state",
                "all",
                "--limit",
                str(limit),
                "--json",
                fields,
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=90,
        )
    except FileNotFoundError:
        print("gh is not installed; keeping the existing PR catalog", file=sys.stderr)
        return None
    except subprocess.SubprocessError as exc:
        print(f"gh pr list failed: {exc}", file=sys.stderr)
        return None
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        print(f"gh pr list returned invalid JSON: {exc}", file=sys.stderr)
        return None
    catalog = []
    for item in data:
        if not isinstance(item, dict):
            continue
        try:
            number = int(item.get("number"))
        except (TypeError, ValueError):
            continue
        author = item.get("author")
        login = author.get("login") if isinstance(author, dict) else str(author or "")
        state = "MERGED" if item.get("mergedAt") else str(item.get("state") or "").upper()
        catalog.append(
            {
                "number": number,
                "title": str(item.get("title") or ""),
                "url": str(item.get("url") or ""),
                "state": state if state else "UNKNOWN",
                "author": login,
                "headRefName": str(item.get("headRefName") or ""),
                "updatedAt": str(item.get("updatedAt") or ""),
                "isDraft": bool(item.get("isDraft")),
            }
        )
    catalog.sort(key=lambda pr: pr["number"], reverse=True)
    return catalog


def session_turns(session: dict, home: Path, limit: int) -> list[dict]:
    turns = session.get("turns") or []
    if turns:
        return turns[-limit:]
    log = find_log(home, session["id"])
    if log is None:
        return []
    messages = human_messages(read_events(log), limit)
    return [{"prompt": message, "result": ""} for message in messages]


def compact_turns(turns: list[dict], prompt_chars: int, result_chars: int) -> list[dict]:
    compact = []
    for turn in turns:
        prompt = str(turn.get("prompt") or "").strip()
        result = str(turn.get("result") or turn.get("response") or "").strip()
        if prompt == "" and result == "":
            continue
        compact.append(
            {
                "prompt": prompt[:prompt_chars],
                "result": result[:result_chars],
            }
        )
    return compact


def estimate_tokens(text: str) -> int:
    """Cheap mixed Chinese/English estimate used to enforce the input budget."""
    cjk = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
    return int(cjk + (len(text) - cjk) / 3.5 + 0.5)


def snippet_around(text: str, start: int, end: int, radius: int = 140) -> str:
    left = max(0, start - radius)
    right = min(len(text), end + radius)
    body = re.sub(r"\s+", " ", text[left:right]).strip()
    prefix = "…" if left > 0 else ""
    suffix = "…" if right < len(text) else ""
    return (prefix + body + suffix)[:320]


def grep_pr_evidence(
    events: list[dict],
    repo: str,
    catalog: list[dict],
    start_seq: int = 0,
    limit: int = PR_EVIDENCE_LIMIT,
) -> list[dict]:
    """Grep a session log for PR evidence and return compact, deduped snippets.

    This is the only PR extraction in the pipeline. It runs as part of building
    the summary input, so the summary call sees both the snippets and the
    authoritative numbers; there is no later linking pass.
    """
    catalog_numbers = {
        int(pr["number"])
        for pr in catalog
        if isinstance(pr, dict) and isinstance(pr.get("number"), int)
    }
    branches: list[tuple[str, int]] = []
    for pr in catalog:
        if not isinstance(pr, dict):
            continue
        branch = str(pr.get("headRefName") or "")
        number = pr.get("number")
        if isinstance(number, int) and len(branch) >= 8:
            branches.append((branch, number))
    branch_re = None
    branch_numbers: dict[str, int] = {}
    if branches:
        branches.sort(key=lambda item: len(item[0]), reverse=True)
        branch_re = re.compile("|".join(re.escape(branch) for branch, _ in branches))
        branch_numbers = dict(branches)
    rank = {"assistant": 3, "user": 2, "tool": 1}
    best: dict[int, dict] = {}

    def add(number: int, url: str, source: str, seq: int, snippet: str) -> None:
        if number <= 0:
            return
        item = {
            "number": number,
            "url": url,
            "source": source,
            "seq": seq,
            "snippet": snippet,
            "rank": rank.get(source, 0),
        }
        old = best.get(number)
        if old is None or item["rank"] > old["rank"] or (
            item["rank"] == old["rank"] and item["seq"] >= old["seq"]
        ):
            if old is not None and old.get("url") and url == "":
                item["url"] = old["url"]
            best[number] = item

    for event in events:
        seq = int(event.get("seq") or 0)
        if seq <= start_seq:
            continue
        source = event_kind(event)
        if source not in rank:
            continue
        text = event_text(event)
        if text == "":
            continue
        url_matches = list(PR_URL_RE.finditer(text))
        # `gh pr list` dumps hundreds of URLs into one tool result; it is a
        # catalog listing, not evidence that this session worked on those PRs.
        bulk_tool = source == "tool" and len(url_matches) > 4
        if not bulk_tool:
            for match in url_matches:
                found_repo = match.group(1)
                if repo and found_repo.lower() != repo.lower():
                    continue
                add(
                    int(match.group(2)),
                    match.group(0),
                    source,
                    seq,
                    snippet_around(text, match.start(), match.end()),
                )
            for match in PR_WORD_RE.finditer(text):
                number = int(match.group(1))
                if number in catalog_numbers:
                    add(
                        number,
                        "",
                        source,
                        seq,
                        snippet_around(text, match.start(), match.end()),
                    )
        if branch_re is not None and source in ("assistant", "user"):
            for match in branch_re.finditer(text):
                number = branch_numbers.get(match.group(0))
                if number is not None:
                    add(
                        number,
                        "",
                        source,
                        seq,
                        snippet_around(text, match.start(), match.end()),
                    )
    items = sorted(
        best.values(),
        key=lambda item: (item["rank"], item["seq"]),
        reverse=True,
    )
    return items[:limit]


def ensure_catalog_entries(
    payload: dict,
    numbers: list[int],
    repo: str,
    evidence: list[dict],
) -> None:
    """Make sure every linked PR can render, without calling GitHub."""
    catalog = payload.get("pullRequests")
    if not isinstance(catalog, list):
        catalog = []
    by_number = {
        pr.get("number"): pr for pr in catalog if isinstance(pr, dict)
    }
    urls = {
        int(item["number"]): item.get("url", "")
        for item in evidence
        if isinstance(item.get("number"), int)
    }
    for number in numbers:
        if number in by_number:
            continue
        pr = {
            "number": number,
            "title": "",
            "url": urls.get(number)
            or (f"https://github.com/{repo}/pull/{number}" if repo else ""),
            "state": "UNKNOWN",
            "author": "",
            "headRefName": "",
            "updatedAt": "",
            "isDraft": False,
        }
        catalog.append(pr)
        by_number[number] = pr
    catalog = [pr for pr in catalog if isinstance(pr, dict)]
    catalog.sort(key=lambda pr: int(pr.get("number") or 0), reverse=True)
    payload["pullRequests"] = catalog


def compact_taxonomy(taxonomy: dict | None) -> list[dict]:
    if not isinstance(taxonomy, dict):
        return []
    result = []
    for dimension in taxonomy.get("dimensions") or []:
        if not isinstance(dimension, dict):
            continue
        result.append(
            {
                "id": dimension.get("id", ""),
                "name": dimension.get("name", ""),
                "description": dimension.get("description", ""),
                "tags": [
                    {"id": tag.get("id", ""), "name": tag.get("name", "")}
                    for tag in dimension.get("tags") or []
                    if isinstance(tag, dict)
                ],
            }
        )
    return result


def taxonomy_prompt(
    project: Path,
    entries: list[dict],
    pull_requests: list[dict],
) -> str:
    payload = {
        "project": project.name,
        "sessions": entries,
        "recentPullRequests": [
            {"number": pr["number"], "title": pr.get("title", ""), "state": pr.get("state", "")}
            for pr in pull_requests[:40]
            if pr.get("title")
        ],
    }
    return (
        "You are designing a compact, reusable taxonomy for the sessions of one coding project. "
        "The taxonomy has long-running content dimensions (主线) and concrete tags inside each "
        "dimension. It must let a reader classify a session at a glance.\n\n"
        "Return only JSON of this shape:\n"
        '{"dimensions":[{"id":"kebab-case-english","name":"中文名","description":"一句话说明",'
        '"tags":[{"id":"kebab-case-english","name":"中文标签","description":"一句话说明"}]}]}\n\n'
        "Rules:\n"
        "- 4 to 6 dimensions; each dimension has 3 to 6 tags.\n"
        "- Dimensions describe durable areas of the project, not task status or session type.\n"
        "- Tags are concrete features, modules, technologies or deliverables inside a dimension.\n"
        "- A session may belong to 1-3 dimensions, so dimensions should overlap naturally.\n"
        "- Use short Chinese names (dimension <= 8 chars, tag <= 10 chars) and English ids.\n"
        "- Do not duplicate a tag across dimensions; do not invent project areas.\n"
        "- Cover the supplied sessions and use the PR titles as evidence of real work.\n"
        "- Return JSON only, no Markdown.\n\n"
        + json.dumps(payload, ensure_ascii=False)
    )


def clip_text(text: str, limit: int) -> str:
    text = str(text or "").strip()
    if limit <= 0 or len(text) <= limit:
        return text
    head = limit // 2
    tail = limit - head - 5
    return f"{text[:head].rstrip()}\n…\n{text[-tail:].lstrip()}"


def collect_summary_input(
    session: dict,
    home: Path,
    entry: dict | None,
    repo: str,
    catalog: list[dict],
    full: bool,
) -> dict:
    """Build the bounded evidence bundle for one summary call.

    `full` rebuilds from the whole session; otherwise only events newer than the
    entry's `summarizedSeq` are packed, together with the previous summary.
    """
    turns = session.get("turns") or []
    log = find_log(home, session["id"])
    events = read_events(log) if log is not None else []
    content_end = content_seq_of(events, fallback=int(session.get("turnSeq") or 0))
    begin = 0 if full else max(0, int((entry or {}).get("summarizedSeq") or 0))

    user_messages: list[dict] = []
    assistant_outputs: list[dict] = []
    for event in events:
        seq = int(event.get("seq") or 0)
        if seq <= begin:
            continue
        kind = event_kind(event)
        if kind not in ("user", "assistant"):
            continue
        text = event_text(event)
        if text == "":
            continue
        if kind == "user":
            user_messages.append({"seq": seq, "text": clip_text(text, USER_MESSAGE_CHARS)})
        else:
            assistant_outputs.append({"seq": seq, "text": text})

    turn_summaries: list[dict] = []
    for turn in turns:
        if not isinstance(turn, dict):
            continue
        seq = int(turn.get("seq") or 0)
        if seq <= begin:
            continue
        summary = str(turn.get("response") or turn.get("result") or "").strip()
        if summary == "":
            continue
        turn_summaries.append({"turn": seq, "summary": clip_text(summary, 400)})

    recent_outputs = [
        {"seq": item["seq"], "text": clip_text(item["text"], RECENT_OUTPUT_CHARS)}
        for item in assistant_outputs[-2:]
    ]
    evidence = grep_pr_evidence(events, repo, catalog, start_seq=begin)
    previous = None
    if isinstance(entry, dict) and (entry.get("summary") or entry.get("title")):
        previous = {
            "title": entry.get("title", ""),
            "summary": entry.get("summary", ""),
            "dimensions": entry.get("dimensions", {}),
            "pullRequests": entry.get("pullRequests", []),
        }
    return {
        "incremental": not full,
        "startSeq": begin,
        "contentSeq": max(content_end, begin),
        "turnSeq": int(session.get("turnSeq") or 0),
        "userMessages": user_messages,
        "turnSummaries": turn_summaries,
        "recentOutputs": recent_outputs,
        "prEvidence": evidence,
        "previousSummary": previous,
        "turnCount": len(turns),
    }


SUMMARY_RULES = (
    "Label one DSH coding session for a project map. Write the title and summary in Chinese. "
    "The title must name the concrete function or change, not a vague activity; prefer "
    "'模块/对象：动作/结果' and keep it within 30 characters. The summary explains what was "
    "delivered and its scope in at most 120 characters. Base everything on the supplied "
    "evidence; do not invent facts.\n\n"
    "When previousSummary is present this is an incremental update: keep its facts, merge only "
    "the new userMessages/turnSummaries/recentOutputs, and rewrite the summary as the current "
    "state rather than appending a changelog.\n\n"
    "PR association is part of this summary. prEvidence contains grep hits from the session "
    "log (PR URLs, `PR #123`, PR head branches); choose prs only from its numbers and return "
    "[] when it is empty. Never invent a number.\n\n"
    "Assign dimension tags from the supplied taxonomy: choose 1-3 dimensions and 1-5 tags per "
    "chosen dimension. Use only ids that appear in the taxonomy. Omit a dimension when it does "
    "not apply.\n\n"
    "Return only JSON of this shape:\n"
    '{"title":"...","summary":"...","dimensions":{"<dimension-id>":["<tag-id>"]},'
    '"prs":[123]}\n'
    "Return JSON only, no Markdown.\n\n"
)


def summary_prompt(bundle: dict, taxonomy: dict | None, catalog: list[dict]) -> str:
    by_number = {
        int(pr["number"]): pr
        for pr in catalog
        if isinstance(pr, dict) and isinstance(pr.get("number"), int)
    }
    payload = {
        "incremental": bundle["incremental"],
        "previousSummary": bundle["previousSummary"],
        "userMessages": bundle["userMessages"],
        "turnSummaries": bundle["turnSummaries"],
        "recentOutputs": bundle["recentOutputs"],
        "prEvidence": [
            {
                "number": item["number"],
                "title": by_number.get(item["number"], {}).get("title", ""),
                "state": by_number.get(item["number"], {}).get("state", "UNKNOWN"),
                "url": item.get("url", ""),
                "source": item.get("source", ""),
                "snippet": item.get("snippet", ""),
            }
            for item in bundle["prEvidence"]
        ],
        "taxonomy": compact_taxonomy(taxonomy),
    }
    return SUMMARY_RULES + json.dumps(payload, ensure_ascii=False)


def shrink_summary_input(bundle: dict) -> bool:
    """Drop the least useful section until the caller's token budget fits."""
    for key in ("turnSummaries", "recentOutputs", "userMessages"):
        items = bundle.get(key) or []
        if len(items) > 1:
            items.pop(0)
            return True
    evidence = bundle.get("prEvidence") or []
    if len(evidence) > 1:
        evidence.pop()
        return True
    for key, field in (
        ("turnSummaries", "summary"),
        ("recentOutputs", "text"),
        ("userMessages", "text"),
        ("prEvidence", "snippet"),
    ):
        items = bundle.get(key) or []
        if not items:
            continue
        value = str(items[0].get(field) or "")
        if len(value) > 240:
            items[0][field] = value[: max(240, len(value) // 2)]
            return True
    return False


def pack_summary_input(
    bundle: dict,
    taxonomy: dict | None,
    catalog: list[dict],
) -> tuple[str, int]:
    prompt = summary_prompt(bundle, taxonomy, catalog)
    tokens = estimate_tokens(prompt)
    while tokens > MAX_SUMMARY_TOKENS and shrink_summary_input(bundle):
        prompt = summary_prompt(bundle, taxonomy, catalog)
        tokens = estimate_tokens(prompt)
    return prompt, tokens


def relation_prompt(entries: list[dict]) -> str:
    return (
        "You are given DSH sessions for one project. Infer only direct prerequisite relationships. "
        'Return only JSON of the form {"edges":[{"from":"session-id","to":"session-id",'
        '"reason":"..."}]}. Use only the supplied session ids; no self edges; no cycles; if '
        "unsure return an empty edges array.\n\n"
        + json.dumps(entries, ensure_ascii=False)
    )


def parse_json_object(text: str) -> dict | None:
    if not text:
        return None
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    candidates = [fenced.group(1)] if fenced else []
    candidates.append(text.strip())
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end > start:
        candidates.append(text[start : end + 1])
    for payload in candidates:
        for attempt in (payload, re.sub(r",\s*([}\]])", r"\1", payload)):
            try:
                data = json.loads(attempt)
            except json.JSONDecodeError:
                continue
            if isinstance(data, list):
                return {"dimensions": data}
            if isinstance(data, dict):
                return data
    return None


def slug(value: str, fallback: str) -> str:
    result = re.sub(r"[^a-z0-9]+", "-", str(value).lower()).strip("-")
    return result or fallback


def normalize_taxonomy(data: object) -> dict:
    if not isinstance(data, dict):
        raise TypeError("taxonomy is not a JSON object")
    if isinstance(data.get("taxonomy"), dict):
        data = data["taxonomy"]
    elif isinstance(data.get("taxonomy"), list):
        data = {"dimensions": data["taxonomy"]}
    raw_dimensions = data.get("dimensions")
    if not isinstance(raw_dimensions, list):
        raise TypeError("taxonomy.dimensions is not an array")
    dimensions = []
    seen_dimensions: set[str] = set()
    for dimension_index, raw in enumerate(raw_dimensions):
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or "").strip()
        raw_id = str(raw.get("id") or "").strip()
        if name == "" and raw_id == "":
            continue
        dimension_id = slug(raw_id or name, f"dim-{dimension_index + 1}")
        while dimension_id in seen_dimensions:
            dimension_id = f"{dimension_id}-{dimension_index + 1}"
        seen_dimensions.add(dimension_id)

        tags = []
        seen_tags: set[str] = set()
        for tag_index, raw_tag in enumerate(raw.get("tags") or []):
            if isinstance(raw_tag, str):
                tag_name = raw_tag.strip()
                tag_id_raw = ""
                tag_description = ""
            elif isinstance(raw_tag, dict):
                tag_name = str(raw_tag.get("name") or "").strip()
                tag_id_raw = str(raw_tag.get("id") or "").strip()
                tag_description = str(raw_tag.get("description") or "").strip()
            else:
                continue
            if tag_name == "" and tag_id_raw == "":
                continue
            tag_id = slug(tag_id_raw or tag_name, f"tag-{tag_index + 1}")
            while tag_id in seen_tags:
                tag_id = f"{tag_id}-{tag_index + 1}"
            seen_tags.add(tag_id)
            tags.append(
                {
                    "id": tag_id,
                    "name": tag_name or tag_id,
                    "description": tag_description,
                }
            )
        if tags == []:
            continue
        dimensions.append(
            {
                "id": dimension_id,
                "name": name or dimension_id,
                "description": str(raw.get("description") or "").strip(),
                "tags": tags[:TAG_LIMIT],
            }
        )
    if dimensions == []:
        raise ValueError("taxonomy has no usable dimensions")
    return {"dimensions": dimensions[:DIMENSION_LIMIT]}


def normalize_session_dimensions(raw: object, taxonomy: dict | None) -> dict[str, list[str]]:
    if not isinstance(taxonomy, dict):
        return {}
    dimensions = []
    for dimension in taxonomy.get("dimensions") or []:
        if isinstance(dimension, dict):
            dimensions.append(dimension)
    by_id = {dimension["id"]: dimension for dimension in dimensions}
    by_name = {dimension["name"]: dimension for dimension in dimensions}
    tag_maps = {
        dimension["id"]: {
            **{tag["id"]: tag["id"] for tag in dimension.get("tags") or []},
            **{tag["name"]: tag["id"] for tag in dimension.get("tags") or []},
        }
        for dimension in dimensions
    }
    global_tags: dict[str, str] = {}
    for dimension in dimensions:
        for tag in dimension.get("tags") or []:
            global_tags[tag["id"]] = dimension["id"]
            global_tags.setdefault(tag["name"], dimension["id"])

    result: dict[str, list[str]] = {}

    def add(dimension_id: str, tag_key: str) -> None:
        tag_id = tag_maps.get(dimension_id, {}).get(tag_key, "")
        if tag_id == "":
            return
        bucket = result.setdefault(dimension_id, [])
        if tag_id not in bucket:
            bucket.append(tag_id)

    def resolve_dimension(key: str) -> dict | None:
        return by_id.get(key) or by_name.get(key)

    if isinstance(raw, dict):
        for key, value in raw.items():
            dimension = resolve_dimension(str(key))
            if dimension is None:
                continue
            values = value if isinstance(value, list) else [value]
            for item in values:
                if isinstance(item, str):
                    add(dimension["id"], item.strip())
    elif isinstance(raw, list):
        for item in raw:
            if not isinstance(item, str):
                continue
            text = item.strip()
            if text == "":
                continue
            if ":" in text or "/" in text:
                separator = ":" if ":" in text else "/"
                key, tag_key = text.split(separator, 1)
                dimension = resolve_dimension(key.strip())
                if dimension is not None:
                    add(dimension["id"], tag_key.strip())
                continue
            dimension_id = global_tags.get(text)
            if dimension_id is not None:
                add(dimension_id, text)
    return result


def parse_session_output(
    text: str,
    taxonomy: dict | None,
    allowed_prs: list[int],
) -> dict | None:
    data = parse_json_object(text)
    if data is None:
        return None
    if isinstance(data.get("session"), dict):
        data = data["session"]
    title = str(data.get("title") or "").strip()[:80]
    summary = str(data.get("summary") or "").strip()[:240]
    dimensions = normalize_session_dimensions(data.get("dimensions"), taxonomy)
    prs_value = data.get("prs")
    pull_requests: list[int] | None = None
    if isinstance(prs_value, list):
        pull_requests = []
        for item in prs_value:
            try:
                number = int(item)
            except (TypeError, ValueError):
                continue
            if number in allowed_prs and number not in pull_requests:
                pull_requests.append(number)
    if title == "" and summary == "" and dimensions == {} and pull_requests in (None, []):
        return None
    return {
        "title": title,
        "summary": summary,
        "dimensions": dimensions,
        "pullRequests": pull_requests,
    }


def parse_edges(text: str) -> list[dict]:
    data = parse_json_object(text)
    if data is None:
        return []
    edges = data.get("edges") if isinstance(data, dict) else None
    return [edge for edge in edges or [] if isinstance(edge, dict)]


def apply_edges(entries: list[dict], edges: list[dict]) -> None:
    ids = {entry["session"] for entry in entries}
    generated = {entry["session"]: list(entry.get("dependsOn", [])) for entry in entries}
    for edge in edges:
        source = edge.get("from")
        target = edge.get("to")
        if source not in ids or target not in ids or source == target:
            continue
        # `generated` maps a session to its prerequisites. Adding source -> target
        # (target depends on source) is a cycle when source already depends on target.
        if not reaches(generated, source, target):
            generated[target].append(source)
    for entry in entries:
        entry["dependsOn"] = sorted(set(generated.get(entry["session"], [])))


def reaches(
    graph: dict[str, list[str]],
    start: str,
    goal: str,
    seen: set[str] | None = None,
) -> bool:
    if start == goal:
        return True
    visited = seen if seen is not None else set()
    if start in visited:
        return False
    visited.add(start)
    return any(reaches(graph, nxt, goal, visited) for nxt in graph.get(start, []))


def credential_from_file(home: Path, name: str) -> str:
    """Read one ref from the same .credentials.yaml the Host uses."""
    path = home / ".credentials.yaml"
    if not path.exists():
        return ""
    text = path.read_text()
    match = re.search(rf"^\s*{re.escape(name)}\s*:\s*(.+?)\s*$", text, re.MULTILINE)
    if match is None:
        return ""
    return _unquote(match.group(1))


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    return value


def account_token_from_file(home: Path) -> str:
    """Read DSH's signed-in account token (`deepseek-account-platform/default`).

    DSH sends this token as `x-dsh-auth-token`; reusing it keeps the summarizer on
    the same route as the running Harness (the default `deepseek-account`
    provider) instead of depending on a separately minted platform API key.
    """
    path = home / ".credentials.yaml"
    if not path.exists():
        return ""
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return ""
    in_record = False
    for line in lines:
        stripped = line.strip()
        if stripped == "" or stripped.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        if indent <= 2:
            # Record keys sit at two spaces under `records:`.
            key = stripped.split(":", 1)[0].strip()
            in_record = indent == 2 and key == ACCOUNT_CREDENTIAL
            continue
        if in_record and stripped.startswith("token:"):
            return _unquote(stripped.split(":", 1)[1])
    return ""


def resolve_credentials(
    auth: str,
    *,
    base_url: str,
    account_token: str,
    api_key: str,
    api_key_source: str,
) -> list[tuple[str, str, str]]:
    """Ordered credential candidates as `(auth mode, secret, human-readable source)`."""
    account = [("account", account_token, "DSH account token")] if account_token else []
    api = [("api-key", api_key, api_key_source)] if api_key else []
    if auth == "account":
        return account
    if auth == "api-key":
        return api
    # The public endpoint speaks both schemes, so prefer the route DSH itself
    # uses. A custom proxy is more likely to have been set up for x-api-key.
    if base_url.rstrip("/") == DEFAULT_BASE_URL.rstrip("/"):
        return account + api
    return api + account


def call_llm(
    base: str,
    model: str,
    credential: str,
    prompt: str,
    timeout: int,
    *,
    max_tokens: int = 1200,
    system: str = "You write short, factual session summaries for a task graph.",
    thinking_budget: int = 0,
    auth: str = "api-key",
) -> str:
    url = base.rstrip("/") + "/v1/messages"
    headers = {
        "content-type": "application/json",
        ACCOUNT_TOKEN_HEADER if auth == "account" else "x-api-key": credential,
        "anthropic-version": "2023-06-01",
    }

    def send(include_thinking: bool) -> dict:
        payload = {
            "model": model,
            "max_tokens": max_tokens,
            "system": system,
            "messages": [{"role": "user", "content": prompt}],
        }
        if include_thinking and thinking_budget > 0:
            payload["thinking"] = {"type": "enabled", "budget_tokens": thinking_budget}
        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode(),
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode())

    try:
        data = send(True)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        if thinking_budget <= 0 or "thinking" not in detail.lower():
            raise RuntimeError(f"HTTP {exc.code}: {detail[:300]}") from exc
        # Some Anthropic-compatible endpoints reject the thinking field; retry
        # without it instead of failing the whole run.
        data = send(False)
    usage = data.get("usage") or {}
    USAGE["calls"] += 1
    # Anthropic-compatible usage reports cached prompt tokens separately; count
    # them so the printed input total matches the real prompt size.
    USAGE["input"] += (
        int(usage.get("input_tokens") or 0)
        + int(usage.get("cache_creation_input_tokens") or 0)
        + int(usage.get("cache_read_input_tokens") or 0)
    )
    USAGE["output"] += int(usage.get("output_tokens") or 0)
    return "\n".join(
        block.get("text", "")
        for block in data.get("content") or []
        if block.get("type") == "text"
    ).strip()


def call_model(
    credentials: list[tuple[str, str, str]],
    base_url: str,
    model: str,
    prompt: str,
    timeout: int,
    *,
    max_tokens: int,
    system: str,
    thinking_budget: int = 0,
) -> str | None:
    """Call the model, falling back to the next credential on an auth rejection.

    Non-auth failures do not consume the fallback: the credential is not the
    problem. A final auth failure marks `USAGE["auth_failed"]` so the caller can
    exit non-zero instead of reporting a successful no-op.
    """
    for index, (auth, credential, source) in enumerate(credentials):
        try:
            return call_llm(
                base_url,
                model,
                credential,
                prompt,
                timeout,
                max_tokens=max_tokens,
                system=system,
                thinking_budget=thinking_budget,
                auth=auth,
            )
        except (urllib.error.URLError, TimeoutError, ValueError, RuntimeError) as exc:
            more = index + 1 < len(credentials)
            if is_auth_error(exc) and more:
                print(
                    f"  {source} was rejected; trying {credentials[index + 1][2]}",
                    file=sys.stderr,
                )
                continue
            print(f"  model call failed: {exc}", file=sys.stderr)
            if is_auth_error(exc):
                USAGE["auth_failed"] = True
                print(
                    "  hint: refresh the DSH account sign-in, or store a valid API "
                    "key in the DSH .credentials.yaml",
                    file=sys.stderr,
                )
            return None
    return None


def build_taxonomy_entries(
    candidates: list[dict],
    existing: dict[str, dict],
    home: Path,
    limit: int,
) -> list[dict]:
    entries = []
    for session in candidates:
        entry = existing.get(session["id"]) or {}
        turns = compact_turns(session_turns(session, home, limit), 500, 700)
        entries.append(
            {
                "id": session["id"],
                "title": entry.get("title") or session.get("title", ""),
                "summary": entry.get("summary", ""),
                "recentTurns": turns[-2:],
                "prs": [
                    number
                    for number in (entry.get("pullRequests") or [])
                    if isinstance(number, int)
                ][:8],
            }
        )
    return entries


def write_graph_file(graph_path: Path, text: str, payload: dict) -> None:
    """Atomic write so a background PR refresh never observes a half file."""
    graph_path.parent.mkdir(parents=True, exist_ok=True)
    body = replace_graph_json(text, payload)
    tmp = graph_path.with_name(f".{graph_path.name}.tmp")
    tmp.write_text(body)
    os.replace(tmp, graph_path)


def write_progress(path: Path, **fields: object) -> None:
    """Publish machine-readable progress for the panel's busy status line."""
    payload = {**fields, "updatedAt": now_iso()}
    try:
        tmp = path.with_name(f".{path.name}.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False))
        os.replace(tmp, path)
    except OSError:
        # Progress is best-effort; never fail a summary because the panel file
        # cannot be written (read-only project, removed directory, ...).
        pass


def pr_catalog_is_stale(payload: dict, seconds: int = PR_BACKGROUND_REFRESH_SECONDS) -> bool:
    stamp = str(payload.get("prUpdatedAt") or "")
    if stamp == "":
        return True
    try:
        updated = datetime.fromisoformat(stamp)
    except ValueError:
        return True
    if updated.tzinfo is None:
        updated = updated.replace(tzinfo=UTC)
    return (datetime.now(UTC) - updated).total_seconds() >= seconds


def schedule_background_pr_refresh(
    project: Path,
    graph_path: Path,
    home: Path,
    quiet: bool,
) -> None:
    """Fire one detached `--mode prs` run; summary commands never wait for gh."""
    if os.environ.get("DSH_SESSION_GRAPH_BACKGROUND_PR", "1") == "0":
        return
    command = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--project",
        str(project),
        "--graph",
        str(graph_path),
        "--dsh-home",
        str(home),
        "--mode",
        "prs",
        "--write",
        "--quiet",
    ]
    try:
        subprocess.Popen(
            command,
            cwd=str(project),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError as exc:
        if not quiet:
            print(f"  background PR refresh failed to start: {exc}", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, default=Path.cwd())
    parser.add_argument("--graph", type=Path, default=None)
    parser.add_argument(
        "--dsh-home",
        type=Path,
        default=Path(os.environ.get("DSH_HOME", DEFAULT_HOME)),
        help="DSH data root (default: $DSH_HOME, else ~/.dsh)",
    )
    parser.add_argument("--limit", type=int, default=8, help="last N turns (taxonomy context)")
    parser.add_argument("--max-sessions", type=int, default=20)
    parser.add_argument("--session", default=None, help="summarize only this session id")
    parser.add_argument(
        "--mode",
        choices=["all", "taxonomy", "sessions", "prs"],
        default="all",
        help="taxonomy: dimensions + tags; sessions: summaries + tags; prs: PR catalog only",
    )
    parser.add_argument("--refresh-taxonomy", action="store_true")
    parser.add_argument("--relations", action="store_true", help="ask the model for dependency edges")
    parser.add_argument("--all", action="store_true", help="include sessions not listed in the graph")
    parser.add_argument(
        "--include-archived",
        action="store_true",
        help="also summarize archived sessions (skipped by default)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="redo an up-to-date session, rebuilding it from the full session",
    )
    parser.add_argument(
        "--no-prs",
        action="store_true",
        help="do not refresh the PR catalog (foreground or background)",
    )
    parser.add_argument(
        "--if-stale",
        action="store_true",
        help="for --mode prs: skip when prUpdatedAt is newer than the refresh interval",
    )
    parser.add_argument("--write", action="store_true", help="call the model and update the graph file")
    parser.add_argument(
        "--base-url",
        default=os.environ.get("DSH_SUMMARY_BASE_URL", DEFAULT_BASE_URL),
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("DSH_SUMMARY_MODEL", DEFAULT_MODEL),
    )
    parser.add_argument(
        "--api-key-env",
        default=os.environ.get("DSH_SUMMARY_API_KEY_ENV", DEFAULT_API_KEY_ENV),
    )
    parser.add_argument(
        "--auth",
        choices=("auto", "account", "api-key"),
        default=os.environ.get("DSH_SUMMARY_AUTH", "auto"),
        help="model credential: DSH account token, API key, or try both (auto)",
    )
    parser.add_argument("--timeout", type=int, default=90)
    parser.add_argument(
        "--progress",
        type=Path,
        default=None,
        help=argparse.SUPPRESS,
    )
    parser.add_argument("--quiet", action="store_true", help="suppress progress output")
    args = parser.parse_args()
    say = (lambda *values, **kwargs: None) if args.quiet else print

    project = args.project.resolve()
    graph_path = args.graph or (project / "DSH_SESSION_GRAPH.md")
    progress_path = args.progress or (project / PROGRESS_FILENAME)
    progress_enabled = bool(
        args.write and args.mode in ("sessions", "all", "taxonomy")
    )
    if progress_enabled:
        atexit.register(lambda: progress_path.unlink(missing_ok=True))
    home = args.dsh_home.expanduser()
    if not (home / "storages" / "workspace.json").exists():
        raise SystemExit(
            f"DSH home not found at {home} (no storages/workspace.json); "
            "set DSH_HOME or pass --dsh-home"
        )
    _workspaces, archived = load_workspace(home)
    sessions = load_sessions(home)
    text, payload = graph_json(graph_path)
    existing = {
        item.get("session"): item
        for item in payload.get("sessions") or []
        if isinstance(item, dict) and item.get("session")
    }
    repo = str(payload.get("repo") or "").strip() or detect_repo(project)

    if args.mode == "prs":
        if args.if_stale and not pr_catalog_is_stale(payload):
            say("PR catalog is fresh; skipping")
            return
        if not args.write:
            say("dry-run: no GitHub call, no file writes; add --write to apply")
            return
        if args.no_prs:
            say("PR refresh disabled (--no-prs)")
            return
        catalog = payload.get("pullRequests")
        catalog = [pr for pr in catalog if isinstance(pr, dict)] if isinstance(catalog, list) else []
        fresh = gh_pr_catalog(repo) if repo else None
        refreshed = fresh is not None
        if fresh is not None:
            catalog = fresh
        elif repo and not args.quiet:
            print("PR catalog: gh unavailable; keeping existing entries", file=sys.stderr)
        payload["pullRequests"] = catalog
        referenced: list[int] = []
        for entry in payload.get("sessions") or []:
            if not isinstance(entry, dict):
                continue
            for value in entry.get("pullRequests") or []:
                try:
                    number = int(value)
                except (TypeError, ValueError):
                    continue
                if number not in referenced:
                    referenced.append(number)
        ensure_catalog_entries(payload, referenced, repo, [])
        if repo:
            payload["repo"] = repo
        payload["version"] = 3
        payload["title"] = payload.get("title") or project.name
        if refreshed:
            payload["prUpdatedAt"] = now_iso()
        write_graph_file(graph_path, text, payload)
        say(f"wrote {graph_path} ({len(payload['pullRequests'])} PRs)")
        return

    candidates = []
    for session in sessions.values():
        if not in_project(session["cwd"], project):
            continue
        if args.session is not None and session["id"] != args.session:
            continue
        if session["id"] in archived and not args.include_archived:
            if args.session is not None:
                raise SystemExit(
                    f"{session['id']} is archived; pass --include-archived to summarize it anyway"
                )
            continue
        if not session.get("turns") and not find_log(home, session["id"]):
            continue
        candidates.append(session)

    candidates.sort(key=lambda item: item.get("created") or 0, reverse=True)
    if args.session is None:
        candidates = candidates[: args.max_sessions]
    if not candidates:
        raise SystemExit(f"no sessions found for {project} (graph: {graph_path})")

    # Archived sessions are frozen for summaries, but their existing entries
    # still describe project mainlines and should inform the taxonomy.
    taxonomy_candidates = list(candidates)
    known_taxonomy_ids = {session["id"] for session in taxonomy_candidates}
    if args.session is None and args.mode in ("taxonomy", "all", "sessions"):
        for session in sessions.values():
            if session["id"] in known_taxonomy_ids or session["id"] not in archived:
                continue
            if not in_project(session["cwd"], project):
                continue
            if session["id"] not in existing and not session.get("turns"):
                continue
            taxonomy_candidates.append(session)
            known_taxonomy_ids.add(session["id"])
        taxonomy_candidates.sort(key=lambda item: item.get("created") or 0, reverse=True)
        taxonomy_candidates = taxonomy_candidates[: max(args.max_sessions, 40)]

    say(f"project: {project}")
    say(f"graph:   {graph_path}")
    say(f"sessions: {len(candidates)} (mode={args.mode}, write={args.write})")

    progress_total = len(candidates) if args.mode in ("sessions", "all") else 1
    if progress_enabled:
        write_progress(
            progress_path,
            state="running",
            phase="start",
            total=progress_total,
            completed=0,
            skipped=0,
            failed=0,
            current="",
        )

    api_key = credential_from_file(home, args.api_key_env)
    key_source = f"{home / '.credentials.yaml'} refs.{args.api_key_env}" if api_key else ""
    if not api_key:
        api_key = os.environ.get(args.api_key_env, "")
        key_source = f"environment ${args.api_key_env}" if api_key else ""
    account_token = account_token_from_file(home)
    credentials = resolve_credentials(
        args.auth,
        base_url=args.base_url,
        account_token=account_token,
        api_key=api_key,
        api_key_source=key_source,
    )
    if args.write and not credentials:
        raise SystemExit(
            f"no model credential: sign in to DSH (account token) or set {args.api_key_env} "
            f"in the environment or {home / '.credentials.yaml'} refs"
        )
    say(f"model:   {args.model} via {args.base_url}")
    if credentials:
        primary = credentials[0][2]
        if len(credentials) > 1:
            fallbacks = ", ".join(source for _, _, source in credentials[1:])
            primary += f" (fallback: {fallbacks})"
        say(f"auth:    {primary}")

    def call(
        prompt: str,
        *,
        max_tokens: int,
        system: str,
        thinking_budget: int = 0,
    ) -> str | None:
        return call_model(
            credentials,
            args.base_url,
            args.model,
            prompt,
            args.timeout,
            max_tokens=max_tokens,
            system=system,
            thinking_budget=thinking_budget,
        )

    catalog = payload.get("pullRequests") if isinstance(payload.get("pullRequests"), list) else []
    catalog = [pr for pr in catalog if isinstance(pr, dict) and pr.get("number") is not None]
    say(f"pull requests: {len(catalog)} (repo={repo or 'unknown'})")

    taxonomy: dict | None = (
        payload.get("taxonomy") if isinstance(payload.get("taxonomy"), dict) else None
    )
    refresh_taxonomy = args.session is None and (
        args.mode in ("taxonomy", "all") or (args.mode == "sessions" and args.refresh_taxonomy)
    )
    if refresh_taxonomy:
        if progress_enabled:
            write_progress(
                progress_path,
                state="running",
                phase="taxonomy",
                total=1,
                completed=0,
                skipped=0,
                failed=0,
                current="",
            )
        entries = build_taxonomy_entries(taxonomy_candidates, existing, home, args.limit)
        prompt = taxonomy_prompt(project, entries, catalog)
        print("\n--- taxonomy prompt ---")
        print(prompt[:1200].replace("\n", " ") + ("..." if len(prompt) > 1200 else ""))
        if args.write:
            raw = call(
                prompt,
                max_tokens=8000,
                system="You design compact taxonomies for coding sessions. Return JSON only.",
                thinking_budget=2048,
            )
            if raw is None:
                print("  taxonomy unchanged", file=sys.stderr)
                if USAGE["auth_failed"]:
                    raise SystemExit(1)
            else:
                try:
                    taxonomy = normalize_taxonomy(parse_json_object(raw))
                except (TypeError, ValueError) as exc:
                    print(f"  taxonomy parse failed: {exc}", file=sys.stderr)
                    print(f"  raw: {raw[:800]}", file=sys.stderr)
                else:
                    payload["taxonomy"] = {**taxonomy, "updatedAt": now_iso()}
                    print(f"  dimensions: {len(taxonomy['dimensions'])}")
                    for dimension in taxonomy["dimensions"]:
                        names = ", ".join(tag["name"] for tag in dimension["tags"])
                        print(f"  - {dimension['name']}: {names}")
        elif args.mode == "taxonomy":
            print("\ndry-run: no API calls, no file writes; add --write to apply")
            print(
                f"usage: calls={USAGE['calls']} input_tokens={USAGE['input']} "
                f"output_tokens={USAGE['output']} total_tokens={USAGE['input'] + USAGE['output']}"
            )
            return

    if args.mode in ("sessions", "all") and taxonomy is None and args.write:
        if progress_enabled:
            write_progress(
                progress_path,
                state="running",
                phase="taxonomy",
                total=1,
                completed=0,
                skipped=0,
                failed=0,
                current="",
            )
        print("\ntaxonomy is missing; generating it before session tagging", file=sys.stderr)
        entries = build_taxonomy_entries(taxonomy_candidates, existing, home, args.limit)
        prompt = taxonomy_prompt(project, entries, catalog)
        raw = call(
            prompt,
            max_tokens=8000,
            system="You design compact taxonomies for coding sessions. Return JSON only.",
            thinking_budget=2048,
        )
        if raw is None and USAGE["auth_failed"]:
            raise SystemExit(1)
        if raw is not None:
            try:
                taxonomy = normalize_taxonomy(parse_json_object(raw))
            except (TypeError, ValueError) as exc:
                print(f"  taxonomy parse failed: {exc}", file=sys.stderr)
                print(f"  raw: {raw[:800]}", file=sys.stderr)
            else:
                payload["taxonomy"] = {**taxonomy, "updatedAt": now_iso()}
                print(f"  dimensions: {len(taxonomy['dimensions'])}")

    touched: list[str] = []
    skipped: list[str] = []
    failed: list[str] = []
    tag_sessions = args.mode in ("sessions", "all")
    taxonomy_updated = str((payload.get("taxonomy") or {}).get("updatedAt") or "")
    if progress_enabled and tag_sessions:
        write_progress(
            progress_path,
            state="running",
            phase="sessions",
            total=progress_total,
            completed=0,
            skipped=0,
            failed=0,
            current="",
        )
    for position, session in enumerate(candidates if tag_sessions else [], start=1):
        if USAGE["auth_failed"]:
            break
        if progress_enabled:
            write_progress(
                progress_path,
                state="running",
                phase="sessions",
                total=progress_total,
                completed=position - 1,
                skipped=len(skipped),
                failed=len(failed),
                current=str(session.get("title") or session["id"]),
            )
        entry = existing.get(session["id"])
        if not args.force and summary_is_current(entry, session, taxonomy_updated):
            skipped.append(session["id"])
            if args.write and isinstance(entry, dict) and "summarizedTurnSeq" not in entry:
                entry["summarizedTurnSeq"] = int(session.get("turnSeq") or 0)
            say(f"\n--- {session['id']}  unchanged; keep existing summary (--force to redo)")
            if progress_enabled:
                write_progress(
                    progress_path,
                    state="running",
                    phase="sessions",
                    total=progress_total,
                    completed=position,
                    skipped=len(skipped),
                    failed=len(failed),
                    current="",
                )
            continue
        rebuild = (
            args.force
            or not isinstance(entry, dict)
            or entry.get("summarizedVersion") != SUMMARY_VERSION
        )
        bundle = collect_summary_input(session, home, entry, repo, catalog, full=rebuild)
        # Keep the full evidence set before budget packing: snippets may be
        # dropped to fit the prompt, but the PR numbers they prove are still
        # authoritative for this summary.
        evidence = list(bundle["prEvidence"])
        evidence_numbers = [int(item["number"]) for item in evidence]
        prompt, tokens = pack_summary_input(bundle, taxonomy, catalog)
        mode_label = "full" if rebuild else "incremental"
        say(
            f"\n--- {session['id']}  {session.get('title', '')}  "
            f"({bundle['turnCount']} turns, {len(bundle['userMessages'])} user msgs, "
            f"{len(bundle['turnSummaries'])} turn summaries, "
            f"{len(evidence_numbers)} PR evidence, ~{tokens} tokens, {mode_label})"
        )
        if not args.write:
            say(prompt[:900].replace("\n", " ") + ("..." if len(prompt) > 900 else ""))
            continue
        raw = call(
            prompt,
            max_tokens=2000,
            system="You label coding sessions against a fixed taxonomy. Return JSON only.",
            thinking_budget=1024,
        )
        if raw is None:
            failed.append(session["id"])
            if progress_enabled:
                write_progress(
                    progress_path,
                    state="running",
                    phase="sessions",
                    total=progress_total,
                    completed=position,
                    skipped=len(skipped),
                    failed=len(failed),
                    current="",
                )
            continue
        parsed = parse_session_output(raw, taxonomy, evidence_numbers)
        if parsed is None:
            print("  model returned no usable labels; keep existing values", file=sys.stderr)
            failed.append(session["id"])
            if progress_enabled:
                write_progress(
                    progress_path,
                    state="running",
                    phase="sessions",
                    total=progress_total,
                    completed=position,
                    skipped=len(skipped),
                    failed=len(failed),
                    current="",
                )
            continue
        if entry is None:
            entry = {
                "session": session["id"],
                "title": session.get("title", ""),
                "summary": "",
                "dimensions": {},
                "pullRequests": [],
                "dependsOn": [],
            }
            payload.setdefault("sessions", []).append(entry)
            existing[session["id"]] = entry
        if parsed["title"] != "":
            entry["title"] = parsed["title"]
        if parsed["summary"] != "":
            entry["summary"] = parsed["summary"]
        if taxonomy is not None:
            entry["dimensions"] = parsed["dimensions"]
        chosen = [
            number
            for number in (parsed["pullRequests"] or [])
            if number in evidence_numbers
        ]
        if not chosen:
            chosen = evidence_numbers[:4]
        if bundle["incremental"]:
            previous_numbers: list[int] = []
            for value in entry.get("pullRequests") or []:
                try:
                    number = int(value)
                except (TypeError, ValueError):
                    continue
                if number not in previous_numbers:
                    previous_numbers.append(number)
            chosen = list(dict.fromkeys([*previous_numbers, *chosen]))
        chosen = chosen[:4]
        entry["pullRequests"] = chosen
        entry["summarizedSeq"] = int(bundle["contentSeq"])
        entry["summarizedTurnSeq"] = int(bundle["turnSeq"])
        # A summary taken while the turn is still running is provisional: the
        # next run refreshes it from the finished turn (see summary_is_current).
        entry["summarizedTurnOpen"] = bool(session.get("turnOpen"))
        entry["summarizedVersion"] = SUMMARY_VERSION
        entry["summarizedTaxonomy"] = taxonomy_updated
        ensure_catalog_entries(payload, chosen, repo, evidence)
        catalog = payload.get("pullRequests") or []
        touched.append(session["id"])
        say(f"  title: {entry.get('title', '')}")
        say(f"  summary: {entry.get('summary', '')[:160]}")
        say(f"  dimensions: {json.dumps(entry.get('dimensions', {}), ensure_ascii=False)}")
        say(f"  prs: {entry.get('pullRequests', [])}")
        if progress_enabled:
            write_progress(
                progress_path,
                state="running",
                phase="sessions",
                total=progress_total,
                completed=position,
                skipped=len(skipped),
                failed=len(failed),
                current="",
            )

    # Edges are inferred from titles/summaries, so an up-to-date project needs no
    # relation call; retry only when some entry has no dependsOn yet.
    needs_relations = bool(touched) or any(
        "dependsOn" not in existing[session["id"]]
        for session in candidates
        if session["id"] in existing
    )
    if args.write and args.relations and not USAGE["auth_failed"] and args.session is None and tag_sessions and needs_relations:
        relation_entries = []
        for session in candidates:
            entry = existing.get(session["id"])
            if entry is None:
                continue
            relation_entries.append(
                {
                    "id": session["id"],
                    "title": entry.get("title") or session.get("title", ""),
                    "summary": entry.get("summary", ""),
                    "dimensions": entry.get("dimensions", {}),
                }
            )
        if relation_entries:
            if progress_enabled:
                write_progress(
                    progress_path,
                    state="running",
                    phase="relations",
                    total=1,
                    completed=0,
                    skipped=len(skipped),
                    failed=len(failed),
                    current="",
                )
            prompt = relation_prompt(relation_entries)
            say("\n--- relations prompt ---")
            say(prompt[:1000] + ("..." if len(prompt) > 1000 else ""))
            raw = call(
                prompt,
                max_tokens=2000,
                system="You infer direct prerequisite edges between coding sessions. Return JSON only.",
                thinking_budget=1024,
            )
            if raw is not None:
                edges = parse_edges(raw)
                apply_edges(
                    [
                        existing[session["id"]]
                        for session in candidates
                        if session["id"] in existing
                    ],
                    edges,
                )
                say(f"relations: {len(edges)} model edges")

    say(
        f"\nusage: calls={USAGE['calls']} input_tokens={USAGE['input']} "
        f"output_tokens={USAGE['output']} total_tokens={USAGE['input'] + USAGE['output']}"
    )
    if args.write:
        if progress_enabled:
            write_progress(
                progress_path,
                state="running",
                phase="writing",
                total=progress_total,
                completed=progress_total,
                skipped=len(skipped),
                failed=len(failed),
                current="",
            )
        payload["version"] = 3
        payload["title"] = payload.get("title") or project.name
        payload["updatedAt"] = now_iso()
        if repo:
            payload["repo"] = repo
        write_graph_file(graph_path, text, payload)
        say(f"wrote {graph_path}")
        say(f"sessions updated: {len(touched)}, skipped: {len(skipped)}")
        if progress_enabled:
            write_progress(
                progress_path,
                state="failed" if failed else "done",
                phase="done",
                total=progress_total,
                completed=progress_total,
                skipped=len(skipped),
                failed=len(failed),
                current="",
            )
        if failed:
            # Keep any partial results on disk, but make the failure loud: the
            # Host turns a non-zero exit into an error result, so the panel shows
            # this instead of a silent "sessions updated: 0".
            print(
                f"\nsummary failed for {len(failed)} session(s): {', '.join(failed)}",
                file=sys.stderr,
            )
            raise SystemExit(1)
        if (
            not args.no_prs
            and repo
            and args.mode in ("sessions", "all", "taxonomy")
            and pr_catalog_is_stale(payload)
        ):
            schedule_background_pr_refresh(project, graph_path, home, args.quiet)
    else:
        say("dry-run: no API calls, no file writes; add --write to apply")


if __name__ == "__main__":
    main()
