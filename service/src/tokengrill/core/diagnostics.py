"""Diagnostics a tester can share: each step Token Grill took, with every value that could identify the user or open their accounts removed."""

import re
from datetime import UTC, datetime
from typing import Literal, TypedDict

from tokengrill.core.types import AccountApp, ProviderKind

_SHAPE_DEPTH = 3
_SHAPE_KEYS = 6
_QUERY = re.compile(r"[?#].*$", re.DOTALL)
_SCHEME = re.compile(r"^https?://")

_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_UUID = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.IGNORECASE | re.ASCII)
# Secrets mix letters and digits; field names such as cloud_session_storage_enabled do not.
_TOKEN = re.compile(r"[A-Za-z0-9_\-.]{24,}")
# Requests go only to fixed service hosts, such as codewhisperer.us-east-1.amazonaws.com.
_HOST = re.compile(r"(?:[a-z0-9-]+\.)+[a-z]{2,}")
_DIGIT = re.compile(r"[0-9]")
_LETTER = re.compile(r"[A-Za-z]")


def _token_or_text(match: re.Match[str]) -> str:
    text = match.group()
    if _DIGIT.search(text) and _LETTER.search(text) and not _HOST.fullmatch(text):
        return "<token>"
    return text


def redact(text: str, home: str) -> str:
    text = text.replace(home, "~")
    text = _EMAIL.sub("<email>", text)
    text = _UUID.sub("<id>", text)
    return _TOKEN.sub(_token_or_text, text)


class DiagnosticEntry(TypedDict):
    at: int
    account: str
    kind: ProviderKind
    app: AccountApp
    step: Literal["sign-in", "request", "response", "error"]
    detail: str


class ReportHeader(TypedDict):
    version: str
    date: str


def shape_of(value: object, depth: int = _SHAPE_DEPTH) -> str:
    """The types of a parsed response, never its values."""
    if value is None:
        return "null"
    if isinstance(value, list):
        return f"[{len(value)} items]"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int | float):
        return "number"
    if isinstance(value, str):
        return "string"
    if not isinstance(value, dict):
        return "object"
    if depth == 0:
        return "{...}"
    items = list(value.items())
    shown = [f"{key}: {shape_of(item, depth - 1)}" for key, item in items[:_SHAPE_KEYS]]
    if len(items) > _SHAPE_KEYS:
        shown.append(f"...{len(items) - _SHAPE_KEYS} more")
    return "{" + ", ".join(shown) + "}"


def request_detail(method: str, url: str) -> str:
    """Query strings can carry keys, so only the host and path are kept."""
    return f"{method} {_QUERY.sub('', _SCHEME.sub('', url))}"


def account_label(kind: ProviderKind, index: int) -> str:
    """Accounts are numbered per service, so a report never carries the names users gave them."""
    return f"{kind}-{index}"


def _iso(at: float) -> str:
    moment = datetime.fromtimestamp(at // 1000, UTC)
    return f"{moment:%Y-%m-%dT%H:%M:%S}.{int(at) % 1000:03d}Z"


def format_report(entries: list[DiagnosticEntry], header: ReportHeader) -> str:
    lines = [f"Token Grill service {header['version']} - {header['date']}"]
    lines.extend(
        f"{_iso(entry['at'])} {entry['account']} ({entry['kind']}, {entry['app']}) {entry['step']}: {entry['detail']}"
        for entry in entries
    )
    return "\n".join(lines) + "\n"
