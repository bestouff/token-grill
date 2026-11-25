"""Codex usage limits, reset credits and local history."""

from tokengrill.core.errors import ServiceError
from tokengrill.core.types import LimitResetCreditSummary, ProviderInstance, ProviderSnapshot
from tokengrill.providers.base import CollectorContext, LimitsUpdate, collect_history, collect_limits
from tokengrill.providers.codex.auth import load_codex_access_token
from tokengrill.providers.codex.history import codex_usage_event
from tokengrill.providers.codex.normalize import normalize_codex_usage
from tokengrill.providers.codex.reset_credits import normalize_reset_credits

USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"


def _headers(access_token: str) -> dict[str, str]:
    return {"Accept": "application/json", "Authorization": f"Bearer {access_token}"}


class CodexCollector:
    async def collect(
        self, instance: ProviderInstance, snapshot: ProviderSnapshot, ctx: CollectorContext
    ) -> ProviderSnapshot:
        result = snapshot
        if instance["liveUsageEnabled"]:
            result = await self._collect_live(instance, result, ctx)
        if instance["localHistoryEnabled"]:
            result = await collect_history(ctx, instance, result, codex_usage_event)
        return result

    async def _collect_live(
        self, instance: ProviderInstance, snapshot: ProviderSnapshot, ctx: CollectorContext
    ) -> ProviderSnapshot:
        tokens: list[str] = []

        async def fetch() -> LimitsUpdate:
            access_token = await load_codex_access_token(instance)
            usage = normalize_codex_usage(await ctx.http.request_json("GET", USAGE_URL, _headers(access_token)))
            if not usage["windows"]:
                raise ServiceError("response-shape", "net.no-usage")
            tokens.append(access_token)
            return {"plan": usage["plan"], "windows": usage["windows"]}

        ready = await collect_limits(ctx, snapshot, fetch)
        if not tokens:
            return ready
        return {**ready, "resetCredits": await self._reset_credits(tokens[0], ctx, snapshot["resetCredits"])}

    async def _reset_credits(
        self, access_token: str, ctx: CollectorContext, cached: LimitResetCreditSummary | None
    ) -> LimitResetCreditSummary | None:
        """Optional: when they cannot be fetched, the last known list stays visible, marked stale."""
        ctx.report_phase("fetching-reset-credits")
        try:
            summary = normalize_reset_credits(
                await ctx.http.request_json("GET", RESET_CREDITS_URL, _headers(access_token))
            )
            if summary is None:
                raise ServiceError("response-shape", "codex.no-reset-credits")
        except ServiceError as error:
            ctx.report_source("reset-credits", "failed")
            return None if cached is None else {**cached, "stale": True, "error": error.info()}
        ctx.report_source("reset-credits", "success")
        return summary
