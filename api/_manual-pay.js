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
  ethereum: { label: 'Ethereum', usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6, rpcs: ['https://eth.llamarpc.com', 'https://ethereum.publicnode.com', 'https://rpc.ankr.com/eth'] },
  base:     { label: 'Base', usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, rpcs: ['https://base.llamarpc.com', 'https://base.publicnode.com', 'https://rpc.ankr.com/base'] },
  bnb:      { label: 'BNB Chain', usdc: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', decimals: 18, rpcs: ['https://binance.llamarpc.com', 'https://bsc.publicnode.com', 'https://rpc.ankr.com/bsc'] },
  polygon:  { label: 'Polygon', usdc: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', decimals: 6, rpcs: ['https://polygon.llamarpc.com', 'https://polygon-bor.publicnode.com', 'https://rpc.ankr.com/polygon'] },
  arbitrum: { label: 'Arbitrum', usdc: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6, rpcs: ['https://arbitrum.llamarpc.com', 'https://arbitrum-one.publicnode.com', 'https://rpc.ankr.com/arbitrum'] }
};

export const MSG = {
  notFound: "We can't see that transaction yet. If you just sent it, wait a minute and try again. Make sure you pasted the FULL transaction ID.",
  failed: 'That transaction failed on-chain, so no payment was made.',
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

async function verifySol(sig, price, maxAge) {
  let tx = null, reached = false;
  for (const u of SOL_RPCS) {
    try { const j = await post(u, 'getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]); if (!j.error) { reached = true; if (j.result) { tx = j.result; break; } } } catch {}
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
  return { status: 'ok', chain: 'Solana', amount: Number(received) / 1e6, micro: Number(received), blockTime: tx.blockTime };
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
  let decimals = cfg.decimals ?? 6;
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

// Atomically bind a tx to a coin. Returns { enforced, ok, reshow }.
export async function claimTx(raw, coin) {
  if (!oneTimeEnforced()) return { enforced: false, ok: true };
  const k = `rc:paidtx:${encodeURIComponent(txKey(raw))}`;
  try {
    const j = await kv(`set/${k}/${encodeURIComponent(coin)}/NX`);
    if (j.result === 'OK') return { enforced: true, ok: true };
    const g = await kv(`get/${k}`);
    return g.result === coin ? { enforced: true, ok: true, reshow: true } : { enforced: true, ok: false };
  } catch { return { enforced: true, ok: false, error: true }; }
}

// Returns the coin this tx already unlocked (or null). Legacy entries ("used") count as bound to no coin.
export async function txBoundCoin(raw) {
  if (!oneTimeEnforced()) return null;
  try { const j = await kv(`get/rc:paidtx:${encodeURIComponent(txKey(raw))}`); return j.result ?? null; } catch { return null; }
}
// Blocked if the tx already unlocked a DIFFERENT coin.
export async function isTxUsed(raw, coin) { const b = await txBoundCoin(raw); return b != null && b !== coin; }

// ---------- Underpayment top-up: combine several manual payments ----------
// Parse a list of tx IDs from an array or a comma/space/newline separated string. Max 5.
export function parseTxList(v) {
  const arr = Array.isArray(v) ? v : (v == null ? [] : [v]);
  return arr.flatMap(x => String(x || '').split(/[\s,]+/)).map(s => s.trim()).filter(Boolean);
}
const r6 = (n) => Math.round(Number(n) * 1e6) / 1e6;
export const shortfallInfo = (received, required) => ({ received: r6(received), required: r6(required), short: r6(Math.max(0, required - received)) });
export const shortfallMsg = (s) => `We received ${s.received} USDC but this needs ${s.required} USDC — ${s.short} USDC short (exchange or network fees are often deducted). Send the difference and paste ALL your transaction IDs below to combine them.`;

// For a single tx that failed the full-price check: is it a real, recent, UNCLAIMED payment to us that is just short?
// Returns shortfall info or null. Never claims anything.
export async function measureShort(raw, required, deps = {}) {
  const verify = deps.verify || verifyManualTx, bound = deps.bound || txBoundCoin;
  try {
    if ((await bound(raw)) != null) return null;
    const v = await verify(raw, { price: 0, maxAgeSec: manualMaxAge() });
    if (v.status !== 'ok' || !(v.amount > 0) || v.amount >= required - 1e-9) return null;
    return shortfallInfo(v.amount, required);
  } catch { return null; }
}

async function kvSetNx(raw, coin) {
  const j = await kv(`set/rc:paidtx:${encodeURIComponent(txKey(raw))}/${encodeURIComponent(coin)}/NX`);
  return j.result === 'OK';
}
async function kvDelIf(raw, coin) {
  // Only remove a key we set ourselves (value === coin) — rollback after a partial claim.
  const k = `rc:paidtx:${encodeURIComponent(txKey(raw))}`;
  try { const g = await kv(`get/${k}`); if (g.result === coin) await kv(`del/${k}`); } catch {}
}

// Verify every tx independently, sum, and only if sum >= required claim ALL of them for `coin`.
// Returns { ok, amount, chain, ids } or { ok:false, message, shortfall? }.
export async function combineAndClaim(rawList, required, coin, deps = {}) {
  const verify = deps.verify || verifyManualTx, bound = deps.bound || txBoundCoin;
  const setNx = deps.setNx || kvSetNx, delIf = deps.delIf || kvDelIf;
  const enforced = deps.enforced ?? oneTimeEnforced();
  const ids = parseTxList(rawList);
  if (!ids.length) return { ok: false, message: 'Paste your transaction ID(s) first.' };
  if (ids.length > 5) return { ok: false, message: 'Combine at most 5 transaction IDs.' };
  const keys = ids.map(txKey);
  if (new Set(keys).size !== keys.length) return { ok: false, message: 'The same transaction ID was pasted twice. Each payment can only be counted once.' };
  let bounds;
  try { bounds = await Promise.all(ids.map(id => bound(id))); } catch { return { ok: false, message: MSG.busy }; }
  if (bounds.every(b => b === coin)) {
    // Exact same set already unlocked this coin/list: allow re-showing it (like single-ID reshow).
    if (enforced) { const vs = await Promise.all(ids.map(id => verify(id, { price: 0, maxAgeSec: manualMaxAge() }))); if (vs.every(v => v.status === 'ok')) return { ok: true, reshow: true, ids, amount: r6(vs.reduce((s, v) => s + v.amount, 0)), chain: [...new Set(vs.map(v => v.chain))].join(' + ') }; }
  }
  const usedIdx = bounds.findIndex(b => b != null);
  if (usedIdx >= 0) return { ok: false, message: `Transaction ${usedIdx + 1} was already used to unlock a report. Each payment can only be used once — nothing was claimed.` };
  const vs = await Promise.all(ids.map(id => verify(id, { price: 0, maxAgeSec: manualMaxAge() })));
  const bad = vs.findIndex(v => v.status !== 'ok' || !(v.amount > 0));
  if (bad >= 0) return { ok: false, pending: !!vs[bad].pending, message: `Transaction ${bad + 1}: ${vs[bad].reason || MSG.notFound} Nothing was claimed.` };
  const total = r6(vs.reduce((s, v) => s + v.amount, 0));
  if (total < required - 1e-9) { const s = shortfallInfo(total, required); return { ok: false, shortfall: s, message: shortfallMsg(s) }; }
  if (enforced) {
    const done = [];
    try {
      for (const id of ids) { if (!(await setNx(id, coin))) throw new Error('taken'); done.push(id); }
    } catch (e) {
      await Promise.all(done.map(id => delIf(id, coin)));
      return { ok: false, message: e.message === 'taken' ? 'One of these transactions was just used for another report. Nothing was claimed.' : MSG.busy };
    }
  }
  return { ok: true, ids, amount: total, chain: [...new Set(vs.map(v => v.chain))].join(' + ') };
}
