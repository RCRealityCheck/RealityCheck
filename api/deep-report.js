import crypto from 'crypto';
import { buildFull } from './_deep-full.js';
import { solDeep, deployerFacts } from './_sol-deep.js';
import { claimTx, isTxUsed, coinKey, manualMaxAge, MSG } from './_manual-pay.js';
import { createSession, claimSession } from './_checkout.js';
// Premium Deep Report ("Wallet DNA") — $1 USDC per report, any chain.
// AJ's wallets: Solana = DYkdqhQNLQyikuPaNHJczSwcGPYVuGuBafqzXm8wqAvk (Phantom),
// EVM (Eth/BNB/Base/Polygon/Arbitrum) = 0xa214852e96a6d263a14DdA188Fd90395a733b5eA.
// Flow: user pays 1 USDC on their chosen chain, pastes the tx hash/signature.
// Server verifies the payment on-chain, then runs forensic wallet intel.
// All logic server-side. Payments accepted up to 24h old when one-time use is enforced (KV), otherwise 30 min; one-time use of each tx is enforced when KV_REST_API_URL/TOKEN are set (see _manual-pay.js).
// Solana RPC: SOLANA_RPC_URL first (Helius), public fallbacks; retries 'overloaded' responses.
const SOL_RPC_LIST = [process.env.SOLANA_RPC_URL, 'https://api.mainnet-beta.solana.com', 'https://solana.publicnode.com'].filter(Boolean);
async function solCall(method, params, tries = 3) {
  for (let attempt = 0; attempt < tries; attempt++) {
    for (const rpc of SOL_RPC_LIST) {
      try {
        const r = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
        const j = await r.json();
        if (!j.error && j.result !== undefined && j.result !== null) return j.result;
      } catch {}
    }
    await new Promise(r => setTimeout(r, 700 * (attempt + 1)));
  }
  return null;
}
const solLargest = (mint, tries = 3) => solCall('getTokenLargestAccounts', [mint], tries);
async function fullOnly(res, address, chain, paidChainLabel, paidAmount, why) {
  const full = await buildFull(address, chain, {}).catch(() => null);
  return res.status(200).json({
    success: true, paid: true, payChain: paidChainLabel, amountUsdc: +Number(paidAmount).toFixed(2),
    name: full?.project?.name || 'Token', symbol: full?.project?.symbol || '', wallets: [], clusters: [],
    deepVerdict: why, full,
    methodNote: 'Wallet DNA needs holder data, which was not available; every other section is built from the public sources named in it.',
    riskNote: 'Public data only. Not financial advice. Never invest more than you can afford to lose.'
  });
}
const deepClaim = (chain, contract) => { let c = String(contract || '').trim(); if (chain !== 'solana-mainnet') { c = c.toLowerCase(); if (!c.startsWith('0x')) c = '0x' + c; } return 'deep:' + coinKey(chain, c); };
const NOPAY = (why) => `We can't build a full report for this coin yet: ${why} No payment needed — try another coin.`;
async function single(req, res, opts = {}) {
  const PRICE = opts.price || 1;
  const { contract, chain, payChain, txSignature, precheck } = req.body || {};
  if (!contract || !chain) return res.status(400).json({ success: false, message: 'Contract and chain required' });
  if (precheck && chain === 'solana-mainnet') {
    const m = String(contract).trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m)) return res.status(200).json({ success: false, message: 'That does not look like a Solana mint address — no payment needed.' });
    const l = await solLargest(m);
    const n = (l?.value || []).length;
    return res.status(200).json(n ? { success: true, holders: n } : { success: false, message: NOPAY('the Solana network returned no holder list for it right now.') });
  }
  let paidAmount = opts.pre ? 1 : 0;
  let paidChainLabel = opts.pre ? opts.pre.chain : '';
  if (!opts.pre) {
  if (chain === 'solana-mainnet' && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(contract).trim())) {
    return res.status(200).json({ success: false, message: 'That does not look like a Solana mint address. Double-check it before paying — no payment was taken.' });
  }
  if (!opts.trusted) {
    // Manual / one-click payments: only a checkout session (token held by this browser) + exact amount can unlock.
    const c = await claimSession({ sessionId: req.body?.sessionId, token: req.body?.token, claim: opts.claim || deepClaim(chain, contract), txIds: req.body?.txSignatures || txSignature });
    if (!c.ok) return res.status(200).json({ success: false, message: c.message, shortfall: c.shortfall, overpaid: c.overpaid, needCheckout: !!c.needCheckout, pending: !!c.pending });
    paidAmount = c.amount; paidChainLabel = c.chain;
    if (opts.verifyOnly) return res.status(200).json({ success: true, verified: true, reshow: !!c.reshow, amount: paidAmount, chain: paidChainLabel });
  } else {
  // Trusted path: Solana Pay reference flow (bundle), already authorised by the HMAC-signed reference.
  if (!txSignature) return res.status(200).json({ success: false, message: 'Paste your USDC payment transaction hash to unlock the deep report.' });

  const RC_SOL = 'DYkdqhQNLQyikuPaNHJczSwcGPYVuGuBafqzXm8wqAvk';
  const RC_EVM = '0xa214852e96a6d263a14DdA188Fd90395a733b5eA';
  const USDC_SOL_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  // USDC contract addresses verified via CoinGecko (lowercase compare at runtime)
  const PAY_CHAINS = {
    solana:   { label: 'Solana', type: 'solana', usdc: USDC_SOL_MINT, wallet: RC_SOL,
                rpcs: ['https://api.mainnet-beta.solana.com', 'https://solana.publicnode.com'] },
    ethereum: { label: 'Ethereum', type: 'evm', usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6, wallet: RC_EVM,
                rpcs: ['https://eth.llamarpc.com', 'https://ethereum.publicnode.com', 'https://rpc.ankr.com/eth'] },
    bnb:      { label: 'BNB Chain', type: 'evm', usdc: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', decimals: 18, wallet: RC_EVM,
                rpcs: ['https://binance.llamarpc.com', 'https://bsc.publicnode.com', 'https://rpc.ankr.com/bsc'] },
    base:     { label: 'Base', type: 'evm', usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, wallet: RC_EVM,
                rpcs: ['https://base.llamarpc.com', 'https://base.publicnode.com', 'https://rpc.ankr.com/base'] },
    polygon:  { label: 'Polygon', type: 'evm', usdc: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', decimals: 6, wallet: RC_EVM,
                rpcs: ['https://polygon.llamarpc.com', 'https://polygon-bor.publicnode.com', 'https://rpc.ankr.com/polygon'] },
    arbitrum: { label: 'Arbitrum', type: 'evm', usdc: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6, wallet: RC_EVM,
                rpcs: ['https://arbitrum.llamarpc.com', 'https://arbitrum-one.publicnode.com', 'https://rpc.ankr.com/arbitrum'] }
  };
  const sig = String(txSignature).trim();
  const CLAIM = opts.claim || coinKey(chain, contract);
  if (await isTxUsed(sig, CLAIM)) return res.status(200).json({ success: false, message: MSG.used });
  const nowSec = Math.floor(Date.now() / 1000);

  // ---------- 1. Payment verification — auto-detects the chain from the hash ----------
  // Solana signatures are base58 (~88 chars); EVM hashes are 0x + 64 hex.
  // For EVM we probe each supported chain until the transaction is found.
  const isEvmHash = /^0x[a-fA-F0-9]{64}$/.test(sig);
  const isSolSig = /^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(sig);

  const verifySolana = async () => {
    let txj = null;
    for (const rpc of PAY_CHAINS.solana.rpcs) {
      try {
        const r = await fetch(rpc, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }] }),
          signal: AbortSignal.timeout(15000)
        });
        const j = await r.json();
        if (!j.error && j.result) { txj = j.result; break; }
      } catch {}
    }
    if (!txj) return { status: 'not-found' };
    if (txj.meta && txj.meta.err) return { status: 'invalid', reason: 'That transaction failed on-chain — no payment was made.' };
    if (!txj.blockTime || nowSec - txj.blockTime > manualMaxAge()) {
      return { status: 'invalid', reason: MSG.tooOld(manualMaxAge()) };
    }
    const sumUsdc = (list) => (list || []).reduce((s, b) =>
      (b.mint === USDC_SOL_MINT && b.owner === RC_SOL) ? s + Number(b.uiTokenAmount?.uiAmount || 0) : s, 0);
    const received = sumUsdc(txj.meta?.postTokenBalances) - sumUsdc(txj.meta?.preTokenBalances);
    if (received < PRICE - 1e-9) {
      return { status: 'invalid', reason: `That transaction did not send at least ${PRICE} USDC to the Reality Check wallet on Solana.` };
    }
    return { status: 'ok', amount: received, chain: 'Solana' };
  };

  const evmRpc = async (cfg, method, params) => {
    for (const rpc of cfg.rpcs) {
      try {
        const r = await fetch(rpc, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(15000)
        });
        const j = await r.json();
        if (!j.error && j.result !== undefined && j.result !== null) return j.result;
      } catch {}
    }
    return null;
  };

  const verifyEvm = async (cfg) => {
    const receipt = await evmRpc(cfg, 'eth_getTransactionReceipt', [sig]);
    if (!receipt) return { status: 'not-found' };
    if (receipt.status !== '0x1') return { status: 'invalid', reason: 'That transaction failed on-chain — no payment was made.' };
    const block = await evmRpc(cfg, 'eth_getBlockByNumber', [receipt.blockNumber, false]);
    const blockTime = block?.timestamp ? parseInt(block.timestamp, 16) : 0;
    if (!blockTime || nowSec - blockTime > manualMaxAge()) {
      return { status: 'invalid', reason: MSG.tooOld(manualMaxAge()) };
    }
    let decimals = cfg.decimals ?? 6;
    try {
      const decHex = await evmRpc(cfg, 'eth_call', [{ to: cfg.usdc, data: '0x313ce567' }, 'latest']);
      if (decHex && decHex !== '0x') decimals = parseInt(decHex, 16);
    } catch {}
    const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const paddedWallet = '0x000000000000000000000000' + RC_EVM.slice(2).toLowerCase();
    let total = 0n;
    for (const log of (receipt.logs || [])) {
      if ((log.address || '').toLowerCase() !== cfg.usdc.toLowerCase()) continue;
      const topics = log.topics || [];
      if ((topics[0] || '').toLowerCase() !== TRANSFER) continue;
      if ((topics[2] || '').toLowerCase() !== paddedWallet) continue;
      try { total += BigInt(log.data); } catch {}
    }
    const need = 10n ** BigInt(decimals);
    if (total < need * BigInt(PRICE)) {
      return { status: 'invalid', reason: `No ${PRICE} USDC transfer to the Reality Check wallet found in that ${cfg.label} transaction.` };
    }
    return { status: 'ok', amount: Number(total) / Number(need), chain: cfg.label };
  };

  // Explicit chain (one-click pay knows it) or auto-detect (manual paste)
  const explicit = payChain && payChain !== 'auto' ? PAY_CHAINS[payChain] : null;
  let v = null;
  if (explicit) {
    v = explicit.type === 'solana' ? await verifySolana() : await verifyEvm(explicit);
    if (v.status === 'not-found') {
      v = { status: 'invalid', reason: `Transaction not found on ${explicit.label}. Did you pay on a different chain? Try pasting again — we check all chains automatically.` };
    }
  } else if (isEvmHash) {
    v = { status: 'invalid', reason: 'Transaction not found on any supported chain (Solana, Ethereum, Base, BNB, Polygon, Arbitrum). Make sure you sent 1 USDC and pasted the full hash.' };
    for (const key of ['ethereum', 'base', 'bnb', 'polygon', 'arbitrum']) {
      const r = await verifyEvm(PAY_CHAINS[key]);
      if (r.status !== 'not-found') { v = r; break; }
    }
  } else if (isSolSig) {
    v = await verifySolana();
    if (v.status === 'not-found') {
      v = { status: 'invalid', reason: 'Transaction not found on Solana. Double-check the signature.' };
    }
  } else {
    v = { status: 'invalid', reason: "That doesn't look like a complete transaction hash. Copy the FULL hash from your wallet app — it's a long string (starts with 0x on EVM chains)." };
  }
  if (!v || v.status !== 'ok') {
    return res.status(200).json({ success: false, message: v?.reason || 'Payment could not be verified.' });
  }
  paidAmount = v.amount;
  paidChainLabel = v.chain;
  { const claim = await claimTx(sig, CLAIM); if (!claim.ok) return res.status(200).json({ success: false, message: claim.error ? MSG.busy : MSG.used }); }
  if (opts.verifyOnly) return res.status(200).json({ success: true, verified: true, amount: paidAmount, chain: paidChainLabel });
  }
  }

  // ---------- 2. Payment OK — deep wallet forensics ----------
  let clean = String(contract).trim();
  if (chain !== 'solana-mainnet' && !clean.startsWith('0x')) clean = '0x' + clean;
  const hex = clean.startsWith('0x') ? clean.slice(2) : clean;
  if (chain !== 'solana-mainnet' && (hex.length !== 40 || !/^[a-fA-F0-9]+$/.test(hex))) {
    return res.status(200).json({ success: false, message: 'Invalid contract address.' });
  }
  if (chain === 'solana-mainnet') {
    // ---------- Solana deep forensics (public RPC, no key needed) ----------
    const mint = clean;
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
      return res.status(200).json({ success: false, message: 'Invalid Solana mint address.' });
    }
    const solRpc = async (method, params) => {
      for (const rpc of SOL_RPC_LIST) {
        try {
          const r = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
          const j = await r.json();
          if (!j.error && j.result !== undefined && j.result !== null) return j.result;
        } catch {}
      }
      return null;
    };
    try {
      let pairs = [], name = 'Token', symbol = '';
      try {
        const ds = await (await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(10000) })).json();
        pairs = (ds.pairs || []).filter(p => p.chainId === 'solana');
        const p0 = pairs[0];
        if (p0?.baseToken) { name = p0.baseToken.name || name; symbol = (p0.baseToken.symbol || symbol).toUpperCase(); }
      } catch {}
      const sd = await solDeep(mint, solRpc, pairs);
      if (!sd.holders.length) return fullOnly(res, mint, chain, paidChainLabel, paidAmount, 'Holder concentration unknown: ' + (sd.holderNote || 'no holder list right now.') + ' All other sections are below.');
      const personal = sd.holders.filter(h => h.category === 'private');
      const top5 = personal.slice(0, 10);
      const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
      const dna = await Promise.all(top5.map(async (w) => {
        const addr = w.address;
        let ageDays = null, ageMin = false, txCount = 0, funder = null, tokenCount = 0;
        const topHoldings = [];
        try {
          let sigs = await solRpc('getSignaturesForAddress', [addr, { limit: 1000 }]);
          sigs = sigs || [];
          let capped = false;
          if (sigs.length === 1000) {
            const more = await solRpc('getSignaturesForAddress', [addr, { limit: 1000, before: sigs[999].signature }]);
            if (more?.length) sigs = sigs.concat(more);
            capped = sigs.length >= 2000;
          }
          txCount = sigs.length;
          if (capped && sigs.length) { const bt = sigs[sigs.length - 1].blockTime; if (bt) { const ad = Math.max(0, Math.floor((Date.now() - bt * 1000) / 86400000)); if (ad >= 1) { ageDays = ad; ageMin = true; } } }
          if (sigs.length && !capped) {
            const oldest = sigs[sigs.length - 1];
            const tx = await solRpc('getTransaction', [oldest.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
            if (tx?.blockTime) ageDays = Math.max(0, Math.floor((Date.now() - tx.blockTime * 1000) / 86400000));
            const keys = tx?.transaction?.message?.accountKeys || [];
            const pre = tx?.meta?.preBalances || [], post = tx?.meta?.postBalances || [];
            for (let k = 0; k < keys.length; k++) {
              const pk = keys[k].pubkey || keys[k];
              if (pk === addr) continue;
              if (pre[k] !== undefined && post[k] !== undefined && (pre[k] - post[k]) > 5000) { funder = pk; break; }
            }
          }
        } catch {}
        try {
          const ta = await solRpc('getTokenAccountsByOwner', [addr, { programId: TOKEN_PROGRAM }, { encoding: 'jsonParsed' }]);
          const list = ta?.value || [];
          tokenCount = list.length;
          for (const t of list.slice(0, 3)) {
            const m = t?.account?.data?.parsed?.info?.mint;
            if (m) topHoldings.push(m.slice(0, 6) + '…');
          }
        } catch {}
        const flags = [];
        if (ageDays !== null && !ageMin && ageDays < 30) flags.push(`🍼 Only ${ageDays} days old — created right around this token's life`);
        if (tokenCount <= 1) flags.push(`🎯 Holds nothing else — this wallet exists only for this token`);
        if (txCount > 0 && txCount < 10) flags.push(`👻 Barely active — ${txCount} transactions total`);
        if (w.pct >= 20) flags.unshift(`🚩 Holds ${w.pct}% of supply and could sell at any time`);
        else if (w.pct >= 10) flags.unshift(`⚠️ Holds ${w.pct}% of supply`);
        return { address: addr, pct: w.pct, ageDays, ageIsMinimum: ageMin, txCount, txCountCapped: txCount >= 2000, funder, funderNote: funder ? null : (txCount >= 2000 ? 'Not traceable: wallet has more than 2,000 transactions.' : 'Not traceable from its first transaction.'), tokenCount, topHoldings, flags, label: w.label };
      }));
      const clusters = [];
      const byFunder = {};
      const creatorAddr = sd.coinCreator || null;
      dna.forEach((w, i) => { if (w.funder) (byFunder[w.funder] = byFunder[w.funder] || []).push(i); if (creatorAddr && (w.address === creatorAddr || w.funder === creatorAddr) && w.funder !== creatorAddr) (byFunder[creatorAddr] = byFunder[creatorAddr] || []).push(i); });
      for (const [funder, idxs] of Object.entries(byFunder)) {
        if (idxs.length > 1 || (funder === creatorAddr && idxs.length)) {
          const combined = idxs.reduce((s, i) => s + dna[i].pct, 0);
          clusters.push({ funder, members: idxs.map(i => ({ rank: i + 1, address: dna[i].address, pct: dna[i].pct })), combinedPct: +combined.toFixed(2) });
        }
      }
      const young = dna.filter(w => w.ageDays !== null && !w.ageIsMinimum && w.ageDays < 30).length;
      const singleToken = dna.filter(w => w.tokenCount <= 1).length;
      const parts = [];
      const big = dna.filter(w => w.pct >= 20), mid = dna.filter(w => w.pct >= 10 && w.pct < 20);
      const top10p = +personal.slice(0, 10).reduce((s, w) => s + w.pct, 0).toFixed(2);
      big.forEach(w => parts.push(`🚩 RED FLAG: one wallet (${w.address.slice(0, 6)}…${w.address.slice(-4)}) holds ${w.pct}% and could sell at any time.`));
      mid.forEach(w => parts.push(`⚠️ One wallet (${w.address.slice(0, 6)}…${w.address.slice(-4)}) holds ${w.pct}% of supply.`));
      if (top10p >= 50) parts.push(`🚩 RED FLAG: the top 10 private wallets hold ${top10p}% of supply (pools, burn and locks excluded).`);
      if (clusters.length) { const c = clusters[0]; parts.push(`🚨 CLUSTER FOUND: ${c.members.length} of the top wallets were all funded by the same address (${c.funder.slice(0, 10)}…) — they look independent but hold a combined ${c.combinedPct}% as one entity.`); }
      if (young >= 2) parts.push(`🍼 ${young} of the top ${dna.length} private wallets are less than 30 days old — fresh wallets holding big positions is a classic insider pattern.`);
      else if (young === 1) parts.push(`🍼 One top wallet is less than 30 days old — worth watching.`);
      if (singleToken >= 2) parts.push(`🎯 ${singleToken} of the top ${dna.length} private wallets hold NOTHING but this token — wallets created for a single purpose.`);
      else if (singleToken === 1) parts.push(`🎯 One top wallet holds nothing but this token.`);
      if (!parts.length) parts.push(`✅ The top private wallets look like real, established holders — aged wallets with diverse portfolios and no shared funding. Nothing hidden in the DNA.`);
      return res.status(200).json({
        success: true, paid: true, payChain: paidChainLabel, amountUsdc: +Number(paidAmount).toFixed(2),
        name, symbol, wallets: dna, clusters, deepVerdict: parts.join(' '),
        full: await buildFull(mint, chain, { clusters, sol: sd, deployer: await deployerFacts(solRpc, mint, creatorAddr, sd.holders, 'PumpSwap pool record (coin creator)').catch(() => null) }).catch(() => null),
        methodNote: 'Solana wallet age and funder come from each wallet\'s earliest on-chain transaction via public RPC; clustering matches shared funding sources. Heuristics, not proof — but the chain does not lie about timing.',
        riskNote: 'Deep forensic heuristics on public on-chain data. Not financial advice. Never invest more than you can afford to lose.'
      });
    } catch (e) {
      return fullOnly(res, mint, chain, paidChainLabel, paidAmount, 'Wallet DNA failed to load (data provider error). All other sections are below.');
    }
  }
  const COVALENT_KEY = process.env.COVALENT_KEY || '';
  const chainMap = {
    'eth-mainnet': 'eth-mainnet', 'bsc-mainnet': 'bsc-mainnet',
    'avalanche-mainnet': 'avalanche-mainnet', 'base-mainnet': 'base-mainnet',
    'polygon-mainnet': 'matic-mainnet', 'arbitrum-mainnet': 'arbitrum-mainnet'
  };
  const cChain = chainMap[chain] || chain;
  const RPCS = {
    'eth-mainnet': ['https://eth.llamarpc.com', 'https://ethereum.publicnode.com', 'https://rpc.ankr.com/eth'],
    'bsc-mainnet': ['https://binance.llamarpc.com', 'https://bsc.publicnode.com', 'https://rpc.ankr.com/bsc'],
    'avalanche-mainnet': ['https://avalanche.llamarpc.com', 'https://avalanche-c-chain.publicnode.com'],
    'base-mainnet': ['https://base.llamarpc.com', 'https://base.publicnode.com'],
    'polygon-mainnet': ['https://polygon.llamarpc.com', 'https://polygon-bor.publicnode.com'],
    'arbitrum-mainnet': ['https://arbitrum.llamarpc.com', 'https://arbitrum-one.publicnode.com']
  };
  const covGet = async (url) => {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${COVALENT_KEY}` }, signal: AbortSignal.timeout(20000) });
    return r.json();
  };

  try {
    const h = await covGet(`https://api.covalenthq.com/v1/${cChain}/tokens/${clean}/token_holders_v2/`);
    if (!h.data?.items?.length) return fullOnly(res, clean, chain, paidChainLabel, paidAmount, 'Wallet DNA not available: our holder data provider has no holder list for this contract. All other sections are below.');
    const items = h.data.items;
    const total = BigInt(items[0].total_supply || '0');
    const name = items[0].contract_name || 'Token';
    const symbol = items[0].contract_ticker_symbol || '';
    const pctOf = (bal) => total > 0n ? (Number(BigInt(bal || '0') * 10000n / total) / 100) : 0;

    let pairAddrs = new Set();
    try {
      const ds = await (await fetch(`https://api.dexscreener.com/latest/dex/tokens/${clean}`, { signal: AbortSignal.timeout(10000) })).json();
      for (const p of (ds.pairs || [])) if (p.pairAddress) pairAddrs.add(p.pairAddress.toLowerCase());
    } catch {}
    const getCode = async (rpc, address) => {
      try {
        const r = await fetch(rpc, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getCode', params: [address, 'latest'], id: 1 }),
          signal: AbortSignal.timeout(10000)
        });
        const j = await r.json();
        if (j.error || typeof j.result !== 'string') return null;
        return j.result !== '0x' && j.result.length > 2;
      } catch { return null; }
    };
    const BURN = new Set(['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead']);
    const N = 15;
    const topN = items.slice(0, N).map(x => ({ address: x.address, pct: pctOf(x.balance) }));
    const kinds = new Array(N).fill(null);
    const needRpc = [];
    topN.forEach((w, i) => {
      const a = w.address.toLowerCase();
      if (BURN.has(a)) kinds[i] = 'burned';
      else if (pairAddrs.has(a)) kinds[i] = 'liquidity';
      else needRpc.push(i);
    });
    let pending = [...needRpc];
    for (const rpc of (RPCS[chain] || [])) {
      if (!pending.length) break;
      const results = await Promise.all(pending.map(async (idx) => [idx, await getCode(rpc, topN[idx].address)]));
      const still = [];
      for (const [idx, code] of results) {
        if (code === null) still.push(idx);
        else kinds[idx] = code ? 'contract' : 'personal';
      }
      pending = still;
    }
    for (const idx of pending) kinds[idx] = 'unknown';
    const personalWallets = topN
      .map((w, i) => ({ ...w, kind: kinds[i] }))
      .filter(w => w.kind === 'personal' || w.kind === 'unknown')
      .slice(0, 5);

    const dna = await Promise.all(personalWallets.map(async (w) => {
      const addr = w.address;
      let ageDays = null, txCount = 0, funder = null, tokenCount = 0, topHoldings = [];
      try {
        const t1 = await covGet(`https://api.covalenthq.com/v1/${cChain}/address/${addr}/transactions_v2/?page-size=50`);
        txCount = t1.data?.pagination?.total_count ?? (t1.data?.items?.length || 0);
        let oldestItems = t1.data?.items || [];
        if (txCount > 50) {
          const lastPage = Math.floor((txCount - 1) / 50);
          const t2 = await covGet(`https://api.covalenthq.com/v1/${cChain}/address/${addr}/transactions_v2/?page-size=50&page-number=${lastPage}`);
          if (t2.data?.items?.length) oldestItems = t2.data.items;
        }
        if (oldestItems.length) {
          const oldestTx = oldestItems[oldestItems.length - 1];
          if (oldestTx.block_signed_at) {
            ageDays = Math.max(0, Math.floor((Date.now() - new Date(oldestTx.block_signed_at).getTime()) / 86400000));
          }
          const low = addr.toLowerCase();
          for (let i = oldestItems.length - 1; i >= 0; i--) {
            const t = oldestItems[i];
            if ((t.to_address || '').toLowerCase() === low && t.value && Number(t.value) > 0) {
              funder = t.from_address;
              break;
            }
          }
        }
      } catch {}
      try {
        const b = await covGet(`https://api.covalenthq.com/v1/${cChain}/address/${addr}/balances_v2/?no-nft-fetch=true`);
        const toks = (b.data?.items || []).filter(t => !t.is_spam && t.balance && Number(t.balance) > 0);
        tokenCount = toks.length;
        topHoldings = toks.slice(0, 3).map(t => t.contract_ticker_symbol || t.contract_name || 'token');
      } catch {}
      const flags = [];
      if (ageDays !== null && ageDays < 30) flags.push(`🍼 Only ${ageDays} days old — created right around this token's life`);
      if (tokenCount <= 1) flags.push(`🎯 Holds nothing else — this wallet exists only for this token`);
      if (txCount > 0 && txCount < 10) flags.push(`👻 Barely active — ${txCount} transactions total`);
      return { address: addr, pct: +w.pct.toFixed(2), ageDays, txCount, funder, tokenCount, topHoldings, flags };
    }));

    const clusters = [];
    const byFunder = {};
    dna.forEach((w, i) => {
      if (w.funder) {
        const f = w.funder.toLowerCase();
        (byFunder[f] = byFunder[f] || []).push(i);
      }
    });
    for (const [funder, idxs] of Object.entries(byFunder)) {
      if (idxs.length > 1) {
        const combined = idxs.reduce((s, i) => s + dna[i].pct, 0);
        clusters.push({ funder, members: idxs.map(i => ({ rank: i + 1, address: dna[i].address, pct: dna[i].pct })), combinedPct: +combined.toFixed(2) });
      }
    }

    const young = dna.filter(w => w.ageDays !== null && w.ageDays < 30).length;
    const singleToken = dna.filter(w => w.tokenCount <= 1).length;
    const parts = [];
    if (clusters.length) {
      const c = clusters[0];
      parts.push(`🚨 CLUSTER FOUND: ${c.members.length} of the top wallets were all funded by the same address (${c.funder.slice(0, 10)}…) — they look independent but hold a combined ${c.combinedPct}% as one entity.`);
    }
    if (young >= 2) parts.push(`🍼 ${young} of the top 5 wallets are less than 30 days old — fresh wallets holding big positions is a classic insider pattern.`);
    else if (young === 1) parts.push(`🍼 One top wallet is less than 30 days old — worth watching.`);
    if (singleToken >= 2) parts.push(`🎯 ${singleToken} of the top 5 wallets hold NOTHING but this token — wallets created for a single purpose.`);
    else if (singleToken === 1) parts.push(`🎯 One top wallet holds nothing but this token.`);
    if (!parts.length) parts.push(`✅ The top wallets look like real, established holders — aged wallets with diverse portfolios and no shared funding. Nothing hidden in the DNA.`);
    const deepVerdict = parts.join(' ');

    res.status(200).json({
      success: true,
      paid: true,
      payChain: paidChainLabel,
      amountUsdc: +Number(paidAmount).toFixed(2),
      name, symbol,
      wallets: dna,
      clusters,
      deepVerdict,
      full: await buildFull(clean, chain, { clusters }).catch(() => null),
      methodNote: 'Wallet age and funder come from each wallet\'s earliest on-chain transaction; clustering matches shared funding sources. Heuristics, not proof — but the chain does not lie about timing.',
      riskNote: 'Deep forensic heuristics on public on-chain data. Not financial advice. Never invest more than you can afford to lose.'
    });
  } catch (e) {
    return fullOnly(res, clean, chain, paidChainLabel, paidAmount, 'Wallet DNA failed to load (data provider error). All other sections are below.');
  }
}

// ---------- Bundle: 1-5 coins, ONE payment of exactly $1 x N, each coin gets its own Deep Report ----------
const RC_SOL_W = 'DYkdqhQNLQyikuPaNHJczSwcGPYVuGuBafqzXm8wqAvk';
const USDC_SPL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const B58A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (buf) => { let n = BigInt('0x' + Buffer.from(buf).toString('hex')), s = ''; while (n > 0n) { s = B58A[Number(n % 58n)] + s; n /= 58n; } for (const x of buf) { if (x === 0) s = '1' + s; else break; } return s; };
const call = (fn, body, opts) => new Promise((resolve) => {
  const r = { status() { return r; }, json(j) { resolve(j); return r; }, send(x) { resolve({ success: false, message: String(x) }); return r; } };
  Promise.resolve(fn({ method: 'POST', body }, r, opts)).catch(() => resolve({ success: false, message: 'This report failed to load (data provider error).' }));
});
function normList(coins) {
  if (!Array.isArray(coins) || coins.length < 1 || coins.length > 5) return null;
  const out = []; const seen = new Set();
  for (const c of coins) {
    const chain = String(c?.chain || ''); let contract = String(c?.contract || '').trim();
    if (!chain || !contract) return null;
    if (chain !== 'solana-mainnet') contract = contract.toLowerCase();
    const k = coinKey(chain, contract); if (seen.has(k)) return null; seen.add(k); out.push({ chain, contract, k });
  }
  return out;
}
const listKey = (list) => 'bundle:' + list.map(x => x.k).sort().join(',');
const bsign = (ref, lk, exp, n) => crypto.createHmac('sha256', process.env.RC_REF_SECRET).update(`deepbundle|${ref}|${lk}|${exp}|${n}|${RC_SOL_W}`).digest('hex');
async function precheckOne(host, c) {
  if (c.chain === 'solana-mainnet') return call(single, { contract: c.contract, chain: c.chain, precheck: true });
  try {
    const r = await fetch(`https://${host}/api/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contract: c.contract, chain: c.chain }), signal: AbortSignal.timeout(60000) });
    const j = await r.json();
    return j.success ? { success: true } : { success: false, message: NOPAY(j.message || 'we could not read its holder data.') };
  } catch { return { success: false, message: NOPAY('our data check could not reach the server.') }; }
}
async function bundle(req, res) {
  const { action, coins, reference, exp, sig, txSignature, payChain } = req.body || {};
  const list = normList(coins);
  if (!list) return res.status(200).json({ success: false, message: 'Add 1 to 5 different coins (address + chain) to your list.' });
  const N = list.length, lk = listKey(list);
  const host = req.headers?.host || 'www.realitycheckglobal.trade';
  if (action === 'bundle-precheck' || action === 'bundle-request') {
    const results = await Promise.all(list.map(c => precheckOne(host, c)));
    const failed = results.map((r, i) => r.success ? null : { index: i, contract: list[i].contract, chain: list[i].chain, message: r.message || NOPAY('no data.') }).filter(Boolean);
    if (failed.length) return res.status(200).json({ success: false, failed, message: 'Some coins in your list cannot be reported yet. Remove or swap them — no payment needed for those.' });
    if (action === 'bundle-precheck') return res.status(200).json({ success: true, count: N, totalUsdc: N });
    if (!process.env.RC_REF_SECRET) return res.status(200).json({ success: false, message: 'Bundle payments are not configured yet.' });
    const ref = b58(crypto.randomBytes(32)); const e = Math.floor(Date.now() / 1000) + 1800;
    const p = new URLSearchParams({ amount: String(N), 'spl-token': USDC_SPL, reference: ref, label: 'Reality Check', message: `Deep Report x${N} coins`, memo: `RC-DEEP-x${N}` });
    return res.status(200).json({ success: true, count: N, totalUsdc: N, reference: ref, exp: e, sig: bsign(ref, lk, e, N), recipient: RC_SOL_W, url: `solana:${RC_SOL_W}?${p.toString()}` });
  }
  if (action !== 'bundle-report') return res.status(400).json({ success: false, message: 'Unknown action' });
  if (req.body?.sessionId || txSignature) {
    // Manual pay for a bundle: checkout session + exact amount (tx ID alone never unlocks).
    const v = await call(single, { contract: list[0].contract, chain: list[0].chain, txSignature, txSignatures: req.body?.txSignatures, sessionId: req.body?.sessionId, token: req.body?.token }, { price: N, claim: 'deepbundle:' + lk, verifyOnly: true });
    if (!v.success) return res.status(200).json(v);
    const reports = await Promise.all(list.map(c => call(single, { contract: c.contract, chain: c.chain }, { pre: { chain: v.chain } })));
    return res.status(200).json({ success: true, reshow: !!v.reshow, paid: { amount: v.amount, chain: v.chain }, reports: reports.map((r, i) => ({ contract: list[i].contract, chain: list[i].chain, ...r })) });
  }
  let paySig = '';
  let pc = payChain || 'auto';
  {
    if (!reference || !exp || !sig) return res.status(200).json({ success: false, message: 'Missing payment reference.' });
    const expected = bsign(String(reference), lk, Number(exp), N);
    if (String(sig).length !== expected.length || !crypto.timingSafeEqual(Buffer.from(String(sig)), Buffer.from(expected))) return res.status(200).json({ success: false, message: 'This payment request does not match this list of coins.' });
    if (Math.floor(Date.now() / 1000) > Number(exp) + 600) return res.status(200).json({ success: false, message: 'This payment request expired. Start a new one (no charge if you did not pay).' });
    const sigs = await solCall('getSignaturesForAddress', [String(reference), { limit: 5, commitment: 'confirmed' }], 2);
    if (!sigs || !sigs.length) return res.status(200).json({ success: false, pending: true, message: 'Waiting for your payment to confirm on Solana…' });
    paySig = sigs[sigs.length - 1].signature; pc = 'solana';
  }
  const v = await call(single, { contract: list[0].contract, chain: list[0].chain, payChain: pc, txSignature: paySig }, { price: N, claim: lk, verifyOnly: true, trusted: true });
  if (!v.success) return res.status(200).json({ success: false, message: (v.message || 'Payment could not be verified.') + (N > 1 ? ` This list needs ${N} USDC in one payment.` : '') });
  const reports = await Promise.all(list.map(c => call(single, { contract: c.contract, chain: c.chain }, { pre: { chain: v.chain } })));
  return res.status(200).json({ success: true, paid: { amount: v.amount, chain: v.chain, signature: paySig }, reports: reports.map((r, i) => ({ contract: list[i].contract, chain: list[i].chain, ...r })) });
}
async function checkout(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const b = req.body || {};
  const ip = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  let claim, price;
  if (b.kind === 'bundle') {
    const list = normList(b.coins);
    if (!list) return res.status(200).json({ success: false, message: 'Add 1 to 5 different coins (address + chain) to your list.' });
    claim = 'deepbundle:' + listKey(list); price = list.length;
  } else {
    const chain = String(b.chain || ''), c = String(b.contract || '').trim();
    const okAddr = chain === 'solana-mainnet' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(c) : /^(0x)?[a-fA-F0-9]{40}$/.test(c);
    if (!chain || !okAddr) return res.status(200).json({ success: false, message: 'Enter a valid contract address first. No payment was taken.' });
    claim = deepClaim(chain, c); price = 1;
  }
  const s = await createSession({ claim, price, ip, prevId: b.sessionId, prevToken: b.token });
  return res.status(200).json(s.ok ? { success: true, ...s } : { success: false, message: s.message });
}
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Use POST' });
  const a = req.body?.action;
  if (a === 'bundle-precheck' || a === 'bundle-request' || a === 'bundle-report') return bundle(req, res);
  if (a === 'checkout') return checkout(req, res);
  return single(req, res);
}
