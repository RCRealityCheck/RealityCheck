// Read-only health check for one-time-use payments. Never returns secret values.
import crypto from 'crypto';
import { claimTx, oneTimeEnforced, manualMaxAge } from './_manual-pay.js';
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
  }
  return res.status(200).json(out);
}
