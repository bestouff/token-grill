import json
from collections.abc import AsyncIterator

import httpx
import pytest

from tokengrill.core.errors import ServiceError
from tokengrill.net.http import ALLOWED_HOSTS, USER_AGENT, HttpClient, is_allowed_host, service_error_reason

MAX = 1024 * 1024


def _client(handler: httpx.MockTransport) -> HttpClient:
    return HttpClient(transport=handler)


def _recording(response: httpx.Response) -> tuple[httpx.MockTransport, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return response

    return httpx.MockTransport(handle), seen


async def test_rejects_http_scheme() -> None:
    transport, seen = _recording(httpx.Response(200, json={}))
    with pytest.raises(ServiceError) as err:
        await _client(transport).request_json("GET", "http://api.github.com/x", {})
    assert err.value.message_id == "net.not-allowed"
    assert err.value.code == "http"
    assert seen == []


async def test_rejects_unknown_host() -> None:
    transport, seen = _recording(httpx.Response(200, json={}))
    for url in ("https://evil.example.com/", "https://api.github.com.evil.com/", "https://user@api.github.com/"):
        with pytest.raises(ServiceError) as err:
            await _client(transport).request_json("GET", url, {})
        assert err.value.message_id == "net.not-allowed"
    assert seen == []


async def test_accepts_kiro_oidc_host() -> None:
    transport, seen = _recording(httpx.Response(200, json={"ok": True}))
    result = await _client(transport).request_json("POST", "https://oidc.us-east-1.amazonaws.com/token", {}, {"a": 1})
    assert result == {"ok": True}
    assert len(seen) == 1
    assert is_allowed_host("oidc.eu-central-1.amazonaws.com")
    assert not is_allowed_host("oidc.us-east-1.amazonaws.com.evil.com")
    assert not is_allowed_host("oidc.US-east-1.amazonaws.com")
    assert "codewhisperer.us-east-1.amazonaws.com" in ALLOWED_HOSTS
    assert "opencode.ai" in ALLOWED_HOSTS


async def test_redirect_is_an_error() -> None:
    transport, seen = _recording(httpx.Response(302, headers={"Location": "https://evil.example.com/"}))
    with pytest.raises(ServiceError) as err:
        await _client(transport).request_json("GET", "https://api.github.com/x", {})
    assert err.value.message_id == "net.http-status-bare"
    assert err.value.params == {"status": "302"}
    assert len(seen) == 1


async def test_429_is_rate_limited() -> None:
    transport, _ = _recording(httpx.Response(429, json={"error": "slow_down"}))
    with pytest.raises(ServiceError) as err:
        await _client(transport).request_json("GET", "https://api.github.com/x", {})
    assert err.value.code == "rate-limited"
    assert err.value.params == {"status": "429", "reason": "slow_down"}


async def test_401_is_auth_invalid() -> None:
    transport, _ = _recording(httpx.Response(401, text="nope"))
    with pytest.raises(ServiceError) as err:
        await _client(transport).request_json("GET", "https://api.github.com/x", {})
    assert err.value.code == "auth-invalid"
    assert err.value.message_id == "net.http-status-bare"


async def test_streamed_body_over_limit_is_too_large() -> None:
    async def chunks() -> AsyncIterator[bytes]:
        yield b"a" * MAX
        yield b"b"

    transport, _ = _recording(httpx.Response(200, content=chunks()))
    with pytest.raises(ServiceError) as err:
        await _client(transport).request_json("GET", "https://api.github.com/x", {})
    assert err.value.message_id == "net.too-large"
    assert err.value.code == "response-shape"


async def test_content_length_over_limit_is_too_large() -> None:
    transport, _ = _recording(httpx.Response(200, headers={"Content-Length": str(MAX + 1)}, content=b"{}"))
    with pytest.raises(ServiceError) as err:
        await _client(transport).request_json("GET", "https://api.github.com/x", {})
    assert err.value.message_id == "net.too-large"


async def test_body_of_exactly_the_limit_is_read() -> None:
    padding = " " * (MAX - 2)
    transport, _ = _recording(httpx.Response(200, content=("{}" + padding).encode()))
    assert await _client(transport).request_json("GET", "https://api.github.com/x", {}) == {}


async def test_sends_single_user_agent() -> None:
    transport, seen = _recording(httpx.Response(200, json={}))
    await _client(transport).request_json(
        "GET", "https://api.github.com/x", {"user-agent": "evil", "User-Agent": "evil2", "Accept": "a/b"}
    )
    assert seen[0].headers.get_list("user-agent") == [USER_AGENT]
    assert seen[0].headers["accept"] == "a/b"


async def test_user_agent_is_verbatim() -> None:
    assert USER_AGENT == (
        "TokenGrill (+https://github.com/sh02sahil/token-grill; usage monitor for Codex, Claude, Kiro, "
        "Antigravity, Copilot, OpenCode Go, DeepSeek, Kimi Code and Cursor)"
    )


async def test_body_is_json_encoded() -> None:
    transport, seen = _recording(httpx.Response(200, json={}))
    await _client(transport).request_json("POST", "https://api.github.com/x", {}, {"k": [1, "v"]})
    assert json.loads(seen[0].content) == {"k": [1, "v"]}
    assert seen[0].headers["content-type"] == "application/json"


async def test_caller_content_type_is_kept() -> None:
    transport, seen = _recording(httpx.Response(200, json={}))
    await _client(transport).request_json(
        "POST", "https://api.github.com/x", {"Content-Type": "application/x-www-form-urlencoded"}, {"k": 1}
    )
    assert seen[0].headers["content-type"] == "application/x-www-form-urlencoded"


async def test_no_body_sends_none() -> None:
    transport, seen = _recording(httpx.Response(200, json={}))
    await _client(transport).request_json("GET", "https://api.github.com/x", {})
    assert seen[0].content == b""


async def test_empty_response_is_none() -> None:
    transport, _ = _recording(httpx.Response(204))
    assert await _client(transport).request_json("GET", "https://api.github.com/x", {}) is None


async def test_invalid_json() -> None:
    transport, _ = _recording(httpx.Response(200, text="<html>"))
    with pytest.raises(ServiceError) as err:
        await _client(transport).request_json("GET", "https://api.github.com/x", {})
    assert err.value.message_id == "net.invalid-json"
    assert err.value.code == "response-shape"


@pytest.mark.parametrize(
    ("exc", "code", "message_id"),
    [
        (httpx.ConnectError("down"), "offline", "net.offline"),
        (httpx.ReadError("reset"), "offline", "net.offline"),
        (httpx.ConnectTimeout("slow"), "timeout", "net.timed-out"),
        (httpx.ReadTimeout("slow"), "timeout", "net.timed-out"),
        (httpx.ConnectError("[SSL: CERTIFICATE_VERIFY_FAILED] bad"), "http", "net.tls-failed"),
    ],
)
async def test_transport_errors_are_mapped(exc: Exception, code: str, message_id: str) -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        raise exc

    with pytest.raises(ServiceError) as err:
        await _client(httpx.MockTransport(handle)).request_json("GET", "https://api.github.com/x", {})
    assert err.value.code == code
    assert err.value.message_id == message_id


async def test_ssl_cause_is_tls_failed() -> None:
    import ssl

    def handle(request: httpx.Request) -> httpx.Response:
        error = httpx.ConnectError("handshake")
        error.__cause__ = ssl.SSLError("bad")
        raise error

    with pytest.raises(ServiceError) as err:
        await _client(httpx.MockTransport(handle)).request_json("GET", "https://api.github.com/x", {})
    assert err.value.message_id == "net.tls-failed"


def test_reason_is_taken_from_aws_and_oauth_bodies() -> None:
    aws = '{"__type":"com.amazon.aws.codewhisperer#AccessDeniedException","message":"FEATURE_NOT_SUPPORTED","reason":"FEATURE_NOT_SUPPORTED"}'
    assert service_error_reason(aws) == "FEATURE_NOT_SUPPORTED"
    no_reason = '{"__type":"com.amazon.aws.codewhisperer#AccessDeniedException","message":"User is not authorized."}'
    assert service_error_reason(no_reason) == "AccessDeniedException"
    assert (
        service_error_reason('{"error":"invalid_grant","error_description":"Invalid refresh token"}') == "invalid_grant"
    )
    assert service_error_reason('{"code":"E_1"}') == "E_1"
    assert service_error_reason('{"reason":"contains a secret value aoaAAAA and spaces"}') is None
    assert service_error_reason('{"reason":"ok\\n"}') is None
    assert service_error_reason("not json") is None
    assert service_error_reason("") is None
    assert service_error_reason("[]") is None


async def test_http_error_reason_from_body() -> None:
    transport, _ = _recording(httpx.Response(403, json={"__type": "x.y#AccessDeniedException"}))
    with pytest.raises(ServiceError) as err:
        await _client(transport).request_json("GET", "https://api.github.com/x", {})
    assert err.value.message_id == "net.http-status"
    assert err.value.params == {"status": "403", "reason": "AccessDeniedException"}
