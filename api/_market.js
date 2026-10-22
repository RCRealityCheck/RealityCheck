// Shared fallback: real market data from DexScreener when holder data is missing.
// Returns null when DexScreener has nothing — never invents numbers.
const DS_CHAIN = { 'eth-mainnet': 'ethereum', 'bsc-mainnet': 'bsc', 'avalanche-mainnet': 'avalanche', 'base-mainnet': 'base', 'polygon-mainnet': 'polygon', 'arbitrum-mainnet': 'arbitrum' };
export async function marketSnapshot(address, chain) {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    const want = DS_CHAIN[chain];
    const pairs = (j.pairs || []).filter(p => !want || p.chainId === want);
    if (!pairs.length) return null;
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const top = pairs[0];
    const base = (top.baseToken?.address || '').toLowerCase() === address.toLowerCase() ? top.baseToken : top.quoteToken;
    return {
      name: base?.name || null,
      symbol: base?.symbol || null,
      priceUsd: base === top.baseToken && top.priceUsd ? Number(top.priceUsd) : null,
      liquidityUsd: pairs.reduce((s, p) => s + (p.liquidity?.usd || 0), 0) || null,
      volume24hUsd: pairs.reduce((s, p) => s + (p.volume?.h24 || 0), 0) || null,
      fdvUsd: top.fdv || null,
      pairCount: pairs.length,
      topDex: top.dexId || null,
      url: top.url || null,
      source: 'DexScreener'
    };
  } catch { return null; }
}
export function partialMessage(kind) {
  return kind === 'error'
    ? 'Holder data is temporarily unavailable from our data provider. Here is what we could verify from live market data — try the full report again in a minute.'
    : 'Our holder data provider has no holder list for this contract on this chain yet (very new tokens, bridged tokens and native coins often are not indexed). Here is what we could verify from live market data instead.';
}
