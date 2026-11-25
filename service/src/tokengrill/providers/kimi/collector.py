"""Kimi Code usage limits."""

from tokengrill.core.errors import ServiceError
from tokengrill.core.types import ProviderInstance, ProviderSnapshot
from tokengrill.providers.base import CollectorContext, LimitsUpdate, collect_limits
from tokengrill.providers.kimi.auth import load_kimi_auth
from tokengrill.providers.kimi.normalize import normalize_kimi_usage


class KimiCollector:
    async def collect(
        self, instance: ProviderInstance, snapshot: ProviderSnapshot, ctx: CollectorContext
    ) -> ProviderSnapshot:
        if not instance["liveUsageEnabled"]:
            return snapshot
        return await collect_limits(ctx, snapshot, lambda: self._fetch_limits(instance, ctx))

    async def _fetch_limits(self, instance: ProviderInstance, ctx: CollectorContext) -> LimitsUpdate:
        auth = await load_kimi_auth(instance)
        payload = await ctx.http.request_json(
            "GET",
            f"https://{auth['host']}/coding/v1/usages",
            {"Accept": "application/json", "Authorization": f"Bearer {auth['token']}"},
        )
        windows = normalize_kimi_usage(payload)
        if not windows:
            raise ServiceError("response-shape", "net.no-usage")
        return {"windows": windows}
