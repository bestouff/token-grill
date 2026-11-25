"""OpenCode Go usage limits."""

from tokengrill.core.errors import ServiceError
from tokengrill.core.types import ProviderInstance, ProviderSnapshot
from tokengrill.providers.base import CollectorContext, LimitsUpdate, collect_limits
from tokengrill.providers.opencode_go.auth import load_open_code_go_key
from tokengrill.providers.opencode_go.normalize import normalize_open_code_go_usage

USAGE_URL = "https://opencode.ai/zen/go/v1/usage"


class OpenCodeGoCollector:
    async def collect(
        self, instance: ProviderInstance, snapshot: ProviderSnapshot, ctx: CollectorContext
    ) -> ProviderSnapshot:
        if not instance["liveUsageEnabled"]:
            return snapshot
        return await collect_limits(ctx, snapshot, lambda: self._fetch_limits(ctx))

    async def _fetch_limits(self, ctx: CollectorContext) -> LimitsUpdate:
        key = await load_open_code_go_key()
        try:
            payload = await ctx.http.request_json(
                "GET", USAGE_URL, {"Accept": "application/json", "Authorization": f"Bearer {key}"}
            )
        except ServiceError as error:
            # A valid Zen key without a Go subscription is refused with 403.
            if error.params.get("status") == "403":
                raise ServiceError("unsupported-account", "opencode-go.no-subscription") from None
            raise
        windows = normalize_open_code_go_usage(payload)
        if not windows:
            raise ServiceError("response-shape", "net.no-usage")
        return {"windows": windows}
