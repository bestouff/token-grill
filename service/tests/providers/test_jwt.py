import base64
import json

from tokengrill.providers.jwt import jwt_expiry, jwt_subject


def token(claims: object) -> str:
    body = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"h.{body}.s"


def test_expiry_and_subject() -> None:
    value = token({"exp": 1_800_000_000, "sub": "user-1"})
    assert jwt_expiry(value) == 1_800_000_000_000
    assert jwt_subject(value) == "user-1"


def test_malformed_tokens_yield_none() -> None:
    for bad in ("", "abc", "a.!!!.c", "a.bm90IGpzb24.c", token([1])):
        assert jwt_expiry(bad) is None
        assert jwt_subject(bad) is None
