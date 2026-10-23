// Checkout sessions: every manual payment must match a checkout opened in the buyer's browser.
// A session = random id + secret token (only its SHA-256 is stored) + the exact coin / bundle list
// + a UNIQUE exact amount (price + tag), reserved in KV with NX among open sessions.
// A public tx ID alone can never unlock anything: the claimer must hold the token, and the tx sum
// must equal THAT session's unique amount. Re-showing a paid report also requires the token.
import crypto from 'crypto';
import { verifyManualTx, manualMaxAge, MSG, parseTxList, txKey } from './_manual-pay.js';

export const SESSION_TTL = 86400;            // checkout open for 24h (= manual payment window)
const CLAIM_GRACE = 3600;                    // a payment sent just before expiry can still be claimed for 1h
const AMOUNT_HOLD = SESSION_TTL + 2 * CLAIM_GRACE; // amount stays reserved past the grace period
const PAID_KEEP = 7 * 86400;                 // paid sessions kept 7 days so the same browser can re-show
const TAGS = 499;                            // tag = 0.0001 .. 0.0499 USDC
const MAX_CHECKOUTS_PER_IP_HOUR = 40;
export const CONTACT = 'Reality Check on X (@RC_Reality_ — https://x.com/RC_Reality_)';

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
export const fmt = (micro) => (micro / 1e6).toFixed(micro % 100 === 0 ? 4 : 6);

async function kvReal(args) {
  const r = await fetch(process.env.KV_REST_API_URL, { method: 'POST', headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(8000) });
  const j = await r.json(); if (j.error) throw new Error('kv'); return j.result;
}
const enabled = () => !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
const D = (deps) => ({ kv: deps.kv || kvReal, verify: deps.verify || verifyManualTx, now: deps.now || (() => Math.floor(Date.now() / 1000)), enabled: deps.kv ? true : enabled() });

const pub = (s, token) => ({ sessionId: s.id, ...(token ? { token } : {}), amount: s.micro / 1e6, amountText: fmt(s.micro), micro: s.micro, exp: s.exp, status: s.status });

async function load(kv, id) {
  if (!/^[a-f0-9]{32}$/.test(String(id || ''))) return null;
  const raw = await kv(['GET', `rc:sess:${id}`]);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function tokenOk(s, token) {
  if (!s || !token) return false;
  const a = Buffer.from(sha(token)), b = Buffer.from(String(s.th));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Create (or reuse) a checkout for `claim` at `price` USDC.
export async function createSession({ claim, price, ip, prevId, prevToken }, deps = {}) {
  const { kv, now, enabled: on } = D(deps);
  if (!on) return { ok: false, message: 'Payments are temporarily unavailable (checkout store not configured). No payment was taken.' };
  try {
    const t = now();
    if (prevId && prevToken) {
      const s = await load(kv, prevId);
      if (s && tokenOk(s, prevToken) && s.claim === claim && (s.status === 'paid' || s.exp - t > 3600)) return { ok: true, reused: true, ...pub(s) };
    }
    if (ip) {
      const k = `rc:ckip:${sha(ip).slice(0, 32)}`;
      const n = await kv(['INCR', k]); if (n === 1) await kv(['EXPIRE', k, 3600]);
      if (n > MAX_CHECKOUTS_PER_IP_HOUR) return { ok: false, message: 'Too many checkouts from this connection in the last hour. Please try again later. No payment was taken.' };
    }
    const id = crypto.randomBytes(16).toString('hex'), token = crypto.randomBytes(32).toString('base64url');
    const base = Math.round(price * 1e6);
    let micro = 0;
    for (let i = 0; i < 40 && !micro; i++) {
      const m = base + (1 + crypto.randomInt(TAGS)) * 100;
      if ((await kv(['SET', `rc:amt:${m}`, id, 'NX', 'EX', AMOUNT_HOLD])) === 'OK') micro = m;
    }
    if (!micro) return { ok: false, message: 'Checkout is very busy right now. Please try again in a few minutes. No payment was taken.' };
    const s = { id, th: sha(token), claim, price, micro, created: t, exp: t + SESSION_TTL, status: 'open' };
    await kv(['SET', `rc:sess:${id}`, JSON.stringify(s), 'EX', AMOUNT_HOLD]);
    return { ok: true, ...pub(s, token) };
  } catch { return { ok: false, message: MSG.busy }; }
}

// Claim with the session token + tx ID(s). Exact-amount match; atomic, one-time, tied to this session.
export async function claimSession({ sessionId, token, claim, txIds }, deps = {}) {
  const { kv, verify, now, enabled: on } = D(deps);
  if (!sessionId || !token) return { ok: false, needCheckout: true, message: 'For your security, a transaction ID alone cannot unlock a report. Open the payment screen again (tap Unlock / Open on this page) to start a checkout, and send the exact amount it shows.' };
  if (!on) return { ok: false, message: 'Payments are temporarily unavailable. No payment was taken.' };
  try {
    const s = await load(kv, sessionId);
    if (!s) return { ok: false, needCheckout: true, message: 'This checkout was not found or has expired. Start a new checkout on this page.' };
    if (!tokenOk(s, token)) return { ok: false, message: 'This payment can only be verified from the browser that started this checkout.' };
    if (s.claim !== claim) return { ok: false, message: 'This checkout was opened for a different coin or list. Open the payment screen for this coin to get its own checkout.' };
    if (s.status === 'paid') return { ok: true, reshow: true, amount: s.paidMicro / 1e6, chain: s.chain, ids: s.txs };
    const t = now();
    if (t > s.exp + CLAIM_GRACE) return { ok: false, needCheckout: true, message: `This checkout expired. If you already sent ${fmt(s.micro)} USDC for it, contact ${CONTACT} with your transaction ID. Otherwise start a new checkout.` };
    const ids = parseTxList(txIds);
    if (!ids.length) return { ok: false, message: 'Paste your transaction ID first.' };
    if (ids.length > 5) return { ok: false, message: 'Combine at most 5 transaction IDs.' };
    const keys = ids.map(txKey);
    if (new Set(keys).size !== keys.length) return { ok: false, message: 'The same transaction ID was pasted twice. Each payment can only be counted once.' };
    const bound = await Promise.all(keys.map(k => kv(['GET', `rc:paidtx:${encodeURIComponent(k)}`])));
    const used = bound.findIndex(b => b != null);
    if (used >= 0) return { ok: false, message: `Transaction ${used + 1} was already used to unlock a report. Each payment can only be used once — nothing was claimed.` };
    const vs = await Promise.all(ids.map(id => verify(id, { price: 0, maxAgeSec: manualMaxAge() })));
    const bad = vs.findIndex(v => v.status !== 'ok' || !(v.micro > 0));
    if (bad >= 0) return { ok: false, pending: !!vs[bad].pending, message: `Transaction ${bad + 1}: ${vs[bad].reason || MSG.notFound} Nothing was claimed.` };
    const early = vs.findIndex(v => !v.blockTime || v.blockTime < s.created - 120);
    if (early >= 0) return { ok: false, message: `Transaction ${early + 1} was sent before this checkout started, so it cannot pay for it. Nothing was claimed.` };
    const sum = vs.reduce((a, v) => a + v.micro, 0), diff = sum - s.micro;
    if (diff < -1) { const sf = { received: sum / 1e6, required: s.micro / 1e6, short: -diff / 1e6 }; return { ok: false, shortfall: sf, message: `We received ${fmt(sum)} USDC but this checkout needs exactly ${fmt(s.micro)} USDC — ${fmt(-diff)} USDC short (exchange or network fees are often deducted). Send exactly ${fmt(-diff)} USDC more to the same address and paste ALL your transaction IDs below.` }; }
    if (diff > 1) return { ok: false, overpaid: { received: sum / 1e6, required: s.micro / 1e6 }, message: `We received ${fmt(sum)} USDC, but this checkout needs exactly ${fmt(s.micro)} USDC, so it could not be matched automatically. Nothing was claimed. Please contact ${CONTACT} with your transaction ID(s) and this amount so we can sort it out.` };
    const ttl = PAID_KEEP, done = [];
    try {
      for (const k of keys) { if ((await kv(['SET', `rc:paidtx:${encodeURIComponent(k)}`, `sess:${s.id}`, 'NX', 'EX', ttl])) !== 'OK') throw new Error('taken'); done.push(k); }
      const paid = { ...s, status: 'paid', txs: ids, paidMicro: sum, chain: [...new Set(vs.map(v => v.chain))].join(' + '), paidAt: t };
      if ((await kv(['SET', `rc:sess:${s.id}`, JSON.stringify(paid), 'XX', 'EX', ttl])) !== 'OK') throw new Error('sess');
      try { if ((await kv(['GET', `rc:amt:${s.micro}`])) === s.id) await kv(['DEL', `rc:amt:${s.micro}`]); } catch {}
      return { ok: true, amount: sum / 1e6, chain: paid.chain, ids };
    } catch (e) {
      for (const k of done) { try { if ((await kv(['GET', `rc:paidtx:${encodeURIComponent(k)}`])) === `sess:${s.id}`) await kv(['DEL', `rc:paidtx:${encodeURIComponent(k)}`]); } catch {} }
      return { ok: false, message: e.message === 'taken' ? 'One of these transactions was just used for another report. Nothing was claimed.' : MSG.busy };
    }
  } catch { return { ok: false, message: MSG.busy }; }
}
