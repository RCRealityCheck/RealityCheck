// Exit Door — optional $1 USDC supporter report for Solana tokens.
// Free reports stay free forever. This is an extra, opt-in report.
// Payment: Solana Pay transfer request (USDC). Non-custodial: the buyer's wallet
// sends USDC straight to the Reality Check wallet; the server never holds funds or keys.
// Payments are bound to a checkout session (token + unique amount, see _checkout.js); Solana Pay references are per session.
// Env: SOLANA_RPC_URL (optional), KV_REST_API_URL + KV_REST_API_TOKEN (checkout store). Payments go to the hard-coded RC_SOL wallet.
import crypto from 'crypto';
import { coinKey, RC_SOL } from './_manual-pay.js';
import { createSession, claimSession, sessionRef, claimByReference, makeCode, rateLimited, LIMIT_MSG } from './_checkout.js';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PRICE_USDC = 1;
const RPCS = [process.env.SOLANA_RPC_URL, 'https://api.mainnet-beta.solana.com'].filter(Boolean);
// Known Solana token lock / vesting programs
const LOCK_PROGRAMS = {
  'strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m': 'Streamflow',
  'LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn': 'Jupiter Lock',
  'CChTq6PthWU82YZkbveA3WDf7s97BWhBK4Vx9bmsT743': 'Bonfida Vesting'
};

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(buf) {
  let n = BigInt('0x' + Buffer.from(buf).toString('hex'));
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = '1' + s; else break; }
  return s;
}
const isSolAddr = a => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a || '');

async function rpc(method, params) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
  if (attempt) await new Promise(r => setTimeout(r, 700 * attempt));
  for (const url of RPCS) {
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(15000)
      });
      const j = await r.json();
      if (!j.error) return j.result;
      lastErr = j.error;
    } catch (e) { lastErr = e; }
  }
  }
  throw new Error('RPC failed: ' + (lastErr?.message || method));
}

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// ---- Report pieces. Every piece returns null/"unavailable" rather than guessing. ----
async function slippage(mint, decimals) {
  const out = { price: null, sells: [] };
  try {
    const p = await getJson(`https://lite-api.jup.ag/price/v3?ids=${mint}`);
    out.price = Number(p?.[mint]?.usdPrice) || null;
  } catch {}
  for (const usd of [100, 1000, 10000]) {
    if (!out.price || decimals === null) { out.sells.push({ usd, available: false, reason: 'No live price for this token right now, so sell sizes cannot be quoted.' }); continue; }
    try {
      const amount = BigInt(Math.floor((usd / out.price) * 10 ** decimals));
      const q = await getJson(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${mint}&outputMint=${USDC_MINT}&amount=${amount}&slippageBps=5000`);
      const got = Number(q.outAmount) / 1e6;
      out.sells.push({ usd, available: true, receiveUsd: +got.toFixed(2), lossPct: +(Math.max(0, 1 - got / usd) * 100).toFixed(2), priceImpactPct: +(Number(q.priceImpactPct || 0) * 100).toFixed(2), route: (q.routePlan || []).map(r => r.swapInfo?.label).filter(Boolean).join(' → ') });
    } catch (err) {
      const busy = /HTTP (429|5\d\d)/.test(String(err && err.message));
      out.sells.push({ usd, available: false, reason: busy ? 'The quote service was busy — try again in a minute.' : `Not enough liquidity to sell $${usd.toLocaleString('en-US')} in one trade (no swap route found).` });
    }
  }
  return out;
}

async function oldestTx(address, maxPages = 3) {
  let before, oldest = null, count = 0;
  for (let i = 0; i < maxPages; i++) {
    const page = await rpc('getSignaturesForAddress', [address, before ? { limit: 1000, before } : { limit: 1000 }]);
    if (!page || !page.length) break;
    count += page.length;
    oldest = page[page.length - 1];
    before = oldest.signature;
    if (page.length < 1000) return { oldest, count, complete: true };
  }
  return { oldest, count, complete: false };
}

async function funderOf(address) {
  try {
    const o = await oldestTx(address, 2);
    if (!o.oldest || !o.complete) return { funder: null, firstSeen: o.oldest?.blockTime || null };
    const tx = await rpc('getTransaction', [o.oldest.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
    const keys = tx.transaction.message.accountKeys.map(k => k.pubkey || k);
    const i = keys.indexOf(address);
    let funder = null;
    if (i >= 0 && tx.meta.postBalances[i] > tx.meta.preBalances[i]) {
      funder = keys.find((k, j) => j !== i && tx.meta.preBalances[j] > tx.meta.postBalances[j]) || null;
    }
    return { funder, firstSeen: tx.blockTime || null };
  } catch { return { funder: null, firstSeen: null }; }
}

async function buildReport(mint) {
  const report = { mint };
  const [supply, mintInfo] = await Promise.all([
    rpc('getTokenSupply', [mint]).catch(() => null),
    rpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }]).catch(() => null)
  ]);
  const parsed = mintInfo?.value?.data?.parsed?.info;
  if (!parsed || mintInfo.value.data.parsed.type !== 'mint') throw new Error('not-a-mint');
  const decimals = supply?.value?.decimals ?? parsed.decimals ?? null;
  const totalUi = Number(supply?.value?.uiAmountString || 0);
  report.authorities = { mintAuthority: parsed.mintAuthority || null, freezeAuthority: parsed.freezeAuthority || null };

  const [slip, largest] = await Promise.all([
    slippage(mint, decimals),
    rpc('getTokenLargestAccounts', [mint]).catch(() => null)
  ]);
  report.exitLiquidity = slip;

  // Holders: token account -> owner -> owner's program (to spot lock contracts)
  const accts = (largest?.value || []).slice(0, 10);
  let holders = [];
  if (accts.length) {
    const info = await rpc('getMultipleAccounts', [accts.map(a => a.address), { encoding: 'jsonParsed' }]).catch(() => null);
    holders = accts.map((a, i) => ({
      tokenAccount: a.address,
      owner: info?.value?.[i]?.data?.parsed?.info?.owner || null,
      pct: totalUi ? +(Number(a.uiAmountString) / totalUi * 100).toFixed(2) : null
    }));
    const owners = holders.map(h => h.owner).filter(Boolean);
    const ownerInfo = owners.length ? await rpc('getMultipleAccounts', [owners, { encoding: 'base64' }]).catch(() => null) : null;
    holders.forEach(h => {
      const k = owners.indexOf(h.owner);
      const prog = k >= 0 ? ownerInfo?.value?.[k]?.owner : null;
      h.ownerProgram = prog || null;
      h.lockedBy = prog && LOCK_PROGRAMS[prog] ? LOCK_PROGRAMS[prog] : null;
      h.isProgramOwned = !!(prog && prog !== '11111111111111111111111111111111');
    });
  }

  // Linked-wallet clustering by funding source (top 6 wallet-owned holders)
  const walletHolders = holders.filter(h => h.owner && !h.isProgramOwned).slice(0, 6);
  const funded = await Promise.all(walletHolders.map(async h => ({ ...h, ...(await funderOf(h.owner)) })));
  const byFunder = {};
  funded.forEach(h => { if (h.funder) (byFunder[h.funder] = byFunder[h.funder] || []).push(h); });
  report.clusters = Object.entries(byFunder).filter(([, m]) => m.length > 1).map(([funder, m]) => ({
    funder, members: m.map(x => ({ owner: x.owner, pct: x.pct })), combinedPct: +m.reduce((s, x) => s + (x.pct || 0), 0).toFixed(2)
  }));
  report.holders = holders.map(h => {
    const f = funded.find(x => x.tokenAccount === h.tokenAccount);
    return { owner: h.owner, pct: h.pct, lockedBy: h.lockedBy, isProgramOwned: h.isProgramOwned, funder: f?.funder || null, firstSeen: f?.firstSeen || null };
  });
  report.holdersAvailable = report.holders.length > 0;
  report.clusterCoverage = `${funded.filter(f => f.funder).length} of ${walletHolders.length} wallet holders traced to a funder`;

  // Deployer history: fee payer of the mint's first transaction
  report.deployer = { address: null, createdAt: null, walletFirstSeen: null, walletTxCount: null, countComplete: false };
  try {
    const o = await oldestTx(mint, 3);
    if (o.oldest && o.complete) {
      const tx = await rpc('getTransaction', [o.oldest.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
      const dep = tx.transaction.message.accountKeys[0];
      report.deployer.address = dep.pubkey || dep;
      report.deployer.createdAt = tx.blockTime || null;
      const d = await oldestTx(report.deployer.address, 2);
      report.deployer.walletFirstSeen = d.oldest?.blockTime || null;
      report.deployer.walletTxCount = d.count;
      report.deployer.countComplete = d.complete;
    }
  } catch {}

  // Unlock / vesting calendar: what we can prove on-chain is which top holders sit in lock programs.
  const locked = report.holders.filter(h => h.lockedBy);
  report.vesting = {
    lockedHolders: locked.map(h => ({ owner: h.owner, pct: h.pct, program: h.lockedBy })),
    lockedPct: +locked.reduce((s, h) => s + (h.pct || 0), 0).toFixed(2),
    schedule: null,
    note: !report.holders.length
      ? 'Holder data unavailable from the RPC right now, so locks could not be checked. Unlock calendar: data unavailable.'
      : locked.length
      ? 'Tokens are held by a lock/vesting program. Exact unlock dates are not decoded here — open the lock on the program\'s dashboard to see the calendar.'
      : 'No top-10 holder is held by a known lock program (Streamflow, Jupiter Lock, Bonfida). Unlock calendar: data unavailable — assume unlocked supply can be sold now.'
  };
  return report;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Use POST' });
  res.setHeader('Cache-Control', 'no-store'); // paid reports and tokens must never be cached
  const { action, contract, txSignature } = req.body || {};
  const mint = String(contract || '').trim();
  if (!isSolAddr(mint)) return res.status(200).json({ success: false, message: 'Enter a Solana token mint address.' });

  {
    const hasTx = !!(txSignature || req.body?.txSignatures);
    const bucket = hasTx ? ['verify', 30, 5000] : (action === 'report' || action === 'resume-code') ? ['poll', 300, 30000] : null;
    if (bucket && await rateLimited(req, ...bucket)) { res.setHeader('Cache-Control', 'no-store'); return res.status(200).json({ success: false, rateLimited: true, message: LIMIT_MSG }); }
  }
  const ses = { sessionId: req.body?.sessionId, token: req.body?.token, claim: 'exit:' + coinKey('solana', mint) };
  const fail = (c) => res.status(200).json({ success: false, message: c.message, shortfall: c.shortfall, overpaid: c.overpaid, needCheckout: !!c.needCheckout, pending: !!c.pending });
  const RISK = 'Public on-chain data only (Solana RPC, Jupiter quotes). Anything we could not read is marked unavailable. Not financial advice.';
  const sendReport = async (c) => {
    let report;
    try { report = await buildReport(mint); } catch {
      return res.status(200).json({ success: false, paidOk: true, message: 'Payment verified, but the report failed to load. Tap verify again in a minute — this browser can re-open it without paying again.' });
    }
    return res.status(200).json({ success: true, reshow: !!c.reshow, paid: { amount: c.amount, chain: c.chain }, report, riskNote: RISK });
  };

  if (action === 'request') {
    // Free data pre-check, then a Solana Pay request for THIS checkout's exact amount and reference.
    const acct = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }]).catch(() => null);
    if (acct?.value?.data?.parsed?.type !== 'mint') return res.status(200).json({ success: false, message: 'That address is not a Solana token mint. Nothing was charged.' });
    let lg = null;
    for (let t = 0; t < 3 && !(lg?.value || []).length; t++) { if (t) await new Promise(r => setTimeout(r, 1200 * t)); lg = await rpc('getTokenLargestAccounts', [mint]).catch(() => null); }
    if (!(lg?.value || []).length) return res.status(200).json({ success: false, noData: true, message: "We can't build a full report for this coin yet: the Solana network returned no holder list for it right now. No payment needed — try another coin." });
    if (!ses.sessionId) return res.status(200).json({ success: true, needCheckout: true });
    const r = await sessionRef(ses);
    if (!r.ok) return fail(r);
    const params = new URLSearchParams({ amount: r.amountText, 'spl-token': USDC_MINT, ...(r.reference ? { reference: r.reference } : {}), label: 'Reality Check', message: `Exit Door report ${mint.slice(0, 6)}…`, memo: `RC-EXIT-${mint.slice(0, 8)}` });
    return res.status(200).json({ success: true, reference: r.reference, exp: r.exp, status: r.status, recipient: RC_SOL, amount: r.amount, amountText: r.amountText, usdcMint: USDC_MINT, url: `solana:${RC_SOL}?${params.toString()}` });
  }

  if (action === 'checkout') {
    res.setHeader('Cache-Control', 'no-store');
    const ip = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
    const s = await createSession({ claim: ses.claim, price: PRICE_USDC, ip, prevId: ses.sessionId, prevToken: ses.token, meta: { kind: 'exit', mint } });
    return res.status(200).json(s.ok ? { success: true, ...s } : { success: false, busy: !!s.busy, message: s.message });
  }

  if (action === 'resume-code') {
    // Phantom in-app browser hand-off: single-use, 10-minute code that moves this OPEN checkout once.
    const c = await makeCode('resume', ses);
    return res.status(200).json(c.ok ? { success: true, code: c.code } : { success: false, message: c.message });
  }

  if (action === 'manual') {
    const c = await claimSession({ ...ses, txIds: req.body?.txSignatures || txSignature });
    return c.ok ? sendReport(c) : fail(c);
  }

  if (action === 'report') {
    if (!ses.sessionId) return res.status(200).json({ success: false, needCheckout: true, message: 'This payment request is from an older version of the page. Please reload and start a new checkout (no charge if you did not pay).' });
    const c = await claimByReference(ses, async (ref) => {
      const sigs = await rpc('getSignaturesForAddress', [ref, { limit: 10, commitment: 'confirmed' }]);
      return (sigs || []).filter(x => !x.err).map(x => x.signature).reverse();
    });
    return c.ok ? sendReport(c) : fail(c);
  }
  return res.status(400).json({ success: false, message: 'Unknown action' });
}
