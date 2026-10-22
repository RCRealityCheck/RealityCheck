import crypto from 'crypto';
import { buildFull } from './_deep-full.js';
import { claimTx, isTxUsed, coinKey, manualMaxAge, MSG } from './_manual-pay.js';
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
  if (!txSignature) return res.status(200).json({ success: false, message: 'Paste your USDC payment transaction hash to unlock the deep report.' });
  if (chain === 'solana-mainnet' && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(contract).trim())) {
    return res.status(200).json({ success: false, message: 'That does not look like a Solana mint address. Double-check it before paying — no payment was taken.' });
  }

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
      const supply = await solRpc('getTokenSupply', [mint]);
      const totalUi = Number(supply?.value?.uiAmountString || supply?.value?.uiAmount || 0);
      const largest = await solLargest(mint, 6);
      const accts = (largest?.value || []).slice(0, 15);
      if (!accts.length) return fullOnly(res, mint, chain, paidChainLabel, paidAmount, 'Wallet DNA not available: Solana RPC returned no holder list right now. All other sections are below.');
      const ownersRes = await solRpc('getMultipleAccounts', [accts.map(a => a.address), { encoding: 'jsonParsed' }]);
      const ownerOf = (accts || []).map((a, i) => ownersRes?.value?.[i]?.data?.parsed?.info?.owner || null);
      const uniqOwners = [...new Set(ownerOf.filter(Boolean))];
      const ownerInfo = await solRpc('getMultipleAccounts', [uniqOwners, { encoding: 'json' }]);
      const execByOwner = {};
      (ownerInfo?.value || []).forEach((acc, i) => { execByOwner[uniqOwners[i]] = !!acc?.executable; });
      let name = 'Token', symbol = '';
      try {
        const ds = await (await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(10000) })).json();
        const p0 = (ds.pairs || [])[0];
        if (p0?.baseToken) { name = p0.baseToken.name || name; symbol = p0.baseToken.symbol || symbol; }
      } catch {}
      const SYSTEM = '11111111111111111111111111111111';
      const pctOf = (ui) => totalUi > 0 ? +(ui / totalUi * 100).toFixed(2) : 0;
      const seen = new Set();
      const personal = [];
      accts.forEach((a, i) => {
        const owner = ownerOf[i];
        const ui = Number(a.uiAmountString ?? a.uiAmount ?? 0);
        let kind = 'personal';
        if (!owner) kind = 'unknown';
        else if (owner === SYSTEM) kind = 'burned';
        else if (execByOwner[owner]) kind = 'liquidity';
        if ((kind === 'personal' || kind === 'unknown') && !seen.has(owner || a.address)) {
          seen.add(owner || a.address);
          personal.push({ address: owner || a.address, pct: pctOf(ui), kind });
        }
      });
      const top5 = personal.slice(0, 5);
      const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
      const dna = await Promise.all(top5.map(async (w) => {
        const addr = w.address;
        let ageDays = null, txCount = 0, funder = null, tokenCount = 0;
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
        if (ageDays !== null && ageDays < 30) flags.push(`🍼 Only ${ageDays} days old — created right around this token's life`);
        if (tokenCount <= 1) flags.push(`🎯 Holds nothing else — this wallet exists only for this token`);
        if (txCount > 0 && txCount < 10) flags.push(`👻 Barely active — ${txCount} transactions total`);
        return { address: addr, pct: w.pct, ageDays, txCount, funder, tokenCount, topHoldings, flags };
      }));
      const clusters = [];
      const byFunder = {};
      dna.forEach((w, i) => { if (w.funder) (byFunder[w.funder] = byFunder[w.funder] || []).push(i); });
      for (const [funder, idxs] of Object.entries(byFunder)) {
        if (idxs.length > 1) {
          const combined = idxs.reduce((s, i) => s + dna[i].pct, 0);
          clusters.push({ funder, members: idxs.map(i => ({ rank: i + 1, address: dna[i].address, pct: dna[i].pct })), combinedPct: +combined.toFixed(2) });
        }
      }
      const young = dna.filter(w => w.ageDays !== null && w.ageDays < 30).length;
      const singleToken = dna.filter(w => w.tokenCount <= 1).length;
      const parts = [];
      if (clusters.length) { const c = clusters[0]; parts.push(`🚨 CLUSTER FOUND: ${c.members.length} of the top wallets were all funded by the same address (${c.funder.slice(0, 10)}…) — they look independent but hold a combined ${c.combinedPct}% as one entity.`); }
      if (young >= 2) parts.push(`🍼 ${young} of the top 5 wallets are less than 30 days old — fresh wallets holding big positions is a classic insider pattern.`);
      else if (young === 1) parts.push(`🍼 One top wallet is less than 30 days old — worth watching.`);
      if (singleToken >= 2) parts.push(`🎯 ${singleToken} of the top 5 wallets hold NOTHING but this token — wallets created for a single purpose.`);
      else if (singleToken === 1) parts.push(`🎯 One top wallet holds nothing but this token.`);
      if (!parts.length) parts.push(`✅ The top wallets look like real, established holders — aged wallets with diverse portfolios and no shared funding. Nothing hidden in the DNA.`);
      return res.status(200).json({
        success: true, paid: true, payChain: paidChainLabel, amountUsdc: +Number(paidAmount).toFixed(2),
        name, symbol, wallets: dna, clusters, deepVerdict: parts.join(' '), full: await buildFull(mint, chain, { clusters }).catch(() => null),
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
  let paySig = txSignature ? String(txSignature).trim() : '';
  let pc = payChain || 'auto';
  if (!paySig) {
    if (!reference || !exp || !sig) return res.status(200).json({ success: false, message: 'Missing payment reference.' });
    const expected = bsign(String(reference), lk, Number(exp), N);
    if (String(sig).length !== expected.length || !crypto.timingSafeEqual(Buffer.from(String(sig)), Buffer.from(expected))) return res.status(200).json({ success: false, message: 'This payment request does not match this list of coins.' });
    if (Math.floor(Date.now() / 1000) > Number(exp) + 600) return res.status(200).json({ success: false, message: 'This payment request expired. Start a new one (no charge if you did not pay).' });
    const sigs = await solCall('getSignaturesForAddress', [String(reference), { limit: 5, commitment: 'confirmed' }], 2);
    if (!sigs || !sigs.length) return res.status(200).json({ success: false, pending: true, message: 'Waiting for your payment to confirm on Solana…' });
    paySig = sigs[sigs.length - 1].signature; pc = 'solana';
  }
  const v = await call(single, { contract: list[0].contract, chain: list[0].chain, payChain: pc, txSignature: paySig }, { price: N, claim: lk, verifyOnly: true });
  if (!v.success) return res.status(200).json({ success: false, message: (v.message || 'Payment could not be verified.') + (N > 1 ? ` This list needs ${N} USDC in one payment.` : '') });
  const reports = await Promise.all(list.map(c => call(single, { contract: c.contract, chain: c.chain }, { pre: { chain: v.chain } })));
  return res.status(200).json({ success: true, paid: { amount: v.amount, chain: v.chain, signature: paySig }, reports: reports.map((r, i) => ({ contract: list[i].contract, chain: list[i].chain, ...r })) });
}
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Use POST' });
  const a = req.body?.action;
  if (a === 'bundle-precheck' || a === 'bundle-request' || a === 'bundle-report') return bundle(req, res);
  return single(req, res);
}
