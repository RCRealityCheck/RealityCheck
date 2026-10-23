// Public read-only health ping. No writes, no secrets. (Full self-tests run only from the admin page.)
import { oneTimeEnforced, manualMaxAge } from './_manual-pay.js';
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const out = { oneTimeEnforced: oneTimeEnforced(), manualMaxAgeSec: manualMaxAge(), storeReachable: false };
  if (out.oneTimeEnforced) {
    try { out.storeReachable = (await (await fetch(`${process.env.KV_REST_API_URL}/ping`, { headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }, signal: AbortSignal.timeout(8000) })).json()).result === 'PONG'; } catch {}
  }
  return res.status(200).json(out);
}
