import threading
import time
from collections.abc import Iterator
from typing import Any

import pytest
import secretstorage

from tokengrill.core.errors import ServiceError
from tokengrill.providers import keyring

SCHEMA = "org.freedesktop.Secret.Generic"
ATTRS = {"service": "copilot-cli"}
UNAVAILABLE = "copilot.keyring-unavailable"


class FakeConnection:
    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True


class FakeItem:
    def __init__(self, secret: bytes, locked: bool = False, attributes: dict[str, str] | None = None) -> None:
        self._secret = secret
        self._locked = locked
        self._attributes = attributes if attributes is not None else {"xdg:schema": SCHEMA, **ATTRS}
        self.calls: list[str] = []

    def is_locked(self) -> bool:
        return self._locked

    def get_attributes(self) -> dict[str, str]:
        return dict(self._attributes)

    def get_secret(self) -> bytes:
        self.calls.append("get_secret")
        return self._secret

    def unlock(self) -> bool:
        self.calls.append("unlock")
        return False

    def delete(self) -> None:
        self.calls.append("delete")


class FakeCollection:
    def __init__(self, locked: bool = False) -> None:
        self.locked = locked
        self.calls: list[str] = []
        self.created: list[tuple[str, dict[str, str], bytes, bool]] = []
        self.items: list[FakeItem] = []

    def is_locked(self) -> bool:
        return self.locked

    def unlock(self) -> bool:
        self.calls.append("unlock")
        self.locked = False
        return False

    def create_item(self, label: str, attributes: dict[str, str], secret: bytes, replace: bool = False) -> FakeItem:
        self.created.append((label, attributes, secret, replace))
        return FakeItem(secret)

    def search_items(self, attributes: dict[str, str]) -> Iterator[FakeItem]:
        self.calls.append("search_items")
        return iter(self.items)


@pytest.fixture
def connection(monkeypatch: pytest.MonkeyPatch) -> FakeConnection:
    fake = FakeConnection()
    monkeypatch.setattr(secretstorage, "dbus_init", lambda: fake)
    return fake


def serve(monkeypatch: pytest.MonkeyPatch, items: list[FakeItem]) -> list[dict[str, str]]:
    searches: list[dict[str, str]] = []

    def search(_connection: Any, attributes: dict[str, str]) -> Iterator[FakeItem]:
        searches.append(attributes)
        return iter(items)

    monkeypatch.setattr(secretstorage, "search_items", search)
    return searches


async def test_unlocked_match_returns_the_secret(monkeypatch: pytest.MonkeyPatch, connection: FakeConnection) -> None:
    searches = serve(monkeypatch, [FakeItem(b"s3cret")])
    assert await keyring.lookup_secret(SCHEMA, ATTRS, UNAVAILABLE) == "s3cret"
    assert searches == [{"xdg:schema": SCHEMA, "service": "copilot-cli"}]
    assert connection.closed


async def test_no_match_is_none(monkeypatch: pytest.MonkeyPatch, connection: FakeConnection) -> None:
    serve(monkeypatch, [])
    assert await keyring.lookup_secret(SCHEMA, ATTRS, UNAVAILABLE) is None
    assert connection.closed


async def test_other_schema_is_ignored(monkeypatch: pytest.MonkeyPatch, connection: FakeConnection) -> None:
    serve(monkeypatch, [FakeItem(b"x", attributes={"xdg:schema": "other", **ATTRS})])
    assert await keyring.lookup_secret(SCHEMA, ATTRS, UNAVAILABLE) is None


async def test_locked_match_is_unavailable_without_unlock(
    monkeypatch: pytest.MonkeyPatch, connection: FakeConnection
) -> None:
    locked = FakeItem(b"s3cret", locked=True)
    serve(monkeypatch, [locked])
    with pytest.raises(ServiceError) as raised:
        await keyring.lookup_secret(SCHEMA, ATTRS, UNAVAILABLE)
    assert (raised.value.code, raised.value.message_id) == ("dependency", UNAVAILABLE)
    assert locked.calls == []
    assert connection.closed


async def test_unlocked_match_wins_over_a_locked_one(
    monkeypatch: pytest.MonkeyPatch, connection: FakeConnection
) -> None:
    locked = FakeItem(b"old", locked=True)
    serve(monkeypatch, [locked, FakeItem(b"new")])
    assert await keyring.lookup_secret(SCHEMA, ATTRS, UNAVAILABLE) == "new"
    assert locked.calls == []


async def test_no_secret_service_is_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    def refuse() -> None:
        raise secretstorage.SecretServiceNotAvailableException("none")

    monkeypatch.setattr(secretstorage, "dbus_init", refuse)
    with pytest.raises(ServiceError) as raised:
        await keyring.lookup_secret(SCHEMA, ATTRS, UNAVAILABLE)
    assert (raised.value.code, raised.value.message_id) == ("dependency", UNAVAILABLE)


async def test_no_secret_service_times_out_in_3s(monkeypatch: pytest.MonkeyPatch) -> None:
    release = threading.Event()

    def hang() -> None:
        release.wait(10)

    monkeypatch.setattr(secretstorage, "dbus_init", hang)
    started = time.monotonic()
    try:
        with pytest.raises(ServiceError) as raised:
            await keyring.lookup_secret(SCHEMA, ATTRS, UNAVAILABLE)
    finally:
        release.set()
    assert (raised.value.code, raised.value.message_id) == ("dependency", UNAVAILABLE)
    assert 2.5 <= time.monotonic() - started < 5


async def test_store_replaces_the_item_in_the_default_collection(
    monkeypatch: pytest.MonkeyPatch, connection: FakeConnection
) -> None:
    collection = FakeCollection(locked=True)
    monkeypatch.setattr(secretstorage, "get_default_collection", lambda _connection: collection)
    await keyring.store_api_key("deepseek-1", "sk-test")
    assert collection.calls == ["unlock"]
    assert collection.created == [
        (
            "Token Grill: DeepSeek API key",
            {"xdg:schema": keyring.TOKEN_GRILL_KEY_SCHEMA, "account": "deepseek-1"},
            b"sk-test",
            True,
        )
    ]
    assert connection.closed


async def test_clear_deletes_only_the_matching_items(
    monkeypatch: pytest.MonkeyPatch, connection: FakeConnection
) -> None:
    collection = FakeCollection()
    mine = FakeItem(b"k", attributes={"xdg:schema": keyring.TOKEN_GRILL_KEY_SCHEMA, "account": "d1"})
    other = FakeItem(b"k", attributes={"xdg:schema": "other", "account": "d1"})
    collection.items = [mine, other]
    monkeypatch.setattr(secretstorage, "get_default_collection", lambda _connection: collection)
    await keyring.clear_api_key("d1")
    assert mine.calls == ["delete"]
    assert other.calls == []
    assert connection.closed


async def test_store_failure_is_a_dependency_error(monkeypatch: pytest.MonkeyPatch, connection: FakeConnection) -> None:
    def dismissed(_connection: Any) -> FakeCollection:
        raise secretstorage.PromptDismissedException("no")

    monkeypatch.setattr(secretstorage, "get_default_collection", dismissed)
    with pytest.raises(ServiceError) as raised:
        await keyring.store_api_key("d1", "k")
    assert raised.value.code == "dependency"
    assert connection.closed
