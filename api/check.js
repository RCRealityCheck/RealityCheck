import { marketSnapshot, partialMessage } from './_market.js';
import { solDeep } from './_sol-deep.js';
import { rateLimited, LIMIT_MSG } from './_checkout.js';

// Free holder check. EVM: Covalent holder list, ranked by balance here (the provider does not guarantee order).
// Solana: largest token accounts from the Solana network, grouped by owner (same logic as the Deep Report).
// Never invents numbers: if the ranking can't be trusted, we fall back to live market data and say so.
const SOL_RPC_LIST = [process.env.SOLANA_RPC_URL, 'https://api.mainnet-beta.solana.com', 'https://solana.publicnode.com'].filter(Boolean);
const SOL_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const fmtPct = (x, pos = x > 0) => (pos && x < 0.01) ? '<0.01%' : x.toFixed(2) + '%';
const verdictFor = (top10) => top10 > 70 ? 'High concentration' : top10 > 40 ? 'Elevated concentration' : 'Relatively distributed';
const impactFor = (top10) => top10 > 50
  ? 'A small number of wallets control a large share of the supply. If they sell, the price can drop sharply for everyone who bought later.'
  : 'Supply is more spread out among holders. Still check if the biggest wallets can sell immediately.';
const RISK = 'This is public on-chain data only. Always verify yourself. Not financial advice.';

async function solanaCheck(req, res, mint) {
  const explorer = SOL_MINT.test(mint) ? `https://solscan.io/token/${mint}#holders` : '#';
  if (!SOL_MINT.test(mint)) return res.status(200).json({ success: false, message: 'That does not look like a Solana mint address. Double-check it and try again.' });
  if (await rateLimited(req, 'freesol', 20, 3000)) return res.status(200).json({ success: false, rateLimited: true, message: LIMIT_MSG });
  let supply = null;
  const rpc = async (method, params) => {
    for (const u of SOL_RPC_LIST) {
      try {
        const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12000) });
        const j = await r.json();
        if (!j.error && j.result !== undefined && j.result !== null) { if (method === 'getTokenSupply' && params[0] === mint) supply = j.result; return j.result; }
      } catch {}
    }
    return null;
  };
  const [sd, market] = await Promise.all([solDeep(mint, rpc, []).catch(() => null), marketSnapshot(mint, 'solana-mainnet')]);
  if (!sd || !sd.holders.length) {
    return res.status(200).json({ success: false, partial: true, market, explorer,
      message: market ? 'The Solana network did not return a holder list for this token right now. Here is what we could verify from live market data instead.'
        : 'No holder data and no live market pairs found for this mint on Solana. Double-check the address, or open the explorer.' });
  }
  const top = sd.holders.slice(0, 10);
  const top10 = top.reduce((s, h) => s + h.pct, 0), top3 = top.slice(0, 3).reduce((s, h) => s + h.pct, 0);
  const d = sd.distribution || {};
  const parts = [d.poolsPct ? `${d.poolsPct}% in liquidity pools` : '', d.burnedPct ? `${d.burnedPct}% burned` : '', d.lockedPct ? `${d.lockedPct}% locked` : '', d.programPct ? `${d.programPct}% in program accounts` : '', d.privatePct ? `${d.privatePct}% in private wallets (could include exchanges)` : ''].filter(Boolean);
  const ui = Number(supply?.value?.uiAmountString || 0);
  return res.status(200).json({
    success: true,
    name: market?.name || 'Token',
    symbol: market?.symbol || '',
    verdict: verdictFor(top10),
    concentration: fmtPct(top10),
    top1: fmtPct(top[0].pct),
    top3: fmtPct(top3),
    type: 'SPL Token (Solana)',
    totalSupply: ui ? ui.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—',
    retailImpact: impactFor(top10),
    watch: (parts.length ? `Of the largest holders: ${parts.join(', ')}. ` : '') + 'Pools and burned tokens are not a selling risk; large private wallets are.',
    riskNote: RISK,
    topHolders: top.slice(0, 5).map(h => ({ address: h.address, percentage: fmtPct(h.pct), label: h.label })),
    note: `Data from the Solana network: largest token accounts grouped by owner${d.coveredPct != null ? `, covering ${d.coveredPct}% of supply` : ''}. Free forever.`,
    explorer
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Use POST' });
  const { contract, chain } = req.body || {};
  if (!contract || !chain) return res.status(400).json({ success: false, message: 'Contract and chain required' });
  if (chain === 'solana-mainnet') return solanaCheck(req, res, String(contract).trim());

  let clean = String(contract).trim();
  if (!clean.startsWith('0x')) clean = '0x' + clean;
  const hex = clean.slice(2);
  if (hex.length !== 40 || !/^[a-fA-F0-9]+$/.test(hex)) {
    return res.status(200).json({ success: false, message: 'Invalid contract address. Must be 42 characters (0x + 40 hex).' });
  }

  const key = process.env.COVALENT_KEY || '';
  const chainMap = {
    'eth-mainnet': 'eth-mainnet',
    'bsc-mainnet': 'bsc-mainnet',
    'avalanche-mainnet': 'avalanche-mainnet',
    'base-mainnet': 'base-mainnet',
    'polygon-mainnet': 'matic-mainnet',
    'arbitrum-mainnet': 'arbitrum-mainnet'
  };
  if (!chainMap[chain]) return res.status(200).json({ success: false, message: 'Unsupported chain.' });
  const cChain = chainMap[chain];
  const explorers = {
    'eth-mainnet': `https://etherscan.io/token/${clean}`,
    'bsc-mainnet': `https://bscscan.com/token/${clean}`,
    'avalanche-mainnet': `https://snowtrace.io/token/${clean}`,
    'base-mainnet': `https://basescan.org/token/${clean}`,
    'polygon-mainnet': `https://polygonscan.com/token/${clean}`,
    'arbitrum-mainnet': `https://arbiscan.io/token/${clean}`
  };
  const partial = async (message) => {
    const market = await marketSnapshot(clean, chain);
    return res.status(200).json({ success: false, partial: true, message: market ? message : 'No holder data and no live market pairs found for this contract on the selected chain. Double-check the address and chain, or open the explorer.', market, explorer: explorers[chain] || '#' });
  };

  try {
    const url = `https://api.covalenthq.com/v1/${cChain}/tokens/${clean}/token_holders_v2/?page-size=1000`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    const raw = (j?.data?.items || []).filter(h => h && h.address);
    if (!raw.length) return partial(partialMessage('none'));
    const bal = (h) => { try { return BigInt(h.balance || '0'); } catch { return 0n; } };
    // The provider's order is not guaranteed. If the page came back unranked AND more pages exist,
    // the true biggest wallets may be on a page we did not read, so we refuse to guess.
    const ranked = raw.every((h, i) => i === 0 || bal(raw[i - 1]) >= bal(h));
    // "Partial" = provider says more pages exist, reports more holders than it sent, or sent a full page (1000).
    const pg = j?.data?.pagination || {};
    const hasMore = !!pg.has_more || Number(pg.total_count || 0) > raw.length || raw.length >= 1000;
    if (!ranked && hasMore) return partial('Our holder data provider returned an unranked, partial holder list for this token, so we will not guess who the biggest wallets are. Here is what we could verify from live market data instead.');
    const items = raw.slice().sort((a, b) => { const x = bal(a), y = bal(b); return x > y ? -1 : x < y ? 1 : 0; });
    const first = items[0];
    let total = 0n; try { total = BigInt(first.total_supply || '0'); } catch {}
    const decimals = Number.isInteger(first.contract_decimals) ? first.contract_decimals : 18;
    const pctOf = (b) => total > 0n ? Number(b * 1000000n / total) / 10000 : 0;
    const top = items.slice(0, 10).map(h => ({ address: h.address, pct: pctOf(bal(h)), pos: bal(h) > 0n }));
    const top10 = top.reduce((s, h) => s + h.pct, 0), top3 = top.slice(0, 3).reduce((s, h) => s + h.pct, 0);
    // Sanity: no supply, or holders adding up to more than the supply, means the data is broken.
    if (total <= 0n || top10 > 100.01) return partial(partialMessage('error'));
    res.status(200).json({
      success: true,
      name: first.contract_name || 'Token',
      symbol: first.contract_ticker_symbol || '',
      verdict: verdictFor(top10),
      concentration: fmtPct(top10),
      top1: fmtPct(top[0].pct, top[0].pos),
      top3: fmtPct(top3, top3 > 0 || top[0].pos),
      type: 'ERC-20',
      totalSupply: (Number(total) / 10 ** decimals).toLocaleString(undefined, { maximumFractionDigits: 0 }),
      retailImpact: impactFor(top10),
      watch: 'Ignore known exchange and liquidity pool wallets when judging real risk. Look for team or deployer wallets that are unlocked.',
      riskNote: RISK,
      topHolders: top.slice(0, 5).map(h => ({ address: h.address, percentage: fmtPct(h.pct, h.pos) })),
      note: 'Data from Covalent, ranked by balance. Free forever.',
      explorer: explorers[chain] || '#'
    });
  } catch (e) {
    return partial(partialMessage('error'));
  }
}
