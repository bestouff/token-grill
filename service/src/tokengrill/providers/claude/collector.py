"""Claude usage limits and local history."""

from tokengrill.core.errors import ServiceError
from tokengrill.core.types import ProviderInstance, ProviderSnapshot
from tokengrill.providers.base import CollectorContext, LimitsUpdate, collect_history, collect_limits
from tokengrill.providers.claude.history import claude_usage_event
from tokengrill.providers.claude.normalize import normalize_claude_usage
from tokengrill.providers.claude.renewal import ClaudeTokenLoader

USAGE_URL = "https://api.anthropic.com/api/oauth/usage"


class ClaudeCollector:
    def __init__(self) -> None:
        self._tokens = ClaudeTokenLoader()

    async def collect(
        self, instance: ProviderInstance, snapshot: ProviderSnapshot, ctx: CollectorContext
    ) -> ProviderSnapshot:
        result = snapshot
        if instance["liveUsageEnabled"]:
            result = await collect_limits(ctx, result, lambda: self._fetch_limits(instance, ctx))
        if instance["localHistoryEnabled"]:
            result = await collect_history(ctx, instance, result, claude_usage_event)
        return result

    async def _fetch_limits(self, instance: ProviderInstance, ctx: CollectorContext) -> LimitsUpdate:
        access_token = await self._tokens.load(instance, ctx)
        payload = await ctx.http.request_json(
            "GET", USAGE_URL, {"Accept": "application/json", "Authorization": f"Bearer {access_token}"}
        )
        windows = normalize_claude_usage(payload)
        if not windows:
            raise ServiceError("response-shape", "net.no-usage")
        return {"windows": windows}
