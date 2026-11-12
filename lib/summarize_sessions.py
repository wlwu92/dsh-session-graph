#!/usr/bin/env python3
"""Summarize DSH sessions into a project's DSH_SESSION_GRAPH.md.

The graph has three layers:

- project taxonomy: a handful of long-running dimensions, each with reusable tags;
- project pull requests: fetched from GitHub with `gh`, used by the PR view;
- per-session entries: title, summary, dimension tags, related PRs and dependsOn.

Dry-run by default: reads local data, prints the prompts, and makes no API calls
or file writes. Pass --write to call the model and update the graph file.

The model input is deliberately small: the session title, a few recent
turnOutline entries (prompt + result), plus the PR numbers mentioned there. It
does not send the whole context.

Archived sessions are frozen: they are skipped by default (even with --all and
even when the graph file already lists them). Pass --include-archived to
summarize them anyway.

Summaries are incremental: an entry records the session seq and taxonomy stamp
it was written from (`summarizedSeq` / `summarizedTaxonomy`), so a session that
has not changed since its last summary costs no model call. Pass --force to
redo up-to-date sessions anyway.

The model route follows DSH's own default (deepseek-official / deepseek-flash on
the Anthropic Messages API). Point it at a proxy with --base-url/--model/
--api-key-env or the DSH_SUMMARY_BASE_URL / DSH_SUMMARY_MODEL /
DSH_SUMMARY_API_KEY_ENV environment variables.
"""

from __future__ import annotations

import argparse
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
PR_LINK = re.compile(r"https://github\.com/([\w.-]+/[\w.-]+)/pull/(\d+)")
USAGE = {"calls": 0, "input": 0, "output": 0}
DIMENSION_LIMIT = 10
TAG_LIMIT = 12


def read_events(log_path: Path) -> list[dict]:
    try:
        raw = subprocess.run(
            ["zstd", "-dc", str(log_path)],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    except FileNotFoundError:
        print("zstd is required for the log fallback (brew install zstd)", file=sys.stderr)
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


def human_messages(events: list[dict], limit: int) -> list[str]:
    messages: list[str] = []
    for event in events:
        if event.get("type") != "user/message":
            continue
        data = event.get("data") or {}
        source = data.get("source") or {}
        if source.get("kind") != "user":
            continue
        text = "\n".join(
            block.get("text", "")
            for block in data.get("content") or []
            if block.get("type") == "text"
        ).strip()
        if text:
            messages.append(text[:2000])
    return messages[-limit:]


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
        # Every row carries the event seq it was last written at; the maximum is
        # the session's persisted position and changes on any new activity.
        seq = max(
            (row.get("seq") or 0 for row in rows.values() if isinstance(row, dict)),
            default=0,
        )
        sessions[sid] = {
            "id": sid,
            "cwd": cwd,
            "title": title or (first.splitlines()[0][:80] if first.splitlines() else ""),
            "created": identity.get("createdAt", 0),
            "seq": int(seq),
            "turns": outline.get("turns") or [],
        }
    return sessions


def summary_is_current(entry: dict | None, session: dict, taxonomy_updated: str) -> bool:
    """True when `entry` was summarized from this exact session state and taxonomy."""
    if not isinstance(entry, dict):
        return False
    if str(entry.get("summary") or "").strip() == "":
        return False
    if entry.get("summarizedTaxonomy") != taxonomy_updated:
        return False
    return entry.get("summarizedSeq") == session.get("seq")


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


def gh_pr_catalog(repo: str, limit: int = 300) -> list[dict]:
    if repo == "":
        return []
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
        print("gh is not installed; PR catalog will only use links found in sessions", file=sys.stderr)
        return []
    except subprocess.SubprocessError as exc:
        print(f"gh pr list failed: {exc}", file=sys.stderr)
        return []
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        print(f"gh pr list returned invalid JSON: {exc}", file=sys.stderr)
        return []
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


def pr_refs(turns: list[dict], repo: str) -> list[dict]:
    refs: dict[int, dict] = {}
    for turn in turns:
        text = f"{turn.get('prompt', '')}\n{turn.get('result', '') or turn.get('response', '')}"
        for match in PR_LINK.finditer(text):
            found_repo = match.group(1)
            if repo and found_repo.lower() != repo.lower():
                continue
            number = int(match.group(2))
            refs.setdefault(number, {"number": number, "url": match.group(0)})
    return list(refs.values())


def merge_pr_refs(catalog: list[dict], refs: list[dict]) -> list[dict]:
    known = {pr.get("number") for pr in catalog}
    merged = list(catalog)
    for ref in refs:
        if ref["number"] in known:
            continue
        known.add(ref["number"])
        merged.append(
            {
                "number": ref["number"],
                "title": "",
                "url": ref["url"],
                "state": "UNKNOWN",
                "author": "",
                "headRefName": "",
                "updatedAt": "",
                "isDraft": False,
            }
        )
    merged.sort(key=lambda pr: pr["number"], reverse=True)
    return merged


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


def session_prompt(
    session: dict,
    entry: dict | None,
    turns: list[dict],
    pr_candidates: list[dict],
    taxonomy: dict | None,
) -> str:
    payload = {
        "title": entry.get("title") if isinstance(entry, dict) else session.get("title", ""),
        "existingSummary": entry.get("summary", "") if isinstance(entry, dict) else "",
        "recentTurns": turns,
        "pullRequestCandidates": pr_candidates,
        "taxonomy": compact_taxonomy(taxonomy),
    }
    return (
        "Label one DSH coding session for a project map. Write the title and summary in Chinese. "
        "The title must name the concrete function or change, not a vague activity; prefer "
        "'模块/对象：动作/结果' and keep it within 30 characters. The summary explains what was "
        "delivered and its scope in at most 120 characters. Base everything on the supplied turns, "
        "existing values and PR candidates; do not invent facts.\n\n"
        "Also assign dimension tags from the supplied taxonomy: choose 1-3 dimensions and 1-5 "
        "tags per chosen dimension. Use only ids that appear in the taxonomy. Omit a dimension "
        "when it does not apply. Keep only PR numbers from pullRequestCandidates.\n\n"
        "Return only JSON of this shape:\n"
        '{"title":"...","summary":"...","dimensions":{"<dimension-id>":["<tag-id>"]},'
        '"prs":[123]}\n'
        "Return JSON only, no Markdown.\n\n"
        + json.dumps(payload, ensure_ascii=False)
    )


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


def add_number(numbers: list[int], number: int) -> None:
    if number not in numbers:
        numbers.append(number)


def link_session_pull_requests(
    payload: dict,
    sessions: dict[str, dict],
    home: Path,
    limit: int,
    repo: str,
) -> None:
    """Union session PR links from turns and summaries into the graph.

    This is deterministic and free; it also backfills archived entries that are
    intentionally not re-summarized.
    """
    catalog = payload.get("pullRequests") if isinstance(payload.get("pullRequests"), list) else []
    by_number = {
        pr["number"]: pr
        for pr in catalog
        if isinstance(pr, dict) and isinstance(pr.get("number"), int)
    }
    for entry in payload.get("sessions") or []:
        if not isinstance(entry, dict):
            continue
        session_id = entry.get("session")
        if not isinstance(session_id, str) or session_id == "":
            continue
        numbers: list[int] = []
        for value in entry.get("pullRequests") or []:
            try:
                add_number(numbers, int(value))
            except (TypeError, ValueError):
                continue
        session = sessions.get(session_id)
        all_text = ""
        if session is not None:
            all_turns = session.get("turns") or session_turns(session, home, limit)
            for ref in pr_refs(all_turns, repo):
                add_number(numbers, ref["number"])
            all_text = "\n".join(
                f"{turn.get('prompt', '')}\n{turn.get('result', '') or turn.get('response', '')}"
                for turn in all_turns
            )
        # A session often mentions the branch it created; the PR catalog knows
        # the head branch, so this links PRs that never appear as a URL.
        for pr in catalog:
            if not isinstance(pr, dict):
                continue
            branch = pr.get("headRefName") or ""
            number = pr.get("number")
            if isinstance(number, int) and isinstance(branch, str) and len(branch) >= 6 and branch in all_text:
                add_number(numbers, number)
        # The model output often writes "PR 提交：**#606**" instead of a URL.
        # Accept any #number shortly after the word PR.
        for match in re.finditer(r"(?i)\bPR\b[^\n#]{0,40}#(\d+)", all_text):
            add_number(numbers, int(match.group(1)))
        # "PR 604" without a # is only accepted when 604 is a known PR.
        for match in re.finditer(r"(?i)\bPR\b[^\n#]{0,20}?(\d{2,4})\b", all_text):
            number = int(match.group(1))
            if number in by_number:
                add_number(numbers, number)
        text = f"{entry.get('title', '')}\n{entry.get('summary', '')}"
        for match in re.finditer(r"(?i)\bPR\b[^\n#]{0,40}#(\d+)", text):
            add_number(numbers, int(match.group(1)))
        for match in re.finditer(r"(?i)\bPR\b[^\n#]{0,20}?(\d{2,4})\b", text):
            number = int(match.group(1))
            if number in by_number:
                add_number(numbers, number)
        for match in re.finditer(r"github\.com/[\w.-]+/[\w.-]+/pull/(\d+)", text):
            add_number(numbers, int(match.group(1)))
        entry["pullRequests"] = numbers[:4]
        for number in numbers[:4]:
            if number in by_number:
                continue
            by_number[number] = {
                "number": number,
                "title": "",
                "url": f"https://github.com/{repo}/pull/{number}" if repo else "",
                "state": "UNKNOWN",
                "author": "",
                "headRefName": "",
                "updatedAt": "",
                "isDraft": False,
            }
            catalog.append(by_number[number])
    catalog = [pr for pr in catalog if isinstance(pr, dict)]
    catalog.sort(key=lambda pr: pr.get("number", 0), reverse=True)
    payload["pullRequests"] = catalog


def credential_from_file(home: Path, name: str) -> str:
    """Read one ref from the same .credentials.yaml the Host uses."""
    path = home / ".credentials.yaml"
    if not path.exists():
        return ""
    text = path.read_text()
    match = re.search(rf"^\s*{re.escape(name)}\s*:\s*(.+?)\s*$", text, re.MULTILINE)
    if match is None:
        return ""
    value = match.group(1).strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    return value


def call_llm(
    base: str,
    model: str,
    api_key: str,
    prompt: str,
    timeout: int,
    *,
    max_tokens: int = 1200,
    system: str = "You write short, factual session summaries for a task graph.",
    thinking_budget: int = 0,
) -> str:
    url = base.rstrip("/") + "/v1/messages"
    headers = {
        "content-type": "application/json",
        "x-api-key": api_key,
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
    USAGE["input"] += int(usage.get("input_tokens") or 0)
    USAGE["output"] += int(usage.get("output_tokens") or 0)
    return "\n".join(
        block.get("text", "")
        for block in data.get("content") or []
        if block.get("type") == "text"
    ).strip()


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
        refs = pr_refs(turns, "")
        entries.append(
            {
                "id": session["id"],
                "title": entry.get("title") or session.get("title", ""),
                "summary": entry.get("summary", ""),
                "recentTurns": turns[-2:],
                "prs": [ref["number"] for ref in refs[:8]],
            }
        )
    return entries


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
    parser.add_argument("--limit", type=int, default=8, help="last N turns per session")
    parser.add_argument("--max-sessions", type=int, default=20)
    parser.add_argument("--session", default=None, help="summarize only this session id")
    parser.add_argument(
        "--mode",
        choices=["all", "taxonomy", "sessions", "prs"],
        default="all",
        help="taxonomy: dimensions + PRs; sessions: summaries + tags; prs: PR catalog only",
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
        help="re-summarize sessions whose summary is already up to date",
    )
    parser.add_argument("--no-prs", action="store_true", help="skip the gh PR catalog")
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
    parser.add_argument("--timeout", type=int, default=90)
    args = parser.parse_args()

    project = args.project.resolve()
    graph_path = args.graph or (project / "DSH_SESSION_GRAPH.md")
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

    print(f"project: {project}")
    print(f"graph:   {graph_path}")
    print(f"sessions: {len(candidates)} (mode={args.mode}, write={args.write})")

    api_key = credential_from_file(home, args.api_key_env)
    key_source = "credentials file" if api_key else ""
    if not api_key:
        api_key = os.environ.get(args.api_key_env, "")
        key_source = "environment" if api_key else ""
    if args.write and not api_key:
        raise SystemExit(
            f"{args.api_key_env} is not configured in the environment or {home / '.credentials.yaml'}"
        )
    print(f"model:   {args.model} via {args.base_url}")
    if api_key:
        print(f"api key: {args.api_key_env} from {key_source}")

    def call(
        prompt: str,
        *,
        max_tokens: int,
        system: str,
        thinking_budget: int = 0,
    ) -> str | None:
        try:
            return call_llm(
                args.base_url,
                args.model,
                api_key,
                prompt,
                args.timeout,
                max_tokens=max_tokens,
                system=system,
                thinking_budget=thinking_budget,
            )
        except (urllib.error.URLError, TimeoutError, ValueError, RuntimeError) as exc:
            print(f"  model call failed: {exc}", file=sys.stderr)
            return None

    repo = str(payload.get("repo") or "").strip() or detect_repo(project)
    catalog = payload.get("pullRequests") if isinstance(payload.get("pullRequests"), list) else []
    catalog = [pr for pr in catalog if isinstance(pr, dict) and pr.get("number") is not None]

    refs_by_session: dict[str, list[dict]] = {}
    for session in candidates:
        refs_by_session[session["id"]] = pr_refs(session_turns(session, home, args.limit), repo)

    refresh_prs = (
        not args.no_prs
        and args.session is None
        and (args.mode in ("taxonomy", "prs", "all") or catalog == [])
    )
    if refresh_prs and repo != "":
        fresh = gh_pr_catalog(repo)
        if fresh:
            catalog = fresh
        else:
            print("PR catalog: gh returned no rows; keeping existing entries", file=sys.stderr)
    all_refs = [ref for refs in refs_by_session.values() for ref in refs]
    catalog = merge_pr_refs(catalog, all_refs)
    if args.write and repo != "":
        payload["repo"] = repo
        payload["pullRequests"] = catalog
        payload["prUpdatedAt"] = now_iso()
    print(f"pull requests: {len(catalog)} (repo={repo or 'unknown'})")

    taxonomy: dict | None = (
        payload.get("taxonomy") if isinstance(payload.get("taxonomy"), dict) else None
    )
    refresh_taxonomy = args.session is None and (
        args.mode in ("taxonomy", "all") or (args.mode == "sessions" and args.refresh_taxonomy)
    )
    if refresh_taxonomy:
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

    if args.mode == "prs":
        print(
            f"\nusage: calls={USAGE['calls']} input_tokens={USAGE['input']} "
            f"output_tokens={USAGE['output']} total_tokens={USAGE['input'] + USAGE['output']}"
        )
        if args.write:
            payload["version"] = 3
            payload["title"] = payload.get("title") or project.name
            payload["updatedAt"] = now_iso()
            graph_path.write_text(replace_graph_json(text, payload))
            print(f"wrote {graph_path}")
        else:
            print("dry-run: no API calls, no file writes; add --write to apply")
        return

    if args.mode in ("sessions", "all") and taxonomy is None and args.write:
        print("\ntaxonomy is missing; generating it before session tagging", file=sys.stderr)
        entries = build_taxonomy_entries(taxonomy_candidates, existing, home, args.limit)
        prompt = taxonomy_prompt(project, entries, catalog)
        raw = call(
            prompt,
            max_tokens=8000,
            system="You design compact taxonomies for coding sessions. Return JSON only.",
            thinking_budget=2048,
        )
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
    tag_sessions = args.mode in ("sessions", "all")
    taxonomy_updated = str((payload.get("taxonomy") or {}).get("updatedAt") or "")
    for session in (candidates if tag_sessions else []):
        entry = existing.get(session["id"])
        if not args.force and summary_is_current(entry, session, taxonomy_updated):
            skipped.append(session["id"])
            print(f"\n--- {session['id']}  unchanged; keep existing summary (--force to redo)")
            continue
        turns = compact_turns(session_turns(session, home, args.limit), 700, 1200)
        refs = refs_by_session.get(session["id"], [])
        pr_numbers = [ref["number"] for ref in refs]
        pr_candidates = []
        catalog_by_number = {
            pr["number"]: pr for pr in catalog if isinstance(pr.get("number"), int)
        }
        for number in pr_numbers[:12]:
            pr = catalog_by_number.get(number)
            pr_candidates.append(
                {
                    "number": number,
                    "title": pr.get("title", "") if pr else "",
                    "state": pr.get("state", "UNKNOWN") if pr else "UNKNOWN",
                }
            )
        prompt = session_prompt(session, entry, turns, pr_candidates, taxonomy)
        print(
            f"\n--- {session['id']}  {session.get('title', '')}  "
            f"({len(turns)} turns, {len(pr_numbers)} PR links)"
        )
        print(prompt[:700].replace("\n", " ") + ("..." if len(prompt) > 700 else ""))
        if not args.write:
            continue
        raw = call(
            prompt,
            max_tokens=2000,
            system="You label coding sessions against a fixed taxonomy. Return JSON only.",
            thinking_budget=1024,
        )
        if raw is None:
            continue
        parsed = parse_session_output(raw, taxonomy, pr_numbers)
        if parsed is None:
            print("  model returned no usable labels; keep existing values", file=sys.stderr)
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
        if parsed["pullRequests"] is not None:
            entry["pullRequests"] = parsed["pullRequests"]
        elif pr_numbers:
            entry["pullRequests"] = pr_numbers[:4]
        elif "pullRequests" not in entry:
            entry["pullRequests"] = []
        entry["summarizedSeq"] = session.get("seq")
        entry["summarizedTaxonomy"] = taxonomy_updated
        touched.append(session["id"])
        print(f"  title: {entry.get('title', '')}")
        print(f"  summary: {entry.get('summary', '')[:160]}")
        print(f"  dimensions: {json.dumps(entry.get('dimensions', {}), ensure_ascii=False)}")
        print(f"  prs: {entry.get('pullRequests', [])}")

    # Edges are inferred from titles/summaries, so an up-to-date project needs no
    # relation call; retry only when some entry has no dependsOn yet.
    needs_relations = bool(touched) or any(
        "dependsOn" not in existing[session["id"]]
        for session in candidates
        if session["id"] in existing
    )
    if args.write and args.relations and args.session is None and tag_sessions and needs_relations:
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
            prompt = relation_prompt(relation_entries)
            print("\n--- relations prompt ---")
            print(prompt[:1000] + ("..." if len(prompt) > 1000 else ""))
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
                print(f"relations: {len(edges)} model edges")

    if args.write:
        link_session_pull_requests(payload, sessions, home, args.limit, repo)

    print(
        f"\nusage: calls={USAGE['calls']} input_tokens={USAGE['input']} "
        f"output_tokens={USAGE['output']} total_tokens={USAGE['input'] + USAGE['output']}"
    )
    if args.write:
        payload["version"] = 3
        payload["title"] = payload.get("title") or project.name
        payload["updatedAt"] = now_iso()
        graph_path.write_text(replace_graph_json(text, payload))
        print(f"wrote {graph_path}")
        print(f"sessions updated: {len(touched)}, skipped: {len(skipped)}")
    else:
        print("dry-run: no API calls, no file writes; add --write to apply")


if __name__ == "__main__":
    main()
