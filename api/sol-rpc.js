// Narrow Solana RPC proxy for the in-browser Phantom pay flow (public RPCs reject browser origins).
// Only the two read methods the page needs; params validated; rate-limited; the server RPC URL/key is never exposed.
import { rateLimited, LIMIT_MSG } from './_checkout.js';
const UPSTREAM = [process.env.SOLANA_RPC_URL, 'https://api.mainnet-beta.solana.com'].filter(Boolean);
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const COMMIT = ['processed', 'confirmed', 'finalized'];
function validate(method, params) {
  const p = Array.isArray(params) ? params : [];
  const cfgOk = (c) => c == null || (typeof c === 'object' && !Array.isArray(c) && Object.keys(c).every(k => (k === 'commitment' && COMMIT.includes(c[k])) || (k === 'encoding' && ['base64', 'jsonParsed'].includes(c[k]))));
  if (method === 'getLatestBlockhash') return p.length <= 1 && cfgOk(p[0]) ? [p[0] && p[0].commitment ? { commitment: p[0].commitment } : { commitment: 'confirmed' }] : null;
  if (method === 'getAccountInfo') return p.length >= 1 && p.length <= 2 && typeof p[0] === 'string' && B58.test(p[0]) && cfgOk(p[1]) ? [p[0], { encoding: (p[1] && p[1].encoding) || 'base64', commitment: (p[1] && p[1].commitment) || 'confirmed' }] : null;
  return null;
}
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Use POST' } });
  const b = req.body || {};
  const id = (typeof b.id === 'number' || typeof b.id === 'string') ? b.id : null;
  if (Array.isArray(b)) return res.status(200).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch not supported' } });
  const params = validate(String(b.method || ''), b.params);
  if (!params) return res.status(200).json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not allowed' } });
  if (await rateLimited(req, 'solrpc', 60, 20000)) return res.status(429).json({ jsonrpc: '2.0', id, error: { code: 429, message: LIMIT_MSG } });
  for (const u of UPSTREAM) {
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: b.method, params }), signal: AbortSignal.timeout(10000) });
      const j = await r.json();
      if (j && 'result' in j) return res.status(200).json({ jsonrpc: '2.0', id, result: j.result });
    } catch {}
  }
  return res.status(200).json({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Solana RPC is busy. Please try again in a minute.' } });
}
