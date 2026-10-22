import { marketSnapshot, partialMessage } from './_market.js';
// "Your Personal Risk" — Reality Check's original product.
// The key insight: top holders are NOT all equal. Liquidity pools, vesting
// contracts and multisigs CANNOT dump like a person. Only personal wallets
// can sell anytime. We classify each top wallet:
//   1. DexScreener pair match  -> 'liquidity' (the pool itself, locked by design)
//   2. eth_getCode has code    -> 'contract'  (vesting / multisig / other)
//   3. eth_getCode empty       -> 'personal'  (a human that CAN sell)
// Danger math runs ONLY on personal wallets. All logic stays server-side:
// users see their truth, never the formula.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Use POST' });
  const { contract, chain, positionUsd } = req.body || {};
  if (!contract || !chain) return res.status(400).json({ success: false, message: 'Contract and chain required' });
  const position = Number(positionUsd);
  if (!position || position <= 0) return res.status(400).json({ success: false, message: 'Enter your position size in USD' });

  let clean = (contract || '').trim();
  if (chain !== 'solana-mainnet' && !clean.startsWith('0x')) clean = '0x' + clean;
  const hex = clean.startsWith('0x') ? clean.slice(2) : clean;
  if (chain !== 'solana-mainnet' && (hex.length !== 40 || !/^[a-fA-F0-9]+$/.test(hex))) {
    return res.status(200).json({ success: false, message: 'Invalid contract address. Must be 42 characters (0x + 40 hex).' });
  }

  const key = process.env.COVALENT_KEY || '';
  const chainMap = {
    'eth-mainnet': 'eth-mainnet', 'bsc-mainnet': 'bsc-mainnet',
    'avalanche-mainnet': 'avalanche-mainnet', 'base-mainnet': 'base-mainnet',
    'polygon-mainnet': 'matic-mainnet', 'arbitrum-mainnet': 'arbitrum-mainnet'
  };
  const cChain = chainMap[chain] || chain;
  const explorers = {
    'eth-mainnet': `https://etherscan.io/token/${clean}`,
    'bsc-mainnet': `https://bscscan.com/token/${clean}`,
    'avalanche-mainnet': `https://snowtrace.io/token/${clean}`,
    'base-mainnet': `https://basescan.org/token/${clean}`,
    'polygon-mainnet': `https://polygonscan.com/token/${clean}`,
    'arbitrum-mainnet': `https://arbiscan.io/token/${clean}`
  };
  // Fallback RPC lists for contract-vs-person detection
  const RPCS = {
    'eth-mainnet': ['https://eth.llamarpc.com', 'https://ethereum.publicnode.com', 'https://rpc.ankr.com/eth', 'https://cloudflare-eth.com'],
    'bsc-mainnet': ['https://binance.llamarpc.com', 'https://bsc.publicnode.com', 'https://rpc.ankr.com/bsc'],
    'avalanche-mainnet': ['https://avalanche.llamarpc.com', 'https://avalanche-c-chain.publicnode.com', 'https://rpc.ankr.com/avalanche'],
    'base-mainnet': ['https://base.llamarpc.com', 'https://base.publicnode.com', 'https://rpc.ankr.com/base'],
    'polygon-mainnet': ['https://polygon.llamarpc.com', 'https://polygon-bor.publicnode.com', 'https://rpc.ankr.com/polygon'],
    'arbitrum-mainnet': ['https://arbitrum.llamarpc.com', 'https://arbitrum-one.publicnode.com', 'https://rpc.ankr.com/arbitrum']
  };

  const getCode = async (rpc, address) => {
    try {
      const r = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getCode', params: [address, 'latest'], id: 1 }),
        signal: AbortSignal.timeout(10000)
      });
      const j = await r.json();
      if (j.error || typeof j.result !== 'string') return null;
      return j.result !== '0x' && j.result.length > 2;
    } catch { return null; }
  };

  try {
    const url = `https://api.covalenthq.com/v1/${cChain}/tokens/${clean}/token_holders_v2/`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    if (!j.data || !j.data.items || j.data.items.length === 0) {
      const market = await marketSnapshot(clean, chain);
      return res.status(200).json({
        success: false,
        partial: true,
        message: market ? partialMessage('none') : 'No holder data and no live market pairs found for this contract on the selected chain. Double-check the address and chain, or open the explorer.',
        market,
        explorer: explorers[chain] || '#'
      });
    }

    const items = j.data.items;
    const first = items[0];
    const total = BigInt(first.total_supply || '0');
    const name = first.contract_name || 'Token';
    const symbol = first.contract_ticker_symbol || '';

    const pctOf = (bal) => total > 0n ? (Number(BigInt(bal || '0') * 10000n / total) / 100) : 0;
    const f1 = (n) => n.toFixed(2);
    const sum = (arr) => arr.reduce((s, x) => s + x, 0);

    // ----- Step 1: DexScreener — find this token's real liquidity-pool addresses -----
    let pairAddrs = new Set();
    try {
      const ds = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${clean}`, { signal: AbortSignal.timeout(10000) });
      const dsj = await ds.json();
      for (const p of (dsj.pairs || [])) {
        if (p.pairAddress) pairAddrs.add(p.pairAddress.toLowerCase());
      }
    } catch { /* DexScreener optional — continue without it */ }

    // ----- Step 2: classify top 15 wallets -----
    const N = 15;
    const topN = items.slice(0, N).map(h => ({ address: h.address, pct: pctOf(h.balance) }));
    const kinds = new Array(N).fill(null);
    const BURN = new Set(['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead']);
    // burned first (no RPC needed)
    const needRpc = [];
    topN.forEach((h, i) => {
      const a = h.address.toLowerCase();
      if (BURN.has(a)) kinds[i] = 'burned';
      else if (pairAddrs.has(a)) kinds[i] = 'liquidity';
      else needRpc.push(i);
    });
    // then contract-vs-person via RPC fallbacks, only for the rest
    const rpcs = RPCS[chain] || [];
    let pending = [...needRpc];
    for (const rpc of rpcs) {
      if (!pending.length) break;
      const results = await Promise.all(pending.map(async (idx) => [idx, await getCode(rpc, topN[idx].address)]));
      const still = [];
      for (const [idx, code] of results) {
        if (code === null) still.push(idx);
        else kinds[idx] = code ? 'contract' : 'personal';
      }
      pending = still;
    }
    for (const idx of pending) kinds[idx] = 'unknown';

    const wallets = topN.map((h, i) => ({ address: h.address, pct: f1(h.pct), kind: kinds[i] }));
    const lockedKinds = new Set(['liquidity', 'contract', 'burned']);
    const allUnknown = wallets.every(w => w.kind === 'unknown');
    const personal = allUnknown
      ? wallets.map(w => ({ ...w, kind: 'personal' }))
      : wallets.filter(w => !lockedKinds.has(w.kind));
    const locked = allUnknown ? [] : wallets.filter(w => lockedKinds.has(w.kind));

    const pTop1 = personal.length ? Number(personal[0].pct) : 0;
    const pTop3 = sum(personal.slice(0, 3).map(w => Number(w.pct)));
    const pTop10 = sum(personal.slice(0, 10).map(w => Number(w.pct)));
    const lockedPct = sum(locked.map(w => Number(w.pct)));
    const liqPct = sum(locked.filter(w => w.kind === 'liquidity').map(w => Number(w.pct)));
    const allTop10 = sum(wallets.slice(0, 10).map(w => Number(w.pct)));

    // ----- Reality Score (0-100): danger = wallets that CAN sell -----
    let score = 100;
    score -= pTop10 * 0.9;
    if (pTop1 > 15) score -= 15; else if (pTop1 > 8) score -= 8;
    if (pTop3 > 40) score -= 10;
    score = Math.max(0, Math.min(100, Math.round(score)));

    // ----- Green flags -----
    const green = [];
    if (!allUnknown && lockedPct >= 15) {
      const liqNote = liqPct > 0 ? ` — ${f1(liqPct)}% of it verified liquidity pools` : '';
      green.push(`🔒 ${f1(lockedPct)}% of the biggest wallets are locked by design (liquidity pools, vesting or team contracts)${liqNote} — they physically cannot dump on you. That is exactly how healthy projects look.`);
    }
    if (pTop1 <= 5) green.push(`No single person can move this — the biggest sellable wallet holds just ${f1(pTop1)}%.`);
    if (pTop3 <= 15 && personal.length >= 3) green.push(`No whale cartel — the top 3 personal wallets together hold only ${f1(pTop3)}%.`);

    // ----- Red flags (personal wallets only) -----
    const red = [];
    if (pTop1 > 15) red.push(`One personal wallet holds ${f1(pTop1)}% and can sell every token tomorrow — no lock, no contract stopping it.`);
    else if (pTop1 > 8) red.push(`A large personal wallet — one holder sits on ${f1(pTop1)}% and can sell anytime.`);
    if (pTop3 > 40) red.push(`Three personal wallets control ${f1(pTop3)}% — a coordinated dump would be devastating.`);
    if (pTop10 > 50) red.push(`Over half the supply (${f1(pTop10)}%) sits in personal wallets that can sell at any moment.`);

    // ----- Dump scenarios: ONLY wallets that can actually sell -----
    const scenarioOut = (dumpedPct) => {
      const drop = Math.min(90, dumpedPct * 2);
      return {
        dumpedPct: +dumpedPct.toFixed(2),
        priceDrop: +drop.toFixed(1),
        yourValue: Math.max(0, Math.round(position * (1 - drop / 100)))
      };
    };
    const scenarios = [
      { name: 'Biggest personal wallet sells half', ...scenarioOut(pTop1 / 2) },
      { name: 'Top 3 personal wallets sell half', ...scenarioOut(pTop3 / 2) },
      { name: 'Top 10 personal wallets panic-sell a quarter', ...scenarioOut(pTop10 / 4) }
    ];

    // ----- Balanced verdict: reality, not fear -----
    const healthWord = score >= 80 ? 'genuinely healthy' : score >= 55 ? 'a mixed bag' : score >= 35 ? 'risky' : 'dangerous';
    let verdict = `Overall, this token looks ${healthWord} — Reality Score ${score}/100. `;
    if (!allUnknown) {
      verdict += `Here is the reality most tools will not tell you: ${f1(lockedPct)}% of the biggest wallets are locked by design (liquidity pools, vesting or team contracts) — they cannot dump on you, and that is normal for every real project. The real question is the ${f1(pTop10)}% sitting in personal wallets that CAN sell. `;
    }
    if (green.length) verdict += `What's good: ${green.join(' ')} `;
    if (red.length) verdict += `What's dangerous: ${red.join(' ')}`;
    else verdict += `No major red flags in the sellable supply — but staying alert is still free.`;

    const kindLabel = { liquidity: '🔒 Liquidity pool — locked by design', contract: '🔒 Smart contract — cannot dump like a person', burned: '🔥 Burned — gone forever', personal: '👤 Personal wallet — can sell anytime', unknown: '❓ Unverified' };
    res.status(200).json({
      success: true,
      name, symbol,
      score, healthWord,
      position: Math.round(position),
      sellableTop1: f1(pTop1) + '%',
      sellableTop3: f1(pTop3) + '%',
      sellableTop10: f1(pTop10) + '%',
      lockedPct: f1(lockedPct) + '%',
      allTop10: f1(allTop10) + '%',
      legacyMode: allUnknown,
      wallets: wallets.map(w => ({ address: w.address, pct: w.pct, kind: w.kind, label: kindLabel[w.kind] || w.kind })),
      green, red, scenarios, verdict,
      methodNote: 'Wallet types are checked for real: liquidity-pool addresses are verified against live DEX data, other contracts are detected on-chain. Locked wallets cannot dump like a person, so danger math runs only on personal wallets. Scenario figures are illustrative — they assume each 1% of supply sold quickly moves price ~2% (capped at 90% drop). Not predictions.',
      riskNote: 'Public on-chain data only. Not financial advice. Never invest more than you can afford to lose.',
      explorer: explorers[chain] || '#'
    });
  } catch (e) {
    console.error('personal-risk failed', e && e.message);
    const market = await marketSnapshot(clean, chain);
    res.status(200).json({
      success: false,
      partial: true,
      message: market ? partialMessage('error') : 'Could not load holder data right now. Try again in a minute or open the explorer.',
      market,
      explorer: explorers[chain] || '#'
    });
  }
}
