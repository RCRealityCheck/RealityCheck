// RULE (A J): every amount used for matching is the USDC actually CREDITED to our receiving address in the tx —
// Solana: net change of OUR USDC token balance (post - pre, owner = RC wallet); EVM: sum of USDC Transfer logs whose
// recipient is our address. Never the sender's debited amount.
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
  ethereum: { label: 'Ethereum', usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', confirmations: 3, decimals: 6, rpcs: ['https://ethereum.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth'] },
  base:     { label: 'Base', usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', confirmations: 20, decimals: 6, rpcs: ['https://base.publicnode.com', 'https://mainnet.base.org', 'https://base.drpc.org', 'https://1rpc.io/base'] },
  bnb:      { label: 'BNB Chain', usdc: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', confirmations: 15, decimals: 18, rpcs: ['https://bsc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://1rpc.io/bnb'] },
  polygon:  { label: 'Polygon', usdc: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', confirmations: 20, decimals: 6, rpcs: ['https://polygon-bor.publicnode.com', 'https://polygon.drpc.org', 'https://1rpc.io/matic'] },
  arbitrum: { label: 'Arbitrum', usdc: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', confirmations: 20, decimals: 6, rpcs: ['https://arbitrum-one.publicnode.com', 'https://arb1.arbitrum.io/rpc', 'https://1rpc.io/arb'] }
};

export const MSG = {
  notFound: "We can't see that transaction yet. If you just sent it, wait a minute and try again. Make sure you pasted the FULL transaction ID.",
  failed: 'That transaction failed on-chain, so no payment was made.',
  confirming: 'Your payment is on-chain but still waiting for confirmations. Please try again in a minute.',
  wrongAddress: "That transaction didn't send USDC to the Reality Check wallet. Double-check you sent to the address shown here.",
  wrongAmount: (p) => `That transaction sent less than ${p} USDC to Reality Check. The report costs ${p} USDC.`,
  tooOld: (sec) => `That payment is older than ${sec >= 3600 ? Math.round(sec / 3600) + ' hours' : Math.round(sec / 60) + ' minutes'}, so it can no longer unlock a report. Please send a fresh payment.`,
  used: 'That transaction was already used to unlock a report for a different coin. $1 = one report for one coin, so each coin needs its own payment.',
  badFormat: "That doesn't look like a complete transaction ID. Copy the FULL ID from your wallet or exchange (Solana IDs are long letters and numbers; EVM IDs start with 0x).",
  busy: 'The blockchain is busy right now. Please try again in a minute. Nothing was charged twice.'
};

async function post(url, method, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
  return r.json();
}

// ---- Two-source rule (audit M1): every payment must be seen identically by at least 2 independent RPC providers.
// If only one source sees it, or sources disagree, the answer is "still confirming — try again in a minute".
function consensus(outs) {
  const seen = outs.filter(o => o.kind === 'tx');
  if (seen.length === 0) return outs.some(o => o.kind === 'none') ? { kind: 'none' } : { kind: 'down' };
  const k0 = seen[0].key;
  if (seen.some(o => o.key !== k0)) return { kind: 'disagree' };
  if (seen.length < 2) return { kind: 'single' };
  return { kind: 'ok', v: seen[0] };
}

async function solSource(u, sig) {
  try {
    let j = await post(u, 'getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
    // newer transaction versions: retry allowing them instead of reporting "busy"
    if (j.error && j.error.code === -32015) j = await post(u, 'getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
    if (j.error && j.error.code === -32602) return { kind: 'none' }; // malformed signature: node answered, tx doesn't exist
    if (j.error) return { kind: 'down' };
    const tx = j.result; if (!tx) return { kind: 'none' };
    const sum = (l) => (l || []).reduce((t, b) => (b.mint === USDC_SOL_MINT && b.owner === RC_SOL) ? t + BigInt(b.uiTokenAmount?.amount || '0') : t, 0n);
    const received = sum(tx.meta?.postTokenBalances) - sum(tx.meta?.preTokenBalances);
    const failed = !!(tx.meta && tx.meta.err), bt = tx.blockTime || 0;
    return { kind: 'tx', failed, bt, received, key: `${failed}|${bt}|${received}` };
  } catch { return { kind: 'down' }; }
}

async function verifySol(sig, price, maxAge) {
  const c = consensus(await Promise.all(SOL_RPCS.map(u => solSource(u, sig))));
  if (c.kind === 'down') return { status: 'busy', reason: MSG.busy };
  if (c.kind === 'none') return { status: 'invalid', reason: MSG.notFound, pending: true };
  if (c.kind !== 'ok') return { status: 'invalid', pending: true, reason: MSG.confirming };
  const { failed, bt, received } = c.v;
  if (failed) return { status: 'invalid', reason: MSG.failed };
  if (!bt) return { status: 'invalid', reason: MSG.notFound, pending: true };
  if (Math.floor(Date.now() / 1000) - bt > maxAge) return { status: 'invalid', reason: MSG.tooOld(maxAge) };
  if (received <= 0n) return { status: 'invalid', reason: MSG.wrongAddress };
  if (received < BigInt(Math.round(price * 1e6))) return { status: 'invalid', reason: MSG.wrongAmount(price) };
  return { status: 'ok', chain: 'Solana', amount: Number(received) / 1e6, micro: Number(received), blockTime: bt };
}

async function rpc1(u, method, params) { const j = await post(u, method, params); if (j.error) throw new Error('rpc'); return j.result; }

async function evmSource(cfg, u, sig) {
  try {
    const receipt = await rpc1(u, 'eth_getTransactionReceipt', [sig]);
    if (!receipt) return { kind: 'none' };
    const block = await rpc1(u, 'eth_getBlockByNumber', [receipt.blockNumber, false]);
    const bt = block?.timestamp ? parseInt(block.timestamp, 16) : 0;
    const latest = parseInt(await rpc1(u, 'eth_blockNumber', []), 16);
    if (!bt || !Number.isFinite(latest)) return { kind: 'down' };
    const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const to = '0x000000000000000000000000' + RC_EVM.slice(2).toLowerCase();
    let total = 0n;
    for (const log of (receipt.logs || [])) {
      if ((log.address || '').toLowerCase() !== cfg.usdc.toLowerCase()) continue;
      const t = log.topics || [];
      if ((t[0] || '').toLowerCase() !== TRANSFER || (t[2] || '').toLowerCase() !== to) continue;
      try { total += BigInt(log.data); } catch {}
    }
    const bn = parseInt(receipt.blockNumber, 16), ok = receipt.status === '0x1';
    return { kind: 'tx', ok, bt, bn, total, latest, key: `${ok}|${bn}|${bt}|${total}` };
  } catch { return { kind: 'down' }; }
}

async function verifyEvm(cfg, sig, price, maxAge) {
  const outs = await Promise.all(cfg.rpcs.map(u => evmSource(cfg, u, sig)));
  const c = consensus(outs);
  if (c.kind === 'none') return { status: 'not-found' };
  if (c.kind === 'down') return { status: 'invalid', reason: MSG.busy };
  if (c.kind !== 'ok') return { status: 'invalid', pending: true, reason: MSG.confirming };
  const { ok, bt, bn, total } = c.v;
  if (!ok) return { status: 'invalid', reason: MSG.failed };
  if (Math.floor(Date.now() / 1000) - bt > maxAge) return { status: 'invalid', reason: MSG.tooOld(maxAge) };
  // Finality: N confirmations, measured by the most conservative agreeing source.
  const latest = Math.min(...outs.filter(o => o.kind === 'tx').map(o => o.latest));
  if (latest - bn + 1 < cfg.confirmations) return { status: 'invalid', pending: true, reason: MSG.confirming };
  // Decimals are hard-coded per chain (never read from an RPC, which could lie about the scale).
  const unit = 10n ** BigInt(cfg.decimals);
  if (total === 0n) return { status: 'invalid', reason: MSG.wrongAddress };
  if (total * 100n < BigInt(Math.round(price * 100)) * unit) return { status: 'invalid', reason: MSG.wrongAmount(price) };
  return { status: 'ok', chain: cfg.label, amount: Number(total) / Number(unit), micro: Number(total * 1000000n / unit), blockTime: bt };
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

// $1 = one report for ONE coin. Each tx is stored with the coin it unlocked (e.g. "solana:<mint>").
// Same tx + same coin -> may re-show that coin's report; same tx + any other coin -> blocked forever.
export const txKey = (raw) => { const id = String(raw).trim(); return /^0x/i.test(id) ? id.toLowerCase() : id; };
export const coinKey = (chain, contract) => { const c = String(contract || '').trim(); return `${String(chain || '').toLowerCase()}:${/^0x/i.test(c) ? c.toLowerCase() : c}`; };
const kv = async (path) => { const r = await fetch(`${process.env.KV_REST_API_URL}/${path}`, { headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }, signal: AbortSignal.timeout(8000) }); return r.json(); };

// Returns the coin this tx already unlocked (or null). Legacy entries ("used") count as bound to no coin.
export async function txBoundCoin(raw) {
  if (!oneTimeEnforced()) return null;
  try { const j = await kv(`get/rc:paidtx:${encodeURIComponent(txKey(raw))}`); return j.result ?? null; } catch { return null; }
}

// ---------- Underpayment top-up: combine several manual payments ----------
// Parse a list of tx IDs from an array or a comma/space/newline separated string. Max 5.
export function parseTxList(v) {
  const arr = Array.isArray(v) ? v : (v == null ? [] : [v]);
  return arr.flatMap(x => String(x || '').split(/[\s,]+/)).map(s => s.trim()).filter(Boolean);
}
const r6 = (n) => Math.round(Number(n) * 1e6) / 1e6;
export const shortfallInfo = (received, required) => ({ received: r6(received), required: r6(required), short: r6(Math.max(0, required - received)) });
export const shortfallMsg = (s) => `We received ${s.received} USDC but this needs ${s.required} USDC — ${s.short} USDC short (exchange or network fees are often deducted). Send the difference and paste ALL your transaction IDs below to combine them.`;

