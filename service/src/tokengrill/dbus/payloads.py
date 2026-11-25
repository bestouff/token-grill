"""The JSON strings that cross the bus, and the D-Bus errors raised for bad input."""

import json
from typing import Final

from dbus_fast import DBusError

from tokengrill.core.types import Alert, ProviderRuntimeState, ProviderSnapshot, ServiceState

ERROR_PREFIX: Final = "io.github.sh02sahil.TokenGrill.Error"
INVALID_ARGS: Final = f"{ERROR_PREFIX}.InvalidArgs"
SHUTTING_DOWN: Final = f"{ERROR_PREFIX}.ShuttingDown"
KEYRING_UNAVAILABLE: Final = f"{ERROR_PREFIX}.KeyringUnavailable"
INTERNAL: Final = f"{ERROR_PREFIX}.Internal"


def state_json(state: ServiceState) -> str:
    return json.dumps(state, separators=(",", ":"))


def alert_json(alert: Alert) -> str:
    return json.dumps(alert, separators=(",", ":"))


def account_json(snapshot: ProviderSnapshot, runtime: ProviderRuntimeState) -> str:
    return json.dumps({"schema": 1, "snapshot": snapshot, "runtime": runtime}, separators=(",", ":"))


def parse_json_arg(text: str) -> object:
    try:
        return json.loads(text)
    # Python before 3.14 raises RecursionError, not a decode error, for deeply nested arrays.
    except (ValueError, RecursionError) as error:
        raise DBusError(INVALID_ARGS, "the argument is not valid JSON") from error
