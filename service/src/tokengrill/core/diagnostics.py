"""Redaction for the diagnostics a tester can share."""

import re

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
