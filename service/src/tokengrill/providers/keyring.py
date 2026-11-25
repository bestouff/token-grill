"""Secret Service access: read-only lookups of other tools' items and Token Grill's own API-key item."""

import asyncio
from concurrent.futures import ThreadPoolExecutor

import secretstorage
from jeepney.wrappers import DBusErrorResponse

from tokengrill.core.errors import ServiceError

# A running Secret Service answers in milliseconds, but when none is running
# D-Bus activation waits about 25 seconds, which would stall every refresh.
LOOKUP_TIMEOUT_SECONDS = 3

# Token Grill's own items: an API key the user pasted, keyed by account id.
TOKEN_GRILL_KEY_SCHEMA = "org.gnome.shell.extensions.tokengrill.ApiKey"
API_KEY_LABEL = "Token Grill: DeepSeek API key"
KEY_UNAVAILABLE = "deepseek.keyring-unavailable"

# A thread stuck in a hung Secret Service cannot be stopped, so lookups get two threads of their own: the
# default executor, which history scans use, is never taken over, and a hang cannot pile up threads.
_LOOKUP_WORKERS = 2
_lookup_executor = ThreadPoolExecutor(max_workers=_LOOKUP_WORKERS, thread_name_prefix="tokengrill-keyring")

# What a missing, locked or misbehaving Secret Service raises.
_SERVICE_ERRORS = (secretstorage.SecretStorageException, DBusErrorResponse, OSError)


def _search_attributes(schema: str, attributes: dict[str, str]) -> dict[str, str]:
    # libsecret matches xdg:schema for a schema without flags, and the items of
    # gh and agy carry it, so the lookup filters on it the same way.
    return {"xdg:schema": schema, **attributes}


def _lookup_sync(schema: str, attributes: dict[str, str], unavailable_id: str) -> str | None:
    wanted = _search_attributes(schema, attributes)
    connection = secretstorage.dbus_init()
    try:
        matches = [
            item
            for item in secretstorage.search_items(connection, wanted)
            if wanted.items() <= item.get_attributes().items()
        ]
        # Reading a locked item would raise or prompt; never unlock, a locked match counts as unavailable.
        for item in matches:
            if not item.is_locked():
                return bytes(item.get_secret()).decode("utf-8")
        if matches:
            raise ServiceError("dependency", unavailable_id)
        return None
    finally:
        connection.close()


async def lookup_secret(schema: str, attributes: dict[str, str], unavailable_id: str) -> str | None:
    """Reads another app's keyring item without ever asking the keyring to unlock."""
    loop = asyncio.get_running_loop()
    work = loop.run_in_executor(_lookup_executor, _lookup_sync, schema, attributes, unavailable_id)
    try:
        return await asyncio.wait_for(work, LOOKUP_TIMEOUT_SECONDS)
    except UnicodeDecodeError:
        pass
    except (TimeoutError, *_SERVICE_ERRORS) as error:
        raise ServiceError("dependency", unavailable_id) from error
    # Only a secret that is not UTF-8 gets here. It is raised outside the handler: the decode error holds the
    # secret's bytes, so it must be neither the cause nor the context of this error.
    raise ServiceError("dependency", unavailable_id)


def _own_attributes(account_id: str) -> dict[str, str]:
    return _search_attributes(TOKEN_GRILL_KEY_SCHEMA, {"account": account_id})


def _store_sync(account_id: str, key: str) -> None:
    connection = secretstorage.dbus_init()
    try:
        collection = secretstorage.get_default_collection(connection)
        # Saving is a user action in the preferences, so the keyring may ask to be unlocked.
        if collection.is_locked():
            collection.unlock()
        collection.create_item(API_KEY_LABEL, _own_attributes(account_id), key.encode("utf-8"), replace=True)
    finally:
        connection.close()


def _clear_sync(account_id: str) -> None:
    connection = secretstorage.dbus_init()
    try:
        collection = secretstorage.get_default_collection(connection)
        if collection.is_locked():
            collection.unlock()
        wanted = _own_attributes(account_id)
        for item in list(collection.search_items(wanted)):
            if wanted.items() <= item.get_attributes().items():
                item.delete()
    finally:
        connection.close()


async def store_api_key(account_id: str, key: str) -> None:
    try:
        await asyncio.to_thread(_store_sync, account_id, key)
    except _SERVICE_ERRORS as error:
        raise ServiceError("dependency", KEY_UNAVAILABLE) from error


async def clear_api_key(account_id: str) -> None:
    try:
        await asyncio.to_thread(_clear_sync, account_id)
    except _SERVICE_ERRORS as error:
        raise ServiceError("dependency", KEY_UNAVAILABLE) from error
