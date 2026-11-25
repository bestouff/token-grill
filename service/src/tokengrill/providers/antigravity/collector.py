"""Antigravity usage limits from the cloudcode-pa quota summary."""

import asyncio
import time
from dataclasses import replace

from tokengrill.core.errors import TRANSIENT_CODES, ServiceError
from tokengrill.core.json_util import is_record, number_at, string_at
from tokengrill.core.types import ProviderInstance, ProviderSnapshot
from tokengrill.providers.antigravity.auth import (
    AntigravityAuth,
    is_antigravity_refreshable,
    is_antigravity_token_fresh,
    resolve_antigravity_auth,
)
from tokengrill.providers.antigravity.endpoints import (
    GOOGLE_OAUTH_TOKEN_URL,
    LOAD_CODE_ASSIST_URL,
    RETRIEVE_USER_QUOTA_SUMMARY_URL,
)
from tokengrill.providers.antigravity.normalize import antigravity_plan, normalize_quota_summary
from tokengrill.providers.base import CollectorContext, LimitsUpdate, collect_limits


def _auth_expired(auth: AntigravityAuth) -> ServiceError:
    if auth.source == "keyring":
        return ServiceError("auth-expired", "antigravity.agy-expired")
    return ServiceError("auth-expired", "antigravity.auth-expired")


class AntigravityCollector:
    def __init__(self) -> None:
        # Tokens refreshed here, so the stored refresh token is not used on every pass. Kept in memory
        # only: no file or keyring item is ever written.
        self._refreshed: dict[str, AntigravityAuth] = {}

    async def collect(
        self, instance: ProviderInstance, snapshot: ProviderSnapshot, ctx: CollectorContext
    ) -> ProviderSnapshot:
        if not instance["liveUsageEnabled"]:
            return snapshot
        return await collect_limits(ctx, snapshot, lambda: self._fetch_limits(instance, ctx))

    async def _fetch_limits(self, instance: ProviderInstance, ctx: CollectorContext) -> LimitsUpdate:
        auth = await self._fresh_auth(instance, ctx)
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {auth.access_token}",
            "Content-Type": "application/json",
        }

        async def assist() -> object:
            # The tier only names the plan; the usage limits must not depend on it.
            try:
                return await ctx.http.request_json("POST", LOAD_CODE_ASSIST_URL, headers, {})
            except ServiceError as error:
                if error.code in TRANSIENT_CODES or error.code == "auth-invalid":
                    raise
                return None

        assist_task = asyncio.ensure_future(assist())
        summary_task = asyncio.ensure_future(
            ctx.http.request_json("POST", RETRIEVE_USER_QUOTA_SUMMARY_URL, headers, {})
        )
        try:
            assist_payload, summary_payload = await asyncio.gather(assist_task, summary_task)
        except BaseException:
            assist_task.cancel()
            summary_task.cancel()
            await asyncio.gather(assist_task, summary_task, return_exceptions=True)
            raise
        windows = normalize_quota_summary(summary_payload)
        if not windows:
            raise ServiceError("response-shape", "net.no-usage")
        return {"plan": antigravity_plan(assist_payload), "windows": windows}

    async def _fresh_auth(self, instance: ProviderInstance, ctx: CollectorContext) -> AntigravityAuth:
        stored = await resolve_antigravity_auth(instance)
        refreshed = self._refreshed.get(instance["id"])
        # A refreshed token only stands in for the same credential, so switching accounts never reuses it.
        if (
            refreshed is not None
            and refreshed.source == stored.source
            and refreshed.refresh_token == stored.refresh_token
            and is_antigravity_token_fresh(refreshed)
        ):
            return refreshed
        if is_antigravity_token_fresh(stored):
            return stored
        if not is_antigravity_refreshable(stored):
            raise _auth_expired(stored)
        try:
            payload = await ctx.http.request_json(
                "POST",
                GOOGLE_OAUTH_TOKEN_URL,
                {"Content-Type": "application/json"},
                {
                    "client_id": stored.client_id,
                    "client_secret": stored.client_secret,
                    "refresh_token": stored.refresh_token,
                    "grant_type": "refresh_token",
                },
            )
        except ServiceError as error:
            if error.code in TRANSIENT_CODES:
                raise
            raise _auth_expired(stored) from None
        access_token = string_at(payload, "access_token") if is_record(payload) else None
        expires_in = number_at(payload, "expires_in") if is_record(payload) else None
        if not access_token or expires_in is None:
            raise _auth_expired(stored)
        auth = replace(stored, access_token=access_token, expires_at=time.time() * 1000 + expires_in * 1000)
        self._refreshed[instance["id"]] = auth
        return auth
