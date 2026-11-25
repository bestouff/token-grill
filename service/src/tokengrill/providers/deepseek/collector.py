"""DeepSeek prepaid balance, shown as a meter against the last top-up."""

from tokengrill.core.balance_meter import balance_window, next_balance_reference
from tokengrill.core.types import ProviderInstance, ProviderSnapshot
from tokengrill.providers.base import CollectorContext, LimitsUpdate, collect_limits
from tokengrill.providers.deepseek.auth import load_deepseek_key
from tokengrill.providers.deepseek.normalize import normalize_deepseek_balance

BALANCE_URL = "https://api.deepseek.com/user/balance"


class DeepSeekCollector:
    async def collect(
        self, instance: ProviderInstance, snapshot: ProviderSnapshot, ctx: CollectorContext
    ) -> ProviderSnapshot:
        if not instance["liveUsageEnabled"]:
            return snapshot
        return await collect_limits(ctx, snapshot, lambda: self._fetch_balance(instance, ctx))

    async def _fetch_balance(self, instance: ProviderInstance, ctx: CollectorContext) -> LimitsUpdate:
        key = await load_deepseek_key(instance)
        payload = await ctx.http.request_json(
            "GET", BALANCE_URL, {"Accept": "application/json", "Authorization": f"Bearer {key}"}
        )
        balance = normalize_deepseek_balance(payload)
        reference = next_balance_reference(ctx.balances.get(instance["id"]), balance)
        ctx.balances.set(instance["id"], reference)
        await ctx.balances.flush()
        return {"balance": balance, "windows": [balance_window(balance, reference)]}
