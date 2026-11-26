"""The exported D-Bus object; interface.xml next to it is the source of truth for its shape."""

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Final, TypeVar

from dbus_fast import DBusError, PropertyAccess
from dbus_fast.service import ServiceInterface, dbus_property, method, signal

import tokengrill
from tokengrill.core.errors import InvalidRequest, ServiceError
from tokengrill.core.runtime import Runtime
from tokengrill.core.types import Alert, ProviderInstance, ProviderRuntimeState, Settings, SnapshotView
from tokengrill.dbus.clients import CLIENT_KINDS
from tokengrill.dbus.payloads import (
    INTERNAL,
    INVALID_ARGS,
    KEYRING_UNAVAILABLE,
    SHUTTING_DOWN,
    account_json,
    alert_json,
    parse_json_arg,
    state_json,
)

INTERFACE_NAME: Final = "io.github.sh02sahil.TokenGrill1"
_LOG = logging.getLogger("tokengrill.dbus")
_T = TypeVar("_T")


def _result(value: dict[str, object]) -> str:
    return json.dumps({"schema": 1, **value}, separators=(",", ":"))


async def _checked(work: Awaitable[_T]) -> _T:
    """A request the service cannot carry out is a D-Bus error of the caller, not a bug."""
    try:
        return await work
    except InvalidRequest as error:
        raise DBusError(INVALID_ARGS, str(error)) from error


def _checked_sync(work: Callable[[], _T]) -> _T:
    try:
        return work()
    except InvalidRequest as error:
        raise DBusError(INVALID_ARGS, str(error)) from error


class TokenGrillInterface(ServiceInterface):
    """Implements the Emitter of the runtime by emitting signals.

    The dbus-fast type strings in the annotations are D-Bus signatures, not Python types.
    """

    def __init__(
        self, on_call_started: Callable[[], None] = lambda: None, on_call_finished: Callable[[], None] = lambda: None
    ) -> None:
        super().__init__(INTERFACE_NAME)
        self._on_call_started = on_call_started
        self._on_call_finished = on_call_finished
        self._muted = False
        self._runtime: Runtime | None = None
        # The object is exported before the name is owned, so a call that activated the service finds it;
        # the calls wait here until the runtime has loaded its stores.
        self._ready = asyncio.Event()

    def attach(self, runtime: Runtime) -> None:
        self._runtime = runtime
        self._ready.set()

    @property
    def attached(self) -> bool:
        return self._runtime is not None

    def mute(self) -> None:
        """The bus is gone: the runtime may still report while it stops, but nothing can be sent."""
        self._muted = True

    def detach(self) -> None:
        """Called before the runtime stops: a late call must not restart the scheduler or a collection."""
        self._runtime = None
        self._ready.set()

    async def _attached(self) -> Runtime:
        await self._ready.wait()
        if self._runtime is None:
            raise DBusError(SHUTTING_DOWN, "the service is shutting down")
        return self._runtime

    @asynccontextmanager
    async def _call(self) -> AsyncIterator[Runtime]:
        """Counts the call as in flight, so the idle timer cannot cut it off.

        A D-Bus error is the caller's answer. Anything else, a bug or a failed write of the service's own
        files, goes to the journal, and the caller gets the Internal error instead of a traceback.
        """
        self._on_call_started()
        try:
            yield await self._attached()
        except DBusError:
            raise
        except Exception as error:
            _LOG.exception("a D-Bus method failed")
            raise DBusError(INTERNAL, "the service hit an unexpected error") from error
        finally:
            self._on_call_finished()

    # Emitter

    def account_changed(self, account_id: str, snapshot: SnapshotView, runtime: ProviderRuntimeState) -> None:
        if self._muted:
            return
        self.AccountChanged(account_id, account_json(snapshot, runtime))

    def accounts_changed(self, accounts: list[ProviderInstance]) -> None:
        if self._muted:
            return
        self.AccountsChanged(json.dumps({"schema": 1, "accounts": accounts}, separators=(",", ":")))

    def settings_changed(self, settings: Settings) -> None:
        if self._muted:
            return
        self.SettingsChanged(json.dumps({"schema": 1, "settings": settings}, separators=(",", ":")))

    def alert(self, alert: Alert) -> None:
        if self._muted:
            return
        self.Alert(alert_json(alert))

    # Properties

    @dbus_property(access=PropertyAccess.READ)
    def ApiVersion(self) -> "u":
        return tokengrill.API_VERSION

    @dbus_property(access=PropertyAccess.READ)
    def ServiceVersion(self) -> "s":
        return tokengrill.__version__

    # Implemented methods

    @method()
    async def Hello(self, client: "s") -> "s":
        # The service registers the sender in a bus-level handler, before this runs.
        if client not in CLIENT_KINDS:
            raise DBusError(INVALID_ARGS, "client must be shell, prefs or cli")
        async with self._call() as runtime:
            return state_json(runtime.state())

    @method()
    def Goodbye(self) -> None:
        # The service registers the departure in a bus-level handler: a client that shares its bus
        # connection with a larger process (the Shell) never has its name vanish.
        return None

    @method()
    async def GetState(self) -> "s":
        async with self._call() as runtime:
            return state_json(runtime.state())

    @method()
    async def Refresh(self, account_id: "s") -> None:
        async with self._call() as runtime:
            await runtime.refresh(account_id)

    @method()
    async def RefreshAll(self) -> None:
        async with self._call() as runtime:
            await runtime.refresh_all()

    @method()
    async def SetPaused(self, paused: "b") -> None:
        async with self._call() as runtime:
            runtime.set_paused(paused)

    @method()
    async def ImportAccounts(self, legacy: "s") -> "s":
        async with self._call() as runtime:
            return _result(dict(await _checked(runtime.import_accounts(parse_json_arg(legacy)))))

    @method()
    async def AddAccounts(self, accounts: "s") -> "s":
        # A DeepSeek draft may carry the pasted apiKey; it is stored before the account is added.
        async with self._call() as runtime:
            try:
                ids, errors = await _checked(runtime.add_accounts(parse_json_arg(accounts)))
            except ServiceError as error:
                raise DBusError(KEYRING_UNAVAILABLE, error.message_id) from error
            return _result({"errors": errors} if errors else {"ids": ids})

    @method()
    async def UpdateAccount(self, account: "s") -> "s":
        async with self._call() as runtime:
            return _result({"errors": await _checked(runtime.update_account(parse_json_arg(account)))})

    @method()
    async def RemoveAccount(self, id: "s", remove_key: "b") -> None:
        async with self._call() as runtime:
            await runtime.remove_account(id, remove_key)

    @method()
    async def ReorderAccounts(self, ids: "as") -> None:
        async with self._call() as runtime:
            await runtime.reorder_accounts(ids)

    @method()
    async def ValidateAccount(self, draft: "s") -> "s":
        async with self._call() as runtime:
            return _result({"errors": _checked_sync(lambda: runtime.validate_account(parse_json_arg(draft)))})

    # Declared now, implemented by later tasks

    @method()
    async def Discover(self, app: "s") -> "s":
        async with self._call() as runtime:
            return _result({"candidates": await _checked(runtime.discover(app))})

    @method()
    async def CredentialState(self, account_id: "s") -> "s":
        async with self._call() as runtime:
            return _result({"state": await _checked(runtime.credential_state(account_id))})

    @method()
    async def SaveApiKey(self, account_id: "s", key: "s") -> None:
        async with self._call() as runtime:
            try:
                await _checked(runtime.save_api_key(account_id, key))
            except ServiceError as error:
                # The message is an id such as deepseek.keyring-unavailable, never the key.
                raise DBusError(KEYRING_UNAVAILABLE, error.message_id) from error

    @method()
    async def ToggleLimit(self, account_id: "s", limit_key: "s") -> None:
        async with self._call() as runtime:
            await _checked(runtime.toggle_limit(account_id, limit_key))

    @method()
    async def SetAutomatic(self, account_id: "s", automatic: "b") -> None:
        async with self._call() as runtime:
            await _checked(runtime.set_automatic(account_id, automatic))

    @method()
    async def SetSettings(self, settings: "s") -> None:
        async with self._call() as runtime:
            await _checked(runtime.set_settings(parse_json_arg(settings)))

    @method()
    async def SendTestAlert(self, account_id: "s") -> None:
        async with self._call() as runtime:
            _checked_sync(lambda: runtime.send_test_alert(account_id))

    @method()
    async def DiagnosticsReport(self) -> "s":
        async with self._call() as runtime:
            return runtime.diagnostics_report()

    # Signals

    @signal()
    def AccountChanged(self, account_id: "s", snapshot: "s") -> "ss":
        return [account_id, snapshot]

    @signal()
    def AccountsChanged(self, accounts: "s") -> "s":
        return accounts

    @signal()
    def SettingsChanged(self, settings: "s") -> "s":
        return settings

    @signal()
    def Alert(self, alert: "s") -> "s":
        return alert
