"""Let Claude Code own token rotation, locking, and credential writes."""

import asyncio
import contextlib
import os
from pathlib import Path
from time import monotonic

from tokengrill.core.errors import ServiceError
from tokengrill.core.json_util import record_at, string_at
from tokengrill.core.paths import provider_paths
from tokengrill.core.types import ProviderInstance
from tokengrill.providers.base import CollectorContext
from tokengrill.providers.claude.auth import load_claude_access_token
from tokengrill.providers.credentials import read_credential_json

RENEWAL_TIMEOUT_SECONDS = 30
RETRY_SECONDS = 300


class ClaudeTokenLoader:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._retry_after: dict[str, float] = {}

    async def load(self, instance: ProviderInstance, ctx: CollectorContext) -> str:
        # Accounts can share a credentials file. A waiter must reread it after renewal.
        async with self._lock:
            try:
                return await load_claude_access_token(instance)
            except ServiceError as error:
                if error.code != "auth-expired" or instance["app"] != "claude-code":
                    raise
                path = Path(provider_paths(instance)["authFile"])
                now = monotonic()
                self._retry_after = {key: due for key, due in self._retry_after.items() if due > now}
                # The CLI has no option for an arbitrarily named credentials file.
                if path.name != ".credentials.json" or str(path) in self._retry_after:
                    raise
                oauth = record_at(await read_credential_json(str(path)), "claudeAiOauth")
                if not oauth or not string_at(oauth, "refreshToken"):
                    raise
                self._retry_after[str(path)] = now + RETRY_SECONDS
            result = await _run_cli(path.parent)
            ctx.record("sign-in", result)
            # auth status may exit zero even when its startup refresh failed.
            return await load_claude_access_token(instance)


async def _run_cli(home: Path) -> str:
    # Inherited provider overrides can select a different login than this account.
    env = {key: value for key, value in os.environ.items() if not key.startswith(("CLAUDE_", "ANTHROPIC_"))}
    env.update(
        CLAUDE_CONFIG_DIR=str(home),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1",
        DISABLE_AUTOUPDATER="1",
        DISABLE_TELEMETRY="1",
        DISABLE_ERROR_REPORTING="1",
    )
    # D-Bus activation can omit the native Claude install directory from PATH.
    env["PATH"] = os.pathsep.join([*os.get_exec_path(), str(Path.home() / ".local" / "bin")])
    try:
        process = await asyncio.create_subprocess_exec(
            "claude",
            "auth",
            "status",
            cwd="/",
            env=env,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except OSError:
        return "Claude CLI could not start"
    try:
        async with asyncio.timeout(RENEWAL_TIMEOUT_SECONDS):
            code = await process.wait()
        return f"Claude CLI exited with status {code}"
    except TimeoutError:
        return "Claude CLI timed out"
    finally:
        if process.returncode is None:
            # The child can exit between the returncode check and the signal.
            with contextlib.suppress(ProcessLookupError):
                process.kill()
        await process.wait()
