"""Cursor usage limits from the Cursor app or CLI sign-in."""

import hashlib
from dataclasses import dataclass

from tokengrill.core.errors import ServiceError
from tokengrill.core.paths import provider_paths
from tokengrill.core.types import ProviderInstance, ProviderSnapshot, empty_snapshot
from tokengrill.providers.base import CollectorContext, LimitsUpdate, collect_limits
from tokengrill.providers.cursor.auth import (
    CursorAuth,
    cursor_database_stamp,
    is_cursor_token_fresh,
    read_cursor_agent_auth,
    read_cursor_auth,
)
from tokengrill.providers.cursor.normalize import normalize_cursor_plan, normalize_cursor_usage

DASHBOARD_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService"


def _request_headers(access_token: str) -> dict[str, str]:
    """The dashboard service speaks the Connect protocol, which takes JSON over POST."""
    return {
        "Accept": "application/json",
        "Authorization": f"Bearer {access_token}",
        "Connect-Protocol-Version": "1",
        "Content-Type": "application/json",
    }


@dataclass(frozen=True)
class _Stored:
    stamp: str
    result: CursorAuth | ServiceError


class CursorCollector:
    def __init__(self) -> None:
        # Stored app sign-ins, re-read only when Cursor's database changes on disk.
        self._stored: dict[str, _Stored] = {}
        # The plan rarely changes, so it is asked for again only for a new sign-in or billing cycle.
        self._plans: dict[str, tuple[str, str | None]] = {}
        # The account each configured account last read, so a switch never shows the previous numbers.
        self._subjects: dict[str, str | None] = {}

    async def collect(
        self, instance: ProviderInstance, snapshot: ProviderSnapshot, ctx: CollectorContext
    ) -> ProviderSnapshot:
        if not instance["liveUsageEnabled"]:
            return snapshot
        try:
            auth = await self._auth(instance)
        except ServiceError as error:
            failure = error

            async def rejected() -> LimitsUpdate:
                raise failure

            return await collect_limits(ctx, snapshot, rejected)
        instance_id = instance["id"]
        switched = instance_id in self._subjects and self._subjects[instance_id] != auth.subject
        self._subjects[instance_id] = auth.subject
        start = empty_snapshot(instance_id) if switched else snapshot
        return await collect_limits(ctx, start, lambda: self._fetch_limits(instance, ctx, auth))

    async def _auth(self, instance: ProviderInstance) -> CursorAuth:
        path = provider_paths(instance)["authFile"]
        if instance["app"] == "cursor-agent":
            return await read_cursor_agent_auth(path)
        return await self._stored_auth(path)

    async def _stored_auth(self, path: str) -> CursorAuth:
        stamp = await cursor_database_stamp(path)
        cached = self._stored.get(path)
        result = cached.result if cached is not None and cached.stamp == stamp else None
        if result is None:
            # A failed read is kept too: an encrypted or signed-out sign-in would otherwise reopen the
            # database on every refresh.
            try:
                result = await read_cursor_auth(path)
            except ServiceError as error:
                result = error
            self._stored[path] = _Stored(stamp, result)
        if isinstance(result, ServiceError):
            raise result
        return result

    async def _fetch_limits(self, instance: ProviderInstance, ctx: CollectorContext, auth: CursorAuth) -> LimitsUpdate:
        if not is_cursor_token_fresh(auth):
            raise ServiceError("auth-expired", "cursor.auth-expired")
        headers = _request_headers(auth.access_token)
        payload = await ctx.http.request_json("POST", f"{DASHBOARD_URL}/GetCurrentPeriodUsage", headers, {})
        windows = normalize_cursor_usage(payload)
        if not windows:
            raise ServiceError("response-shape", "net.no-usage")
        sign_in = hashlib.sha256(auth.access_token.encode()).hexdigest()
        plan = await self._plan(instance, ctx, headers, f"{sign_in}|{windows[0]['resetAt']}")
        return {"windows": windows, "plan": plan, "account": auth.email}

    async def _plan(
        self, instance: ProviderInstance, ctx: CollectorContext, headers: dict[str, str], key: str
    ) -> str | None:
        cached = self._plans.get(instance["id"])
        if cached is not None and cached[0] == key and not ctx.manual:
            return cached[1]
        payload = await ctx.http.request_json("POST", f"{DASHBOARD_URL}/GetPlanInfo", headers, {})
        plan = normalize_cursor_plan(payload)
        self._plans[instance["id"]] = (key, plan)
        return plan
