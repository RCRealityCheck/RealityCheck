// Manual-transfer verification: someone copied the published address and sent USDC
// from any wallet or exchange, then pasted the transaction ID.
// Solana: confirmed/finalized, USDC mint, >= price to the RC wallet, within maxAgeSec.
// EVM: same chains/tokens and log-based check as the existing Deep Report flow.
// One-time use: enforced only when KV_REST_API_URL + KV_REST_API_TOKEN (Upstash / Vercel KV) are set.
export const RC_SOL = 'DYkdqhQNLQyikuPaNHJczSwcGPYVuGuBafqzXm8wqAvk';
export const RC_EVM = '0xa214852e96a6d263a14DdA188Fd90395a733b5eA';
const USDC_SOL_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_RPCS = [process.env.SOLANA_RPC_URL, 'https://api.mainnet-beta.solana.com', 'https://solana.publicnode.com'].filter(Boolean);
const EVM_CHAINS = {
  ethereum: { label: 'Ethereum', usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', rpcs: ['https://eth.llamarpc.com', 'https://ethereum.publicnode.com', 'https://rpc.ankr.com/eth'] },
  base:     { label: 'Base', usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', rpcs: ['https://base.llamarpc.com', 'https://base.publicnode.com', 'https://rpc.ankr.com/base'] },
  bnb:      { label: 'BNB Chain', usdc: '0x8AC76a085641D1D8F3b5C83d63d9865a6f07D', rpcs: ['https://binance.llamarpc.com', 'https://bsc.publicnode.com', 'https://rpc.ankr.com/bsc'] },
  polygon:  { label: 'Polygon', usdc: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', rpcs: ['https://polygon.llamarpc.com', 'https://polygon-bor.publicnode.com', 'https://rpc.ankr.com/polygon'] },
  arbitrum: { label: 'Arbitrum', usdc: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', rpcs: ['https://arbitrum.llamarpc.com', 'https://arbitrum-one.publicnode.com', 'https://rpc.ankr.com/arbitrum'] }
};

export const MSG = {
  notFound: "We can't see that transaction yet. If you just sent it, wait a minute and try again. Make sure you pasted the FULL transaction ID.",
  failed: 'That transaction failed on-chain, so no payment was made.',
  wrongAddress: "That transaction didn't send USDC to the Reality Check wallet. Double-check you sent to the address shown here.",
  wrongAmount: (p) => `That transaction sent less than ${p} USDC to Reality Check. The report costs ${p} USDC.`,
  tooOld: (sec) => `That payment is older than ${sec >= 3600 ? Math.round(sec / 3600) + ' hours' : Math.round(sec / 60) + ' minutes'}, so it can no longer unlock a report. Please send a fresh payment.`,
  used: 'That transaction was already used to unlock a report. Each payment unlocks one report.',
  badFormat: "That doesn't look like a complete transaction ID. Copy the FULL ID from your wallet or exchange (Solana IDs are long letters and numbers; EVM IDs start with 0x).",
  busy: 'The blockchain is busy right now. Please try again in a minute. Nothing was charged twice.'
};

async function post(url, method, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
  return r.json();
}

async function verifySol(sig, price, maxAge) {
  let tx = null, reached = false;
  for (const u of SOL_RPCS) {
    try { const j = await post(u, 'getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]); if (!j.error) { reached = true; if (j.result) { tx = j.result; break; } } } catch {}
  }
  if (!tx) return { status: reached ? 'invalid' : 'busy', reason: reached ? MSG.notFound : MSG.busy, pending: reached };
  if (tx.meta && tx.meta.err) return { status: 'invalid', reason: MSG.failed };
  const now = Math.floor(Date.now() / 1000);
  if (!tx.blockTime) return { status: 'invalid', reason: MSG.notFound, pending: true };
  if (now - tx.blockTime > maxAge) return { status: 'invalid', reason: MSG.tooOld(maxAge) };
  const sum = (l, own) => (l || []).reduce((s, b) => (b.mint === USDC_SOL_MINT && (!own || b.owner === RC_SOL)) ? s + BigInt(b.uiTokenAmount?.amount || '0') : s, 0n);
  const received = sum(tx.meta?.postTokenBalances, true) - sum(tx.meta?.preTokenBalances, true);
  if (received <= 0n) return { status: 'invalid', reason: MSG.wrongAddress };
  if (received < BigInt(Math.round(price * 1e6))) return { status: 'invalid', reason: MSG.wrongAmount(price) };
  return { status: 'ok', chain: 'Solana', amount: Number(received) / 1e6 };
}

async function evmRpc(cfg, method, params) {
  for (const u of cfg.rpcs) {
    try { const j = await post(u, method, params); if (!j.error && j.result !== undefined && j.result !== null) return j.result; } catch {}
  }
  return null;
}

async function verifyEvm(cfg, sig, price, maxAge) {
  const receipt = await evmRpc(cfg, 'eth_getTransactionReceipt', [sig]);
  if (!receipt) return { status: 'not-found' };
  if (receipt.status !== '0x1') return { status: 'invalid', reason: MSG.failed };
  const block = await evmRpc(cfg, 'eth_getBlockByNumber', [receipt.blockNumber, false]);
  const bt = block?.timestamp ? parseInt(block.timestamp, 16) : 0;
  if (!bt) return { status: 'invalid', reason: MSG.busy };
  if (Math.floor(Date.now() / 1000) - bt > maxAge) return { status: 'invalid', reason: MSG.tooOld(maxAge) };
  let decimals = 6;
  try { const d = await evmRpc(cfg, 'eth_call', [{ to: cfg.usdc, data: '0x313ce567' }, 'latest']); if (d && d !== '0x') decimals = parseInt(d, 16); } catch {}
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const to = '0x000000000000000000000000' + RC_EVM.slice(2).toLowerCase();
  let total = 0n;
  for (const log of (receipt.logs || [])) {
    if ((log.address || '').toLowerCase() !== cfg.usdc.toLowerCase()) continue;
    const t = log.topics || [];
    if ((t[0] || '').toLowerCase() !== TRANSFER || (t[2] || '').toLowerCase() !== to) continue;
    try { total += BigInt(log.data); } catch {}
  }
  if (total === 0n) return { status: 'invalid', reason: MSG.wrongAddress };
  const unit = 10n ** BigInt(decimals);
  if (total * 100n < BigInt(Math.round(price * 100)) * unit) return { status: 'invalid', reason: MSG.wrongAmount(price) };
  return { status: 'ok', chain: cfg.label, amount: Number(total) / Number(unit) };
}

export async function verifyManualTx(raw, { price = 1, maxAgeSec = manualMaxAge() } = {}) {
  const sig = String(raw || '').trim();
  try {
    if (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(sig)) return await verifySol(sig, price, maxAgeSec);
    if (/^0x[a-fA-F0-9]{64}$/.test(sig)) {
      for (const k of Object.keys(EVM_CHAINS)) {
        const r = await verifyEvm(EVM_CHAINS[k], sig.toLowerCase(), price, maxAgeSec);
        if (r.status !== 'not-found') return r;
      }
      return { status: 'invalid', reason: MSG.notFound, pending: true };
    }
    return { status: 'invalid', reason: MSG.badFormat };
  } catch { return { status: 'invalid', reason: MSG.busy }; }
}

// Without a durable store, keep the old 30-minute window so a tx cannot be replayed for a whole day.
export const manualMaxAge = () => (oneTimeEnforced() ? 86400 : 1800);
export function oneTimeEnforced() { return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN); }

// Atomically mark a tx as used. Returns { enforced, ok }.
export async function claimTx(raw) {
  if (!oneTimeEnforced()) return { enforced: false, ok: true };
  const id = String(raw).trim(); const key = /^0x/i.test(id) ? id.toLowerCase() : id;
  try {
    const r = await fetch(`${process.env.KV_REST_API_URL}/set/rc:paidtx:${encodeURIComponent(key)}/used/NX`, { headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }, signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    return { enforced: true, ok: j.result === 'OK' };
  } catch { return { enforced: true, ok: false, error: true }; }
}

export async function isTxUsed(raw) {
  if (!oneTimeEnforced()) return false;
  const id = String(raw).trim(); const key = /^0x/i.test(id) ? id.toLowerCase() : id;
  try {
    const r = await fetch(`${process.env.KV_REST_API_URL}/get/rc:paidtx:${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }, signal: AbortSignal.timeout(8000) });
    const j = await r.json(); return j.result != null;
  } catch { return false; }
}
