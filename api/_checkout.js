// Checkout sessions: every payment (manual paste, one-click wallet, Solana Pay reference) must match a
// checkout opened in the buyer's browser. Session = random id + secret token (only SHA-256 stored)
// + exact coin / bundle list + a UNIQUE exact amount (price + small tag), reserved in KV with NX.
// Nothing that unlocks a report ever travels in a URL: Solana Pay references, resume codes and admin
// grant codes are useless without (or are exchanged once for) the session token.
import crypto from 'crypto';
import { verifyManualTx, manualMaxAge, MSG, parseTxList, txKey } from './_manual-pay.js';

export const SESSION_TTL = 86400;          // 4-decimal checkout: open 24h (= manual payment window)
const CLAIM_GRACE = 3600;                  // a payment sent just before expiry can still be claimed for 1h
const REPLACED_HOLD = 2 * 3600;            // amount of a replaced checkout stays reserved (for this browser) 2h
const PAID_KEEP = 7 * 86400;               // paid sessions kept 7 days so the same browser can re-show
export const SUGGEST = 1.11;               // suggested $1.11 per coin (covers fees); minimum that must ARRIVE is $1 per coin
const TAG_MAIN = [1, 99];                  // tag 0.0001 .. 0.0099 -> e.g. 1.1101 .. 1.1199
const TAG_EXT = [100, 899];                // if those run out: 0.0100 .. 0.0899 -> e.g. 1.1200 .. 1.1999 (L4: 899 slots per price)
const MAX_CHECKOUTS_PER_IP_HOUR = 40;
const MAX_CHECKOUTS_GLOBAL_HOUR = 2000;
const MAX_OPEN_PER_IP = 6;                  // L4: unpaid checkouts one connection may hold open at once
const MAX_SAME_PRODUCT_PER_IP_HOUR = 8;     // new checkouts per connection per coin/list per hour
// Clock tolerance between our server clock and the chain's block time (both directions). Was 30s; block times
// on Solana/EVM are within a few seconds of real time, so 10s keeps honest buyers safe and shrinks the window in
// which someone can open a checkout AFTER seeing a payment on-chain (that only ever causes a hold, never a theft).
export const CLOCK_SKEW = 10;
export const RESUME_TTL = 600;             // Phantom hand-off code: 10 minutes, single use
export const GRANT_TTL = 86400;            // admin unlock link: 24h, single use
export const CONTACT = 'Reality Check on X (@RC_Reality_ — https://x.com/RC_Reality_)';
export const HELP = "Message us on X @RC_Reality_ (https://x.com/RC_Reality_) with your transaction ID and we'll send your report link.";
export const BUSY = 'Checkout is busy right now — please try again in a few minutes. No payment was taken.';

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
export const fmt = (micro) => (micro / 1e6).toFixed(micro % 100 === 0 ? 4 : 6);
const B58A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (buf) => { let n = BigInt('0x' + Buffer.from(buf).toString('hex')), s = ''; while (n > 0n) { s = B58A[Number(n % 58n)] + s; n /= 58n; } for (const x of buf) { if (x === 0) s = '1' + s; else break; } return s; };

async function kvReal(args) {
  const r = await fetch(process.env.KV_REST_API_URL, { method: 'POST', headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(8000) });
  const j = await r.json(); if (j.error) throw new Error('kv'); return j.result;
}
const enabled = () => !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
const D = (deps) => ({ kv: deps.kv || kvReal, verify: deps.verify || verifyManualTx, now: deps.now || (() => Math.floor(Date.now() / 1000)), enabled: deps.kv ? true : enabled() });
export const kvCmd = (args, deps = {}) => D(deps).kv(args);

const pub = (s, token) => ({ sessionId: s.id, ...(token ? { token } : {}), amount: s.micro / 1e6, amountText: fmt(s.micro), micro: s.micro, minimum: s.price, exp: s.exp, status: s.status, ...(s.meta ? { meta: s.meta } : {}) });

export async function loadSession(kv, id) {
  if (!/^[a-f0-9]{32}$/.test(String(id || ''))) return null;
  const raw = await kv(['GET', `rc:sess:${id}`]);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
const save = (kv, s) => kv(['SET', `rc:sess:${s.id}`, JSON.stringify(s), 'XX', 'KEEPTTL']);
function tokenOk(s, token) {
  if (!s || !token || !s.th) return false;
  const a = Buffer.from(sha(token)), b = Buffer.from(String(s.th));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function releaseAmount(kv, s, holdSec) {
  try { if ((await kv(['GET', `rc:amt:${s.micro}`])) === s.id) { if (holdSec) await kv(['EXPIRE', `rc:amt:${s.micro}`, holdSec]); else await kv(['DEL', `rc:amt:${s.micro}`]); } } catch {}
}
// Load + authorise a session for `claim`. Returns { s } or { err:{...} }.
async function authed(kv, { sessionId, token, claim }) {
  if (!sessionId || !token) return { err: { ok: false, needCheckout: true, message: 'For your security, a transaction ID alone cannot unlock a report. Open the payment screen again (tap Unlock / Open on this page) to start a checkout, and send the exact amount it shows. If you already paid and lost the page: ' + HELP } };
  const s = await loadSession(kv, sessionId);
  if (!s) return { err: { ok: false, needCheckout: true, message: 'This checkout was not found or has expired. Start a new checkout on this page. If you already paid: ' + HELP } };
  if (!tokenOk(s, token)) return { err: { ok: false, message: 'This payment can only be verified from the browser that started this checkout. If you paid but lost that page or browser: ' + HELP } };
  if (s.claim !== claim) return { err: { ok: false, message: 'This checkout was opened for a different coin or list. Open the payment screen for this coin to get its own checkout.' } };
  // Defence in depth: a bundle session must have been priced for exactly as many coins as its list holds.
  if (String(claim).startsWith('deepbundle:') && Number(s.price) !== String(claim).slice('deepbundle:bundle:'.length).split(',').length) return { err: { ok: false, message: 'This checkout does not match this list of coins. Open the payment screen again for this list.' } };
  if (s.status === 'replaced') return { err: { ok: false, needCheckout: true, message: 'This checkout was replaced by a newer one in this browser. Reload the payment screen.' } };
  return { s };
}

// Create (or reuse) a checkout for `claim`. price = minimum USDC (N coins = N); suggested amount = N x 1.11 + unique tag.
export async function createSession({ claim, price, ip, prevId, prevToken, meta = null }, deps = {}) {
  const { kv, now, enabled: on } = D(deps);
  if (!on) return { ok: false, message: 'Payments are temporarily unavailable (checkout store not configured). No payment was taken.' };
  try {
    const t = now();
    let prev = null;
    if (prevId && prevToken) {
      const s = await loadSession(kv, prevId);
      if (s && tokenOk(s, prevToken) && s.claim === claim) {
        if (s.status === 'paid') return { ok: true, reused: true, ...pub(s) };
        if (s.status === 'open' && s.exp - t > 3600) return { ok: true, reused: true, ...pub(s) };
        if (s.status === 'open') prev = s; // nearly expired -> replace, release its amount early
      }
    }
    const hour = Math.floor(t / 3600);
    const g = await kv(['INCR', `rc:ckall:${hour}`]); if (g === 1) await kv(['EXPIRE', `rc:ckall:${hour}`, 7200]);
    if (g > MAX_CHECKOUTS_GLOBAL_HOUR) return { ok: false, busy: true, message: BUSY };
    let iph = null;
    if (ip) {
      iph = sha(ip).slice(0, 32);
      const k = `rc:ckip:${iph}`;
      const n = await kv(['INCR', k]); if (n === 1) await kv(['EXPIRE', k, 3600]);
      if (n > MAX_CHECKOUTS_PER_IP_HOUR) return { ok: false, busy: true, message: 'Too many checkouts from this connection in the last hour. Please try again later. No payment was taken.' };
      const kp = `rc:ckipp:${iph}:${sha(claim).slice(0, 16)}:${hour}`;
      const np = await kv(['INCR', kp]); if (np === 1) await kv(['EXPIRE', kp, 7200]);
      if (np > MAX_SAME_PRODUCT_PER_IP_HOUR) return { ok: false, busy: true, message: 'Too many checkouts for this coin from this connection in the last hour. Please use the checkout you already have, or try again later. No payment was taken.' };
      // Cap unpaid checkouts held open by one connection (prunes paid / expired / released ones first).
      const ko = `rc:ipopen:${iph}`;
      const mine = await kv(['SMEMBERS', ko]);
      let live = 0;
      for (const oid of (Array.isArray(mine) ? mine : [])) {
        if (prev && oid === prev.id) { try { await kv(['SREM', ko, oid]); } catch {} continue; }
        const o = await loadSession(kv, oid);
        if (o && o.status === 'open' && !o.released && t <= o.exp) live++; else { try { await kv(['SREM', ko, oid]); } catch {} }
      }
      if (live >= MAX_OPEN_PER_IP) return { ok: false, busy: true, message: 'You already have several unpaid checkouts open from this connection. Finish or wait for one of those, or try again later. No payment was taken.' };
    }
    const id = crypto.randomBytes(16).toString('hex'), token = crypto.randomBytes(32).toString('base64url');
    const ttl = SESSION_TTL, hold = ttl + 2 * CLAIM_GRACE;
    const base = Math.round(price * SUGGEST * 1e6);
    let micro = 0;
    const tryTag = async (k) => { const m = base + k * 100; if ((await kv(['SET', `rc:amt:${m}`, id, 'NX', 'EX', hold])) === 'OK') micro = m; };
    for (let i = 0; i < 25 && !micro; i++) await tryTag(TAG_MAIN[0] + crypto.randomInt(TAG_MAIN[1] - TAG_MAIN[0] + 1));
    for (let i = 0; i < 40 && !micro; i++) await tryTag(TAG_EXT[0] + crypto.randomInt(TAG_EXT[1] - TAG_EXT[0] + 1)); // extend rather than fail
    for (let k = TAG_MAIN[0]; k <= TAG_EXT[1] && !micro; k++) await tryTag(k);                                    // last resort: scan every slot
    if (!micro) return { ok: false, busy: true, message: BUSY };
    const alt = [];
    if (prev) {
      // Same browser switched mode: the old amount stays valid for THIS session for a short hold, then is freed.
      for (const a of [{ micro: prev.micro, until: t + REPLACED_HOLD }, ...(prev.alt || [])]) if (a.until > t) alt.push(a);
      await releaseAmount(kv, prev, REPLACED_HOLD);
      try { await save(kv, { ...prev, status: 'replaced', replacedBy: id }); } catch {}
    }
    const s = { id, th: sha(token), claim, price, micro, created: t, since: prev ? Math.min(prev.since || prev.created, t) : t, exp: t + ttl, status: 'open', alt, ...(iph ? { iph } : {}), ...(meta ? { meta } : {}) };
    await kv(['SET', `rc:sess:${id}`, JSON.stringify(s), 'EX', hold]);
    try { await kv(['SADD', `rc:claimidx:${claim}`, id]); await kv(['EXPIRE', `rc:claimidx:${claim}`, hold]); } catch {}
    try { await kv(['SADD', 'rc:openall', id]); await kv(['EXPIRE', 'rc:openall', hold]); } catch {}
    if (iph) { try { await kv(['SADD', `rc:ipopen:${iph}`, id]); await kv(['EXPIRE', `rc:ipopen:${iph}`, ttl]); } catch {} }
    return { ok: true, ...pub(s, token) };
  } catch { return { ok: false, busy: true, message: BUSY }; }
}

// Claim with the session token + tx ID(s). Exact-amount match; atomic, one-time, tied to this session.
export async function claimSession({ sessionId, token, claim, txIds }, deps = {}) {
  const { kv, verify, now, enabled: on } = D(deps);
  if (!sessionId || !token) return (await authed(kv, {})).err;
  if (!on) return { ok: false, message: 'Payments are temporarily unavailable. No payment was taken.' };
  try {
    const a = await authed(kv, { sessionId, token, claim }); if (a.err) return a.err;
    const s = a.s;
    if (s.status === 'paid') return { ok: true, reshow: true, amount: (s.paidMicro || 0) / 1e6, chain: s.chain, ids: s.txs };
    const t = now();
    if (t > s.exp + CLAIM_GRACE) return { ok: false, needCheckout: true, message: `This checkout expired. If you already sent ${fmt(s.micro)} USDC for it, ${HELP} Otherwise start a new checkout.` };
    const ids = parseTxList(txIds);
    if (!ids.length) return { ok: false, message: 'Paste your transaction ID first.' };
    if (ids.length > 5) return { ok: false, message: 'Combine at most 5 transaction IDs.' };
    const keys = ids.map(txKey);
    if (new Set(keys).size !== keys.length) return { ok: false, message: 'The same transaction ID was pasted twice. Each payment can only be counted once.' };
    const bound = await Promise.all(keys.map(k => kv(['GET', `rc:paidtx:${encodeURIComponent(k)}`])));
    const held = bound.findIndex(b => b != null && String(b).startsWith('held:'));
    if (held >= 0) return { ok: false, held: true, message: `Transaction ${held + 1} is held for the owner to confirm, because more than one checkout could match it. Your payment is safe. ${HELP}` };
    const used = bound.findIndex(b => b != null);
    if (used >= 0) return { ok: false, message: `Transaction ${used + 1} was already used to unlock a report. Each payment can only be used once — nothing was claimed. If it is your payment and you lost the page: ${HELP}` };
    const vs = await Promise.all(ids.map(id => verify(id, { price: 0, maxAgeSec: manualMaxAge() })));
    const bad = vs.findIndex(v => v.status !== 'ok' || !(v.micro > 0));
    if (bad >= 0) return { ok: false, pending: !!vs[bad].pending, message: `Transaction ${bad + 1}: ${vs[bad].reason || MSG.notFound} Nothing was claimed.` };
    const since = s.since || s.created;
    const early = vs.findIndex(v => !v.blockTime || v.blockTime < since - CLOCK_SKEW);
    if (early >= 0) return { ok: false, message: `Transaction ${early + 1} was sent before this checkout started, so it cannot pay for it. Nothing was claimed. If you paid first and opened the page after: ${HELP}` };
    const sum = vs.reduce((x, v) => x + v.micro, 0);
    const minMicro = Math.round(s.price * 1e6);
    const targets = [...(s.released ? [] : [s.micro]), ...(s.alt || []).filter(x => x.until > t).map(x => x.micro)];
    const tagged = targets.some(m => Math.abs(sum - m) <= 1);
    if (!tagged) {
      // (c) under the minimum -> top-up
      if (sum < minMicro) { const sf = { received: sum / 1e6, required: minMicro / 1e6, short: (minMicro - sum) / 1e6 }; return { ok: false, shortfall: sf, message: `We received ${fmt(sum)} USDC but at least ${fmt(minMicro)} USDC must arrive — ${fmt(minMicro - sum)} USDC short (exchange or network fees are often deducted). Send at least ${fmt(minMicro - sum)} USDC more (plus fees) to the same address and paste ALL your transaction IDs below.` }; }
      // (b) untagged, >= minimum: must not be some OTHER checkout's exact tag ...
      const amts = [sum, ...vs.map(v => v.micro)];
      const owners = await Promise.all(amts.map(m => kv(['GET', `rc:amt:${m}`])));
      if (owners.some(o => o != null && o !== s.id)) return { ok: false, message: 'That payment exactly matches a different checkout\'s amount, so it cannot unlock this one. Nothing was claimed. If it is yours: ' + HELP };
      // ... and must not be ambiguous: another open, unpaid checkout for the same report opened before the payment.
      const firstTx = Math.min(...vs.map(v => v.blockTime));
      // H2: ANY other open checkout (any coin or product) opened before the payment makes it ambiguous -> hold.
      // Only auto-unlock when this was the only open checkout. Store unreachable / too many to scan -> hold (safe).
      let others = null; try { others = await kv(['SMEMBERS', 'rc:openall']); } catch {}
      const rivals = [];
      if (!Array.isArray(others) || others.length > 300) rivals.push('unknown');
      else for (const oid of others) {
        if (oid === s.id) continue;
        const o = await loadSession(kv, oid);
        const live = o && o.status === 'open' && t <= o.exp + CLAIM_GRACE;
        if (!live) { try { await kv(['SREM', 'rc:openall', oid]); } catch {} continue; }
        if (!o.released && (o.since || o.created) - CLOCK_SKEW <= firstTx) rivals.push(oid);
      }
      if (rivals.length) {
        // Hold every tx so nobody (neither checkout) can claim it until the owner decides.
        for (const k of keys) { try { await kv(['SET', `rc:paidtx:${encodeURIComponent(k)}`, `held:${s.id}`, 'NX', 'EX', PAID_KEEP]); } catch {} }
        try { await kv(['LPUSH', 'rc:held', JSON.stringify({ t, txs: ids, claim: s.claim, meta: s.meta || null, amount: fmt(sum), chain: [...new Set(vs.map(v => v.chain))].join(' + '), claimedBy: s.id, rivals })]); await kv(['LTRIM', 'rc:held', 0, 499]); } catch {}
        return { ok: false, held: true, message: `We received ${fmt(sum)} USDC, but another checkout was also open at that time, so we can't tell automatically whose payment this is. It is held safely — nobody can use it. ${HELP} (Sending the exact suggested amount avoids this.)` };
      }
    }
    const done = [];
    try {
      for (const k of keys) { if ((await kv(['SET', `rc:paidtx:${encodeURIComponent(k)}`, `sess:${s.id}`, 'NX', 'EX', PAID_KEEP])) !== 'OK') throw new Error('taken'); done.push(k); }
      const paid = { ...s, status: 'paid', txs: ids, paidMicro: sum, tagged, chain: [...new Set(vs.map(v => v.chain))].join(' + '), paidAt: t };
      if ((await kv(['SET', `rc:sess:${s.id}`, JSON.stringify(paid), 'XX', 'EX', PAID_KEEP])) !== 'OK') throw new Error('sess');
      await releaseAmount(kv, s, 0);
      try { await kv(['SREM', `rc:claimidx:${s.claim}`, s.id]); } catch {}
      try { await kv(['SREM', 'rc:openall', s.id]); } catch {}
      if (s.iph) { try { await kv(['SREM', `rc:ipopen:${s.iph}`, s.id]); } catch {} }
      return { ok: true, amount: sum / 1e6, chain: paid.chain, ids, tagged };
    } catch (e) {
      for (const k of done) { try { if ((await kv(['GET', `rc:paidtx:${encodeURIComponent(k)}`])) === `sess:${s.id}`) await kv(['DEL', `rc:paidtx:${encodeURIComponent(k)}`]); } catch {} }
      return { ok: false, message: e.message === 'taken' ? 'One of these transactions was just used for another report. Nothing was claimed.' : MSG.busy };
    }
  } catch { return { ok: false, message: MSG.busy }; }
}

// L4: the buyer's own browser can give up an unpaid checkout so its exact amount is freed at once.
// The session stays claimable (a payment already sent is never lost) but is treated as UNTAGGED from then on,
// so it can't take a payment that now belongs to a newer checkout and it no longer blocks anyone else.
export async function releaseSession({ sessionId, token, claim }, deps = {}) {
  const { kv } = D(deps);
  try {
    const a = await authed(kv, { sessionId, token, claim }); if (a.err) return a.err;
    const s = a.s;
    if (s.status !== 'open' || s.released) return { ok: true, released: !!s.released, status: s.status };
    if ((await save(kv, { ...s, released: true, alt: [] })) !== 'OK') return { ok: false, message: MSG.busy };
    await releaseAmount(kv, s, 0);
    try { await kv(['SREM', 'rc:openall', s.id]); } catch {}
    if (s.iph) { try { await kv(['SREM', `rc:ipopen:${s.iph}`, s.id]); } catch {} }
    return { ok: true, released: true };
  } catch { return { ok: false, message: MSG.busy }; }
}

// Solana Pay: the reference belongs to the session (only the token holder gets it and can claim with it).
export async function sessionRef({ sessionId, token, claim }, deps = {}) {
  const { kv } = D(deps);
  try {
    const a = await authed(kv, { sessionId, token, claim }); if (a.err) return a.err;
    const s = a.s;
    if (s.status !== 'open') return { ok: true, ...pub(s), reference: s.ref || null };
    if (!s.ref) { s.ref = b58(crypto.randomBytes(32)); if ((await save(kv, s)) !== 'OK') return { ok: false, message: MSG.busy }; }
    return { ok: true, ...pub(s), reference: s.ref };
  } catch { return { ok: false, message: MSG.busy }; }
}
// Poll: find the Solana Pay tx carrying this session's reference, then claim it with the exact-amount rules.
export async function claimByReference({ sessionId, token, claim }, findSigs, deps = {}) {
  const { kv } = D(deps);
  try {
    const a = await authed(kv, { sessionId, token, claim }); if (a.err) return a.err;
    if (a.s.status === 'paid') return claimSession({ sessionId, token, claim }, deps);
    if (!a.s.ref) return { ok: false, pending: true, message: 'Waiting for your payment…' };
    let sigs; try { sigs = await findSigs(a.s.ref); } catch { return { ok: false, pending: true, message: 'Solana RPC is busy — still checking…' }; }
    if (!sigs || !sigs.length) return { ok: false, pending: true, message: 'Waiting for your payment to confirm on Solana…' };
    const r = await claimSession({ sessionId, token, claim, txIds: [sigs[0]] }, deps);
    if (!r.ok && r.pending) return { ...r, pending: true };
    return r;
  } catch { return { ok: false, pending: true, message: MSG.busy }; }
}

// Single-use hand-off codes. 'resume' = move an OPEN checkout to another browser (Phantom in-app), 10 min.
// 'grant' = admin unlock link, 24h. Redeeming rotates the token, so the code can never be used twice.
export async function makeCode(type, { sessionId, token, claim }, deps = {}) {
  const { kv } = D(deps);
  try {
    const a = await authed(kv, { sessionId, token, claim }); if (a.err) return a.err;
    if (a.s.status !== 'open') return { ok: false, message: 'This checkout is already paid — open it in this browser.' };
    const code = crypto.randomBytes(18).toString('base64url');
    await kv(['SET', `rc:code:${code}`, JSON.stringify({ type, id: a.s.id }), 'EX', RESUME_TTL]);
    return { ok: true, code };
  } catch { return { ok: false, message: MSG.busy }; }
}
export async function redeemCode(code, deps = {}) {
  const { kv, now } = D(deps);
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(String(code || ''))) return { ok: false, message: 'This link is invalid. ' + HELP };
  try {
    const raw = await kv(['GETDEL', `rc:code:${code}`]);
    if (!raw) return { ok: false, message: 'This link was already used or has expired. Each link works once. If you still need your report: ' + HELP };
    const c = JSON.parse(raw);
    const s = await loadSession(kv, c.id);
    if (!s) return { ok: false, message: 'This checkout no longer exists. If you already paid: ' + HELP };
    if (c.type === 'resume' && (s.status !== 'open' || now() > s.exp)) return { ok: false, message: 'This checkout is already paid or expired, so it cannot be moved to another browser. If you already paid: ' + HELP };
    if (c.type === 'grant' && s.status !== 'paid') return { ok: false, message: 'This unlock link is not valid. ' + HELP };
    const token = crypto.randomBytes(32).toString('base64url');
    s.th = sha(token);
    if ((await save(kv, s)) !== 'OK') return { ok: false, message: MSG.busy };
    return { ok: true, type: c.type, claim: s.claim, ...pub(s, token) };
  } catch { return { ok: false, message: MSG.busy }; }
}

// Admin: create an already-paid session for a coin/list and a single-use 24h link that binds it to a browser.
export async function adminGrant({ claim, price, meta, note, txIds }, deps = {}) {
  const { kv, now } = D(deps);
  const t = now(), id = crypto.randomBytes(16).toString('hex');
  const ids = parseTxList(txIds), done = [];
  try {
    for (const tx of ids) {
      const k = `rc:paidtx:${encodeURIComponent(txKey(tx))}`;
      if ((await kv(['SET', k, `grant:${id}`, 'NX', 'EX', PAID_KEEP])) !== 'OK') {
        const cur = await kv(['GET', k]);
        if (!String(cur || '').startsWith('held:') || (await kv(['SET', k, `grant:${id}`, 'XX', 'EX', PAID_KEEP])) !== 'OK') throw new Error('taken');
      }
      done.push(tx);
    }
  } catch (e) {
    for (const tx of done) { try { if ((await kv(['GET', `rc:paidtx:${encodeURIComponent(txKey(tx))}`])) === `grant:${id}`) await kv(['DEL', `rc:paidtx:${encodeURIComponent(txKey(tx))}`]); } catch {} }
    return { ok: false, message: e.message === 'taken' ? 'One of those transaction IDs is already bound to a report. Look it up first.' : MSG.busy };
  }
  const s = { id, th: null, claim, price, micro: Math.round(price * 1e6), created: t, since: t, exp: t + GRANT_TTL, status: 'paid', granted: true, note: String(note || '').slice(0, 200), txs: ids, paidMicro: 0, chain: 'admin grant', paidAt: t, ...(meta ? { meta } : {}) };
  await kv(['SET', `rc:sess:${id}`, JSON.stringify(s), 'EX', PAID_KEEP]);
  const code = crypto.randomBytes(18).toString('base64url');
  await kv(['SET', `rc:code:${code}`, JSON.stringify({ type: 'grant', id }), 'EX', GRANT_TTL]);
  return { ok: true, sessionId: id, code };
}

// Light rate limits for payment-check / token endpoints (per IP + global). Fails open if the store is down.
export const LIMIT_MSG = 'Too many checks from this connection. Please wait a few minutes and try again. Nothing was charged.';
// Vercel sets x-vercel-forwarded-for itself (clients can't forge it); fall back for local tests.
export const clientIp = (req) => String(req?.headers?.['x-vercel-forwarded-for'] || req?.headers?.['x-real-ip'] || req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
export async function rateLimited(req, bucket, perIp, globalMax, winSec = 600, deps = {}) {
  const { kv, enabled: on } = D(deps); if (!on) return false;
  const ip = clientIp(req);
  const w = Math.floor(Date.now() / 1000 / winSec);
  const hit = async (k, max) => { const n = await kv(['INCR', k]); if (n === 1) await kv(['EXPIRE', k, winSec + 5]); return n > max; };
  try {
    if (await hit(`rc:rl:${bucket}:all:${w}`, globalMax)) return true;
    return await hit(`rc:rl:${bucket}:${crypto.createHash('sha256').update(ip).digest('hex').slice(0, 20)}:${w}`, perIp);
  } catch { return false; }
}
export const sessionSummary = (s) => s && ({ sessionId: s.id, claim: s.claim, meta: s.meta || null, status: s.status, amount: fmt(s.micro), minimum: s.price, tagged: s.tagged ?? null, created: s.created, exp: s.exp, paidAt: s.paidAt || null, paid: s.paidMicro ? fmt(s.paidMicro) : null, chain: s.chain || null, txs: s.txs || [], granted: !!s.granted, note: s.note || '', hasReference: !!s.ref, replacedBy: s.replacedBy || null });
