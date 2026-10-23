// Owner-only tools for problem payments. Protected by RC_ADMIN_SECRET (Production env only).
// Constant-time secret check, failed-attempt rate limit, every action logged in KV. Never returns tokens.
import crypto from 'crypto';
import { kvCmd, loadSession, sessionSummary, adminGrant } from './_checkout.js';
import { verifyManualTx, txKey, coinKey } from './_manual-pay.js';
import { normList, listKey, deepClaim } from './deep-report.js';

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest();
const MAX_FAILS_PER_HOUR = 8;
const kv = (a) => kvCmd(a);
const iph = (req) => crypto.createHash('sha256').update(String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim()).digest('hex').slice(0, 24);
async function log(req, action, detail) {
  try { await kv(['LPUSH', 'rc:adminlog', JSON.stringify({ t: Math.floor(Date.now() / 1000), ip: iph(req), action, detail })]); await kv(['LTRIM', 'rc:adminlog', 0, 999]); } catch {}
}
const SITE = 'https://www.realitycheckglobal.trade';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Use POST' });
  const secret = process.env.RC_ADMIN_SECRET;
  if (!secret || secret.length < 12 || !process.env.KV_REST_API_URL) return res.status(503).json({ success: false, message: 'Admin is not configured.' });
  const failKey = `rc:admfail:${iph(req)}:${Math.floor(Date.now() / 3600000)}`;
  let fails = 0;
  try { fails = Number(await kv(['GET', failKey])) || 0; } catch { return res.status(503).json({ success: false, message: 'Store unreachable.' }); }
  if (fails >= MAX_FAILS_PER_HOUR) return res.status(429).json({ success: false, message: 'Too many failed attempts. Try again later.' });
  const given = String(req.headers?.['x-rc-admin'] || '');
  if (!crypto.timingSafeEqual(sha(given), sha(secret))) {
    try { const n = await kv(['INCR', failKey]); if (n === 1) await kv(['EXPIRE', failKey, 3600]); } catch {}
    await log(req, 'login-failed', null);
    await new Promise(r => setTimeout(r, 400));
    return res.status(401).json({ success: false, message: 'Wrong admin secret.' });
  }
  const b = req.body || {};
  const action = String(b.action || '');

  if (action === 'login') { await log(req, 'login', null); return res.status(200).json({ success: true }); }

  if (action === 'lookup') {
    const q = String(b.q || '').trim();
    await log(req, 'lookup', q.slice(0, 100));
    if (/^[a-f0-9]{32}$/.test(q)) {
      const s = await loadSession(kv, q);
      return res.status(200).json({ success: true, type: 'session', session: s ? sessionSummary(s) : null });
    }
    if (/^0x[a-fA-F0-9]{64}$/.test(q) || /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(q)) {
      const bound = await kv(['GET', `rc:paidtx:${encodeURIComponent(txKey(q))}`]);
      let session = null;
      if (bound && /^(sess|grant):/.test(bound)) session = sessionSummary(await loadSession(kv, bound.split(':')[1]));
      const v = await verifyManualTx(q, { price: 0, maxAgeSec: 3650 * 86400 });
      return res.status(200).json({ success: true, type: 'tx', claimed: bound != null, boundTo: bound, session,
        chain: v.chain || null, amount: v.status === 'ok' ? v.amount : null, blockTime: v.blockTime || null, status: v.status, reason: v.status === 'ok' ? null : v.reason });
    }
    if (/^\d+(\.\d{1,6})?$/.test(q)) {
      const micro = Math.round(Number(q) * 1e6);
      const id = await kv(['GET', `rc:amt:${micro}`]);
      return res.status(200).json({ success: true, type: 'amount', reservedBy: id, session: id ? sessionSummary(await loadSession(kv, id)) : null });
    }
    return res.status(200).json({ success: false, message: 'Paste a transaction ID, a 32-character session ID, or an exact amount (e.g. 1.0205).' });
  }

  if (action === 'grant') {
    const kind = String(b.kind || '');
    let claim, price, meta;
    if (kind === 'deep') {
      const chain = String(b.chain || ''), c = String(b.contract || '').trim();
      const ok = chain === 'solana-mainnet' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(c) : /^(0x)?[a-fA-F0-9]{40}$/.test(c);
      if (!chain || !ok) return res.status(200).json({ success: false, message: 'Enter a valid contract and chain.' });
      claim = deepClaim(chain, c); price = 1; meta = { kind, chain, contract: c };
    } else if (kind === 'exit') {
      const m = String(b.contract || '').trim();
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m)) return res.status(200).json({ success: false, message: 'Enter a valid Solana mint.' });
      claim = 'exit:' + coinKey('solana', m); price = 1; meta = { kind, mint: m };
    } else if (kind === 'bundle') {
      const list = normList(b.coins);
      if (!list) return res.status(200).json({ success: false, message: 'Bundle needs 1-5 different coins.' });
      claim = 'deepbundle:' + listKey(list); price = list.length; meta = { kind, coins: list.map(x => ({ chain: x.chain, contract: x.contract })) };
    } else return res.status(200).json({ success: false, message: 'Choose deep, exit or bundle.' });
    const g = await adminGrant({ claim, price, meta, note: b.note, txIds: b.txIds });
    await log(req, g.ok ? 'grant' : 'grant-failed', { claim, sessionId: g.sessionId || null, txIds: b.txIds || null, note: String(b.note || '').slice(0, 200) });
    if (!g.ok) return res.status(200).json({ success: false, message: g.message });
    return res.status(200).json({ success: true, sessionId: g.sessionId, link: `${SITE}/?rc_grant=${g.code}`, expiresInHours: 24 });
  }

  if (action === 'held') {
    // Payments held because two open checkouts could match them. Issue an unlock link (with the tx ID) to release one.
    const rows = await kv(['LRANGE', 'rc:held', 0, 199]);
    const list = [];
    for (const r of rows || []) {
      let h; try { h = JSON.parse(r); } catch { continue; }
      const st = await Promise.all((h.txs || []).map(tx => kv(['GET', `rc:paidtx:${encodeURIComponent(txKey(tx))}`])));
      list.push({ ...h, status: st.every(x => String(x || '').startsWith('held:')) ? 'held' : st.map(x => x || 'free').join(', ') });
    }
    await log(req, 'view-held', null);
    return res.status(200).json({ success: true, held: list });
  }

  if (action === 'log') {
    const rows = await kv(['LRANGE', 'rc:adminlog', 0, 99]);
    await log(req, 'view-log', null);
    return res.status(200).json({ success: true, log: (rows || []).map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean) });
  }
  return res.status(400).json({ success: false, message: 'Unknown action' });
}
