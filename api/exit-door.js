// Exit Door — optional $1 USDC supporter report for Solana tokens.
// Free reports stay free forever. This is an extra, opt-in report.
// Payment: Solana Pay transfer request (USDC). Non-custodial: the buyer's wallet
// sends USDC straight to the Reality Check wallet; the server never holds funds or keys.
// Each request gets a fresh random reference key, signed (HMAC) together with the
// contract and an expiry, so a payment only unlocks the contract it was made for.
// Env: RC_PAYMENT_WALLET (Solana wallet), SOLANA_RPC_URL, RC_REF_SECRET (required),
// optional KV_REST_API_URL + KV_REST_API_TOKEN (Upstash / Vercel KV) for one-time-use references.
import crypto from 'crypto';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PRICE_USDC = 1;
const REF_TTL_SEC = 1800;
const WALLET = process.env.RC_PAYMENT_WALLET || 'DYkdqhQNLQyikuPaNHJczSwcGPYVuGuBafqzXm8wqAvk';
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
const sign = (ref, contract, exp) =>
  crypto.createHmac('sha256', process.env.RC_REF_SECRET).update(`${ref}|${contract}|${exp}|${PRICE_USDC}|${WALLET}`).digest('hex');

async function rpc(method, params) {
  let lastErr;
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
  throw new Error('RPC failed: ' + (lastErr?.message || method));
}

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// One-time use of a reference (only when a KV store is configured)
async function claimReference(ref) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return { enforced: false, ok: true };
  const r = await fetch(`${url}/set/exitdoor:${ref}/used/NX/EX/${REF_TTL_SEC * 2}`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json();
  return { enforced: true, ok: j.result === 'OK' };
}

// ---- Payment verification (same checks as @solana/pay validateTransfer) ----
async function findAndValidate(reference) {
  const sigs = await rpc('getSignaturesForAddress', [reference, { limit: 10, commitment: 'confirmed' }]);
  if (!sigs || !sigs.length) return { status: 'pending' };
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
    if (!tx || tx.meta?.err) continue;
    const keys = tx.transaction.message.accountKeys.map(k => k.pubkey || k);
    if (!keys.includes(reference)) continue;
    const sum = list => (list || []).reduce((t, b) =>
      (b.mint === USDC_MINT && b.owner === WALLET) ? t + BigInt(b.uiTokenAmount.amount) : t, 0n);
    const received = sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
    if (received >= BigInt(PRICE_USDC * 1e6)) return { status: 'ok', signature: s.signature, amount: Number(received) / 1e6 };
    return { status: 'invalid', reason: 'A transaction with this reference was found, but it did not send 1 USDC to the Reality Check wallet.' };
  }
  return { status: 'pending' };
}

// ---- Report pieces. Every piece returns null/"unavailable" rather than guessing. ----
async function slippage(mint, decimals) {
  const out = { price: null, sells: [] };
  try {
    const p = await getJson(`https://lite-api.jup.ag/price/v3?ids=${mint}`);
    out.price = Number(p?.[mint]?.usdPrice) || null;
  } catch {}
  for (const usd of [100, 1000, 10000]) {
    if (!out.price || decimals === null) { out.sells.push({ usd, available: false }); continue; }
    try {
      const amount = BigInt(Math.floor((usd / out.price) * 10 ** decimals));
      const q = await getJson(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${mint}&outputMint=${USDC_MINT}&amount=${amount}&slippageBps=5000`);
      const got = Number(q.outAmount) / 1e6;
      out.sells.push({ usd, available: true, receiveUsd: +got.toFixed(2), lossPct: +(Math.max(0, 1 - got / usd) * 100).toFixed(2), priceImpactPct: +(Number(q.priceImpactPct || 0) * 100).toFixed(2), route: (q.routePlan || []).map(r => r.swapInfo?.label).filter(Boolean).join(' → ') });
    } catch { out.sells.push({ usd, available: false }); }
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
  if (!process.env.RC_REF_SECRET) return res.status(200).json({ success: false, message: 'Exit Door is not configured yet. Free reports are unaffected.' });
  const { action, contract, reference, exp, sig } = req.body || {};
  const mint = String(contract || '').trim();
  if (!isSolAddr(mint)) return res.status(200).json({ success: false, message: 'Enter a Solana token mint address.' });

  if (action === 'request') {
    const acct = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }]).catch(() => null);
    if (acct?.value?.data?.parsed?.type !== 'mint') return res.status(200).json({ success: false, message: 'That address is not a Solana token mint. Nothing was charged.' });
    const ref = b58(crypto.randomBytes(32));
    const expiry = Math.floor(Date.now() / 1000) + REF_TTL_SEC;
    const params = new URLSearchParams({ amount: String(PRICE_USDC), 'spl-token': USDC_MINT, reference: ref, label: 'Reality Check', message: `Exit Door report ${mint.slice(0, 6)}…`, memo: `RC-EXIT-${mint.slice(0, 8)}` });
    return res.status(200).json({ success: true, reference: ref, exp: expiry, sig: sign(ref, mint, expiry), recipient: WALLET, amount: PRICE_USDC, usdcMint: USDC_MINT, url: `solana:${WALLET}?${params.toString()}` });
  }

  if (action === 'report') {
    if (!isSolAddr(reference) || !exp || !sig) return res.status(200).json({ success: false, message: 'Missing payment reference.' });
    const expected = sign(reference, mint, Number(exp));
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return res.status(200).json({ success: false, message: 'This payment request does not match this contract.' });
    }
    if (Math.floor(Date.now() / 1000) > Number(exp)) return res.status(200).json({ success: false, message: 'This payment request expired. Start a new one (no charge if you did not pay).' });
    let pay;
    try { pay = await findAndValidate(reference); } catch { return res.status(200).json({ success: false, pending: true, message: 'Solana RPC is busy — still checking…' }); }
    if (pay.status === 'pending') return res.status(200).json({ success: false, pending: true, message: 'Waiting for your payment to confirm on Solana…' });
    if (pay.status !== 'ok') return res.status(200).json({ success: false, message: pay.reason });
    try {
      const report = await buildReport(mint);
      const claim = await claimReference(reference).catch(() => ({ enforced: false, ok: true }));
      if (!claim.ok) return res.status(200).json({ success: false, message: 'This payment was already used to open a report.' });
      return res.status(200).json({ success: true, paid: { signature: pay.signature, amount: pay.amount }, report,
        riskNote: 'Public on-chain data only (Solana RPC, Jupiter quotes). Anything we could not read is marked unavailable. Not financial advice.' });
    } catch (e) {
      return res.status(200).json({ success: false, paidOk: true, message: 'Payment verified, but the report failed to load. Retry within 30 minutes — your payment still counts.' });
    }
  }
  return res.status(400).json({ success: false, message: 'Unknown action' });
}
