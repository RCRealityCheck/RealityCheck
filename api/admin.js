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
const EVM_DEEP = ['eth-mainnet', 'bsc-mainnet', 'avalanche-mainnet', 'base-mainnet', 'polygon-mainnet', 'arbitrum-mainnet'];
const guessEvm = (payChain) => ({ Ethereum: 'eth-mainnet', Base: 'base-mainnet', 'BNB Chain': 'bsc-mainnet', Polygon: 'polygon-mainnet', Arbitrum: 'arbitrum-mainnet' })[payChain] || 'eth-mainnet';
const CHAIN_NAME = { 'solana-mainnet': 'Solana', 'eth-mainnet': 'Ethereum', 'bsc-mainnet': 'BNB Chain', 'avalanche-mainnet': 'Avalanche', 'base-mainnet': 'Base', 'polygon-mainnet': 'Polygon', 'arbitrum-mainnet': 'Arbitrum' };
function describe(m) {
  if (!m) return null;
  if (m.kind === 'exit') return { report: 'Exit Door', coins: [{ address: m.mint, chain: 'Solana' }] };
  if (m.kind === 'bundle') return { report: `Deep Report bundle (${m.coins.length} coins)`, coins: m.coins.map(x => ({ address: x.contract, chain: CHAIN_NAME[x.chain] || x.chain })) };
  return { report: 'Deep Report', coins: [{ address: m.contract, chain: CHAIN_NAME[m.chain] || m.chain }] };
}
// Plain-language status of one buyer transaction. Amount = USDC actually received by our wallet.
async function checkTx(tx) {
  const bound = await kv(['GET', `rc:paidtx:${encodeURIComponent(txKey(tx))}`]);
  const v = await verifyManualTx(tx, { price: 0, maxAgeSec: 3650 * 86400 });
  const pub = { paid: v.status === 'ok', amount: v.status === 'ok' ? v.amount : null, chain: v.chain || null, time: v.blockTime || null };
  if (v.status === 'busy') return { status: 'busy', pub: { ...pub, status: 'busy', headline: 'The blockchain is busy. Try again in a minute.' } };
  if (v.status !== 'ok') return { status: 'not-ours', pub: { ...pub, status: 'not-ours', headline: 'Not a payment to us.', detail: v.reason || null } };
  let session = null, status;
  const b = String(bound || '');
  if (b.startsWith('held:')) { status = 'held'; session = await loadSession(kv, b.slice(5)); }
  else if (bound != null) { status = 'unlocked'; if (/^(sess|grant):/.test(b)) session = await loadSession(kv, b.split(':')[1]); }
  else { status = 'waiting'; const id = await kv(['GET', `rc:amt:${v.micro}`]); if (id) { const s = await loadSession(kv, id); if (s && s.status === 'open') session = s; } }
  const headline = { held: 'Held for you — check it and unlock it for the buyer.', unlocked: 'Unlocked already — this payment was used for a report.', waiting: 'Paid, but not used yet.' }[status];
  const what = session ? describe(session.meta) : null;
  return { status, session, micro: v.micro, pub: { ...pub, status, headline, what, needCoin: (status === 'held' || status === 'waiting') && !what } };
}


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

  // ---- Simple flow: paste a buyer's tx -> plain status -> one-button unlock (server re-checks everything) ----
  if (action === 'check' || action === 'unlock') {
    const tx = String(b.tx || '').trim();
    if (!(/^0x[a-fA-F0-9]{64}$/.test(tx) || /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(tx))) return res.status(200).json({ success: false, message: 'That does not look like a transaction ID. Copy the full ID the buyer sent you.' });
    const c = await checkTx(tx);
    if (action === 'check') { await log(req, 'check', { tx: tx.slice(0, 100), status: c.status }); return res.status(200).json({ success: true, ...c.pub }); }
    if (c.status !== 'held' && c.status !== 'waiting') { await log(req, 'unlock-refused', { tx: tx.slice(0, 100), status: c.status }); return res.status(200).json({ success: false, message: c.pub.headline }); }
    let claim, price, meta;
    if (c.session) { claim = c.session.claim; price = c.session.price; meta = c.session.meta || null; }
    else {
      const kind = String(b.kind || 'deep');
      if (kind === 'bundle') {
        const list = normList(b.coins);
        if (!list) return res.status(200).json({ success: false, message: 'A bundle needs 2 to 5 different coin addresses.' });
        claim = 'deepbundle:' + listKey(list); price = list.length; meta = { kind, coins: list.map(x => ({ chain: x.chain, contract: x.contract })) };
      } else {
        const addr = String(b.coin || '').trim();
        const chain = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr) ? 'solana-mainnet' : /^0x[a-fA-F0-9]{40}$/.test(addr) ? (EVM_DEEP.includes(b.chain) ? b.chain : guessEvm(c.pub.chain)) : null;
        if (!chain) return res.status(200).json({ success: false, message: 'Paste the coin address (a Solana mint or a 0x… address).' });
        if (kind === 'exit') { if (chain !== 'solana-mainnet') return res.status(200).json({ success: false, message: 'Exit Door works for Solana coins only.' }); claim = 'exit:' + coinKey('solana', addr); price = 1; meta = { kind, mint: addr }; }
        else { claim = deepClaim(chain, addr); price = 1; meta = { kind: 'deep', chain, contract: addr }; }
      }
    }
    // A held payment may be several txs (payment + top-up) held together: release them together, all re-verified.
    let txIds = [tx], micro = c.micro;
    if (c.status === 'held') {
      const rows = await kv(['LRANGE', 'rc:held', 0, 499]);
      for (const r of rows || []) { let h; try { h = JSON.parse(r); } catch { continue; } if ((h.txs || []).includes(tx)) { txIds = [...new Set(h.txs)]; break; } }
      if (txIds.length > 1) {
        micro = 0;
        for (const t of txIds) { const ct = t === tx ? c : await checkTx(t); if (ct.status !== 'held') { txIds = [tx]; micro = c.micro; break; } micro += ct.micro; }
      }
    }
    if (micro < Math.round(price * 1e6)) return res.status(200).json({ success: false, message: `We received ${micro / 1e6} USDC, but this report needs at least ${price} USDC. Ask the buyer to send the difference.` });
    const g = await adminGrant({ claim, price, meta, note: 'unlock for tx ' + tx.slice(0, 20), txIds });
    await log(req, g.ok ? 'unlock' : 'unlock-failed', { tx: tx.slice(0, 100), claim, sessionId: g.sessionId || null });
    if (!g.ok) return res.status(200).json({ success: false, message: g.message });
    return res.status(200).json({ success: true, link: `${SITE}/?rc_grant=${g.code}`, what: describe(meta), expiresInHours: 24 });
  }

  if (action === 'held') {
    // Payments held because two open checkouts could match them. Issue an unlock link (with the tx ID) to release one.
    const rows = await kv(['LRANGE', 'rc:held', 0, 199]);
    const list = [];
    for (const r of rows || []) {
      let h; try { h = JSON.parse(r); } catch { continue; }
      const st = await Promise.all((h.txs || []).map(tx => kv(['GET', `rc:paidtx:${encodeURIComponent(txKey(tx))}`])));
      list.push({ ...h, what: describe(h.meta), status: st.every(x => String(x || '').startsWith('held:')) ? 'held' : st.map(x => x || 'free').join(', ') });
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
