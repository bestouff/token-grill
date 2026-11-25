"""GitHub Copilot usage limits."""

from tokengrill.core.types import ProviderInstance, ProviderSnapshot
from tokengrill.providers.base import CollectorContext, LimitsUpdate, collect_limits
from tokengrill.providers.copilot.auth import load_copilot_token
from tokengrill.providers.copilot.normalize import normalize_copilot_usage

# The usage counters GitHub's own Copilot settings page shows.
USAGE_URL = "https://api.github.com/copilot_internal/user"


class CopilotCollector:
    async def collect(
        self, instance: ProviderInstance, snapshot: ProviderSnapshot, ctx: CollectorContext
    ) -> ProviderSnapshot:
        if not instance["liveUsageEnabled"]:
            return snapshot
        return await collect_limits(ctx, snapshot, lambda: self._fetch_limits(instance, ctx))

    async def _fetch_limits(self, instance: ProviderInstance, ctx: CollectorContext) -> LimitsUpdate:
        token = await load_copilot_token(instance)
        payload = await ctx.http.request_json(
            "GET", USAGE_URL, {"Accept": "application/json", "Authorization": f"token {token}"}
        )
        usage = normalize_copilot_usage(payload)
        return {"windows": usage["windows"], "plan": usage["plan"]}
