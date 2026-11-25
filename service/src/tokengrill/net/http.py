"""The one HTTPS client: fixed hosts, no redirects, a bounded body, one User-Agent."""

import json
import re
import ssl
from collections.abc import Mapping
from types import TracebackType
from typing import Any, Self
from urllib.parse import urlsplit

import httpx

from tokengrill.core.errors import ServiceError, http_error
from tokengrill.core.json_util import parse_record

# The session's User-Agent names every monitored service: the Antigravity quota API answers 403
# to clients whose User-Agent does not mention Antigravity.
USER_AGENT = (
    "TokenGrill (+https://github.com/sh02sahil/token-grill; usage monitor for Codex, Claude, Kiro, "
    "Antigravity, Copilot, OpenCode Go, DeepSeek, Kimi Code and Cursor)"
)

MAX_RESPONSE_BYTES = 1024 * 1024
TIMEOUT_SECONDS = 30

# GetUsageLimits is served by the Amazon Q endpoint of these regions only.
KIRO_SERVICE_HOSTS: tuple[str, ...] = (
    "codewhisperer.us-east-1.amazonaws.com",
    "q.eu-central-1.amazonaws.com",
    "q.us-gov-east-1.amazonaws.com",
    "q.us-gov-west-1.amazonaws.com",
    "q.us-iso-east-1.c2s.ic.gov",
    "q.us-isob-east-1.sc2s.sgov.gov",
    "q.us-isof-south-1.csp.hci.ic.gov",
    "q.us-isof-east-1.csp.hci.ic.gov",
)

ALLOWED_HOSTS: frozenset[str] = frozenset(
    {
        "api.anthropic.com",
        "api.deepseek.com",
        "api2.cursor.sh",
        "api.github.com",
        "api.kimi.ai",
        "api.kimi.com",
        "chatgpt.com",
        "cloudcode-pa.googleapis.com",
        "oauth2.googleapis.com",
        "opencode.ai",
        *KIRO_SERVICE_HOSTS,
    }
)
KIRO_OIDC_HOST = re.compile(r"oidc\.[a-z0-9-]+\.amazonaws\.com")
_REASON = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{0,79}")


def is_allowed_host(host: str) -> bool:
    return host in ALLOWED_HOSTS or KIRO_OIDC_HOST.fullmatch(host) is not None


def _url_allowed(url: str) -> bool:
    try:
        parts = urlsplit(url)
        host = parts.hostname or ""
        userinfo = "@" in parts.netloc
        _ = parts.port
    except ValueError:
        return False
    return parts.scheme == "https" and not userinfo and is_allowed_host(host)


def service_error_reason(body: str) -> str | None:
    """Only identifier-shaped values are returned, so free text that might echo request data never reaches the UI."""
    payload = parse_record(body)
    if payload is None:
        return None
    raw_type = payload.get("__type")
    type_name = raw_type.split("#")[-1] if isinstance(raw_type, str) else None
    for candidate in (payload.get("reason"), type_name, payload.get("error"), payload.get("code")):
        if isinstance(candidate, str) and _REASON.fullmatch(candidate):
            return candidate
    return None


def _is_tls_error(error: httpx.TransportError) -> bool:
    cause: BaseException | None = error
    while cause is not None:
        if isinstance(cause, ssl.SSLError):
            return True
        cause = cause.__cause__ or cause.__context__
    return "SSL" in str(error)


def _network_error(error: httpx.TransportError) -> ServiceError:
    if isinstance(error, httpx.TimeoutException):
        return ServiceError("timeout", "net.timed-out")
    if _is_tls_error(error):
        return ServiceError("http", "net.tls-failed")
    return ServiceError("offline", "net.offline")


def _declared_length(response: httpx.Response) -> int:
    try:
        return int(response.headers.get("content-length", "0"))
    except ValueError:
        return 0


class HttpClient:
    def __init__(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._client = httpx.AsyncClient(
            transport=transport,
            follow_redirects=False,
            timeout=TIMEOUT_SECONDS,
            headers={"User-Agent": USER_AGENT},
        )

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None
    ) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._client.aclose()

    async def request_json(
        self, method: str, url: str, headers: Mapping[str, str], body: object | None = None
    ) -> object:
        if not _url_allowed(url):
            raise ServiceError("http", "net.not-allowed")
        send_headers = {name: value for name, value in headers.items() if name.lower() != "user-agent"}
        content: bytes | None = None
        if body is not None:
            if not any(name.lower() == "content-type" for name in send_headers):
                send_headers["Content-Type"] = "application/json"
            content = json.dumps(body, separators=(",", ":")).encode()
        try:
            data = await self._fetch(method, url, send_headers, content)
        except httpx.TransportError as error:
            raise _network_error(error) from None
        return self._parse(data)

    async def _fetch(self, method: str, url: str, headers: dict[str, str], content: bytes | None) -> tuple[int, bytes]:
        async with self._client.stream(method, url, headers=headers, content=content) as response:
            # A response that declares too much is dropped before its body is read.
            if _declared_length(response) > MAX_RESPONSE_BYTES:
                raise ServiceError("response-shape", "net.too-large")
            received = bytearray()
            async for chunk in response.aiter_bytes():
                received.extend(chunk)
                if len(received) > MAX_RESPONSE_BYTES:
                    raise ServiceError("response-shape", "net.too-large")
            return response.status_code, bytes(received)

    @staticmethod
    def _parse(data: tuple[int, bytes]) -> object:
        status, raw = data
        text = raw.decode("utf-8", errors="replace")
        if status < 200 or status >= 300:
            raise http_error(status, service_error_reason(text))
        if not text:
            return None
        parsed: Any
        try:
            parsed = json.loads(text)
        except ValueError:
            raise ServiceError("response-shape", "net.invalid-json") from None
        return parsed
