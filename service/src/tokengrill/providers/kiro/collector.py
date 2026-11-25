"""Kiro usage limits from the kiro-cli sign-in."""

import hashlib
import time
from dataclasses import dataclass, replace

from tokengrill.core.errors import TRANSIENT_CODES, ServiceError
from tokengrill.core.json_util import is_record, number_at, string_at
from tokengrill.core.paths import provider_paths
from tokengrill.core.types import ProviderInstance, ProviderSnapshot, empty_snapshot
from tokengrill.providers.base import CollectorContext, LimitsUpdate, collect_limits
from tokengrill.providers.kiro.auth import (
    KiroAuth,
    is_kiro_refreshable,
    is_kiro_token_fresh,
    kiro_database_stamp,
    read_kiro_auth,
)
from tokengrill.providers.kiro.endpoints import kiro_oidc_endpoint, kiro_usage_request_body, kiro_usage_url
from tokengrill.providers.kiro.normalize import KiroUsage, normalize_kiro_usage
from tokengrill.providers.kiro.usage_policy import KiroRejectedTokens, kiro_usage_error


def _auth_expired() -> ServiceError:
    return ServiceError("auth-expired", "kiro.auth-expired")


def _stored_fingerprint(path: str, auth: KiroAuth) -> str:
    """Identifies the credentials kiro-cli currently stores. Other tools may rewrite them at any time, so
    every cache is tied to this value."""
    material = "\n".join([path, auth.access_token, auth.refresh_token or "", auth.profile_arn or ""])
    return hashlib.sha256(material.encode()).hexdigest()


@dataclass(frozen=True)
class _Stored:
    stamp: str
    auth: KiroAuth
    fingerprint: str


class KiroCollector:
    def __init__(self) -> None:
        # Stored sign-ins, re-read only when the database changes on disk. A failed read is not cached.
        self._stored: dict[str, _Stored] = {}
        # Tokens refreshed here. kiro-cli's store is opened read-only, so a refreshed token stays valid
        # only while kiro-cli still holds the sign-in it came from.
        self._refreshed: dict[str, tuple[str, KiroAuth]] = {}
        self._rejected = KiroRejectedTokens()

    async def collect(
        self, instance: ProviderInstance, snapshot: ProviderSnapshot, ctx: CollectorContext
    ) -> ProviderSnapshot:
        if not instance["liveUsageEnabled"]:
            return snapshot
        try:
            update = await self._limits(instance, ctx)
        except ServiceError as error:
            # An account without Kiro usage says nothing about the previous account, so its numbers are
            # cleared instead of being shown as stale data.
            base = empty_snapshot(instance["id"]) if error.code == "unsupported-account" else snapshot
            failure = error

            async def rejected() -> LimitsUpdate:
                raise failure

            return await collect_limits(ctx, base, rejected)

        async def ready() -> LimitsUpdate:
            return {"plan": update.plan, "account": update.account, "windows": update.windows}

        return await collect_limits(ctx, snapshot, ready)

    async def _limits(self, instance: ProviderInstance, ctx: CollectorContext) -> KiroUsage:
        stored = await self._stored_auth(instance)
        known = None if ctx.manual else self._rejected.get(instance["id"], stored.fingerprint)
        if known is not None:
            raise known
        self._rejected.forget(instance["id"])
        try:
            return await self._fetch_limits(instance, ctx, stored.auth, stored.fingerprint)
        except ServiceError as error:
            self._rejected.remember(instance["id"], stored.fingerprint, error)
            raise

    async def _stored_auth(self, instance: ProviderInstance) -> _Stored:
        path = provider_paths(instance)["authFile"]
        stamp = await kiro_database_stamp(path)
        cached = self._stored.get(path)
        if cached is not None and cached.stamp == stamp:
            return cached
        auth = await read_kiro_auth(path)
        entry = _Stored(stamp, auth, _stored_fingerprint(path, auth))
        self._stored[path] = entry
        return entry

    async def _fetch_limits(
        self, instance: ProviderInstance, ctx: CollectorContext, stored: KiroAuth, fingerprint: str
    ) -> KiroUsage:
        auth = await self._fresh_auth(instance, ctx, stored, fingerprint)
        try:
            payload = await ctx.http.request_json(
                "POST",
                kiro_usage_url(auth.service_region),
                {
                    "Accept": "application/json",
                    "Authorization": f"Bearer {auth.access_token}",
                    "Content-Type": "application/x-amz-json-1.0",
                    "X-Amz-Target": "AmazonCodeWhispererService.GetUsageLimits",
                },
                kiro_usage_request_body(auth.profile_arn),
            )
        except ServiceError as error:
            raise kiro_usage_error(error) from None
        usage = normalize_kiro_usage(payload)
        if not usage.windows:
            raise ServiceError("response-shape", "net.no-usage")
        return usage

    async def _fresh_auth(
        self, instance: ProviderInstance, ctx: CollectorContext, stored: KiroAuth, fingerprint: str
    ) -> KiroAuth:
        refreshed = self._refreshed.get(instance["id"])
        if (
            refreshed is not None
            and refreshed[0] == fingerprint
            and refreshed[1].expires_at >= stored.expires_at
            and is_kiro_token_fresh(refreshed[1].expires_at)
        ):
            return refreshed[1]
        if is_kiro_token_fresh(stored.expires_at):
            return stored
        if not is_kiro_refreshable(stored):
            raise _auth_expired()
        try:
            payload = await ctx.http.request_json(
                "POST",
                kiro_oidc_endpoint(stored.region),
                {"Content-Type": "application/json"},
                {
                    "clientId": stored.client_id,
                    "clientSecret": stored.client_secret,
                    "grantType": "refresh_token",
                    "refreshToken": stored.refresh_token,
                },
            )
        except ServiceError as error:
            if error.code in TRANSIENT_CODES:
                raise
            raise _auth_expired() from None
        access_token = string_at(payload, "accessToken") if is_record(payload) else None
        expires_in = number_at(payload, "expiresIn") if is_record(payload) else None
        if not is_record(payload) or not access_token or expires_in is None:
            raise _auth_expired()
        refresh_token = string_at(payload, "refreshToken") or stored.refresh_token
        auth = replace(
            stored,
            access_token=access_token,
            refresh_token=refresh_token,
            expires_at=time.time() * 1000 + expires_in * 1000,
        )
        # Kept in memory only: the kiro-cli database is never written.
        self._refreshed[instance["id"]] = (fingerprint, auth)
        return auth
