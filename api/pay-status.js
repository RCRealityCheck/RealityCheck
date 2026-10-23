// Read-only health check for one-time-use payments. Never returns secret values.
import crypto from 'crypto';
import { claimTx, oneTimeEnforced, manualMaxAge } from './_manual-pay.js';
import { createSession, claimSession } from './_checkout.js';
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const out = { oneTimeEnforced: oneTimeEnforced(), manualMaxAgeSec: manualMaxAge(), storeReachable: false, selfTest: null };
  if (!out.oneTimeEnforced) return res.status(200).json(out);
  const kv = async (p) => (await fetch(`${process.env.KV_REST_API_URL}/${p}`, { headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }, signal: AbortSignal.timeout(8000) })).json();
  try { out.storeReachable = (await kv('ping')).result === 'PONG'; } catch {}
  if (out.storeReachable) {
    const id = 'selftest-' + crypto.randomBytes(8).toString('hex');
    try {
      const a1 = await claimTx(id, 'test:coinA'), a2 = await claimTx(id, 'test:coinA'), b = await claimTx(id, 'test:coinB');
      out.selfTest = { firstUseAllowed: a1.ok === true, sameCoinReshow: a2.ok === true && a2.reshow === true, otherCoinBlocked: b.ok === false };
    } catch { out.selfTest = { error: true }; }
    try { await kv(`del/rc:paidtx:${id}`); } catch {}
    // Checkout sessions: unique amount reserved, tx ID without token rejected, wrong token rejected.
    let ck = null;
    try {
      const claim = 'selftest:' + id;
      const a = await createSession({ claim, price: 9 }), b = await createSession({ claim, price: 9 });
      const noTok = await claimSession({ claim, txIds: ['x'] });
      const badTok = a.ok ? await claimSession({ sessionId: a.sessionId, token: 'wrong', claim, txIds: ['x'] }) : { ok: true };
      const wrongCoin = a.ok ? await claimSession({ sessionId: a.sessionId, token: a.token, claim: claim + 'x', txIds: ['x'] }) : { ok: true };
      ck = { created: !!(a.ok && b.ok), uniqueAmounts: !!(a.ok && b.ok && a.micro !== b.micro), txWithoutTokenRejected: noTok.ok === false, wrongTokenRejected: badTok.ok === false, wrongCoinRejected: wrongCoin.ok === false };
      for (const x of [a, b]) if (x.ok) { try { await kv(`del/rc:sess:${x.sessionId}`); await kv(`del/rc:amt:${x.micro}`); } catch {} }
    } catch { ck = { error: true }; }
    out.checkoutSelfTest = ck;
  }
  return res.status(200).json(out);
}
