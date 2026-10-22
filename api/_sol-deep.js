// Solana holder forensics for the Deep Report: holders resolved to owners and categorised
// (pool / lock / burn / program / private), deployer facts, LP status per pool.
// Real on-chain data only; every unknown is returned with a plain reason.
const SYSTEM = '11111111111111111111111111111111';
const BURN_OWNERS = new Set(['1nc1nerator11111111111111111111111111111111', SYSTEM]);
export const AMM = {
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: 'PumpSwap',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'pump.fun bonding curve',
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'Meteora DLMM',
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: 'Meteora DAMM v2',
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: 'Meteora pools',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM v4',
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: 'Raydium CPMM',
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'Raydium CLMM',
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'Orca Whirlpool'
};
export const LOCKS = { strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m: 'Streamflow', LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn: 'Jupiter Lock' };
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (buf) => { let n = BigInt('0x' + (Buffer.from(buf).toString('hex') || '0')), s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const x of buf) { if (x === 0) s = '1' + s; else break; } return s; };
const days = (t) => t ? Math.max(0, Math.floor((Date.now() - t * 1000) / 86400000)) : null;

// First-seen data for a wallet: up to `pages` x 1000 signatures.
export async function firstSeen(rpc, addr, pages = 2) {
  let sigs = [], before;
  for (let p = 0; p < pages; p++) {
    const s = await rpc('getSignaturesForAddress', [addr, { limit: 1000, ...(before ? { before } : {}) }]);
    if (!s || !s.length) break;
    sigs = sigs.concat(s); before = s[s.length - 1].signature;
    if (s.length < 1000) break;
  }
  const capped = sigs.length >= pages * 1000;
  const oldest = sigs[sigs.length - 1];
  return { txCount: sigs.length, capped, oldest, ageDays: days(oldest?.blockTime), };
}

export async function solDeep(mint, rpc, pairs = []) {
  const out = { holders: [], holderNote: null, deployer: null, lp: [], distribution: null };
  const [supply, largest] = await Promise.all([rpc('getTokenSupply', [mint]), rpc('getTokenLargestAccounts', [mint])]);
  const totalUi = Number(supply?.value?.uiAmountString || 0);
  const accts = (largest?.value || []).slice(0, 20);
  if (!accts.length || !totalUi) { out.holderNote = 'Holder data not available: the Solana network did not return the largest-holder list for this token right now.'; }
  const poolAddr = new Map(pairs.map(p => [p.pairAddress, p.dexId]));
  if (accts.length && totalUi) {
    const ta = await rpc('getMultipleAccounts', [accts.map(a => a.address), { encoding: 'jsonParsed' }]);
    const owners = accts.map((a, i) => ta?.value?.[i]?.data?.parsed?.info?.owner || null);
    const uniq = [...new Set(owners.filter(Boolean))];
    const oi = uniq.length ? await rpc('getMultipleAccounts', [uniq, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]) : null;
    const prog = {}; (oi?.value || []).forEach((v, i) => { prog[uniq[i]] = v ? { program: v.owner, exec: !!v.executable, sol: v.lamports / 1e9 } : { program: null, exec: false, sol: 0 }; });
    const byOwner = new Map();
    accts.forEach((a, i) => {
      const owner = owners[i] || a.address; const ui = Number(a.uiAmountString ?? a.uiAmount ?? 0);
      const e = byOwner.get(owner) || { address: owner, ui: 0 }; e.ui += ui; byOwner.set(owner, e);
    });
    for (const h of byOwner.values()) {
      const p = prog[h.address] || {};
      h.pct = +(h.ui / totalUi * 100).toFixed(2); delete h.ui;
      if (BURN_OWNERS.has(h.address)) { h.category = 'burn'; h.label = 'Burn address'; }
      else if (poolAddr.has(h.address)) { h.category = 'pool'; h.label = `Liquidity pool (${poolAddr.get(h.address)})`; }
      else if (p.program && AMM[p.program]) { h.category = 'pool'; h.label = `Liquidity pool (${AMM[p.program]})`; }
      else if (p.program && LOCKS[p.program]) { h.category = 'lock'; h.label = `Locked (${LOCKS[p.program]})`; }
      else if (p.exec || (p.program && p.program !== SYSTEM)) { h.category = 'program'; h.label = 'Program-owned account (unlabelled)'; }
      else { h.category = 'private'; h.label = 'Private wallet (unlabelled — could be an exchange)'; h.sol = p.sol ?? null; }
      out.holders.push(h);
    }
    out.holders.sort((a, b) => b.pct - a.pct);
    const sum = (c) => +out.holders.filter(h => h.category === c).reduce((s, h) => s + h.pct, 0).toFixed(2);
    const covered = +out.holders.reduce((s, h) => s + h.pct, 0).toFixed(2);
    out.distribution = { coveredPct: covered, poolsPct: sum('pool'), lockedPct: sum('lock'), burnedPct: sum('burn'), programPct: sum('program'), privatePct: sum('private'), exchangesPct: null,
      exchangeNote: 'No verified exchange-wallet list is used, so exchange wallets appear as unlabelled private wallets.', note: `Based on the top ${accts.length} token accounts (${covered}% of supply); the rest is spread across smaller holders.` };
  }

  // LP status per pool (top 6 by liquidity)
  const pools = pairs.slice().sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)).slice(0, 6);
  const pinfo = pools.length ? await rpc('getMultipleAccounts', [pools.map(p => p.pairAddress), { encoding: 'base64' }]) : null;
  let coinCreator = null;
  out.lp = await Promise.all(pools.map(async (p, i) => {
    const acc = pinfo?.value?.[i]; const program = acc?.owner || null;
    const base = { dex: AMM[program] || p.dexId, address: p.pairAddress, liquidityUsd: p.liquidity?.usd ?? null };
    if (program === 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA') {
      try {
        const d = Buffer.from(acc.data[0], 'base64');
        const lpMint = b58(d.subarray(107, 139)); const lpSupplyRec = d.readBigUInt64LE(203); const cc = d.length >= 243 ? b58(d.subarray(211, 243)) : null;
        if (cc && !coinCreator) coinCreator = cc;
        const s = await rpc('getTokenSupply', [lpMint]); const live = s ? BigInt(s.value.amount) : null;
        if (live === 0n && lpSupplyRec > 0n) return { ...base, status: 'burned', detail: 'All LP tokens for this pool have been burned — the pooled liquidity cannot be withdrawn by an LP holder.' };
        if (live === null) return { ...base, status: 'unknown', detail: 'Could not read the LP token supply right now.' };
        const lg = await rpc('getTokenLargestAccounts', [lpMint]); const top = lg?.value?.[0];
        if (!top) return { ...base, status: 'unknown', detail: 'LP token holders could not be read right now.' };
        const t = await rpc('getAccountInfo', [top.address, { encoding: 'jsonParsed' }]); const ow = t?.value?.data?.parsed?.info?.owner;
        const share = Number(BigInt(top.amount) * 10000n / (live || 1n)) / 100;
        if (BURN_OWNERS.has(ow)) return { ...base, status: 'burned', detail: `${share}% of LP tokens sit in a burn address.` };
        return { ...base, status: `held by wallet ${ow ? ow.slice(0, 6) + '…' + ow.slice(-4) : 'unknown'}`, holder: ow || null, detail: `${share}% of this pool's LP tokens are held by one wallet — that liquidity could be withdrawn.` };
      } catch { return { ...base, status: 'unknown', detail: 'Pool data could not be parsed.' }; }
    }
    if (program === 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo' || program === 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK' || program === 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc')
      return { ...base, status: 'not lockable', detail: 'Concentrated-liquidity pool: there is no LP token to burn or lock; each liquidity provider can withdraw their own position.' };
    return { ...base, status: 'unknown', detail: 'LP lock status for this pool type is not read automatically.' };
  }));
  out.coinCreator = coinCreator;
  return out;
}

export async function deployerFacts(rpc, mint, creator, holders, source) {
  if (!creator) return { address: null, note: 'Creator wallet not available: no free source returned it for this token.' };
  const [bal, ta, fs] = await Promise.all([
    rpc('getBalance', [creator]),
    rpc('getTokenAccountsByOwner', [creator, { mint }, { encoding: 'jsonParsed' }]),
    firstSeen(rpc, creator, 2).catch(() => null)
  ]);
  const supply = await rpc('getTokenSupply', [mint]);
  const totalUi = Number(supply?.value?.uiAmountString || 0);
  const held = (ta?.value || []).reduce((s, a) => s + Number(a.account?.data?.parsed?.info?.tokenAmount?.uiAmountString || 0), 0);
  const pct = ta && totalUi ? +(held / totalUi * 100).toFixed(2) : null;
  return {
    address: creator, source,
    solBalance: bal?.value != null ? +(bal.value / 1e9).toFixed(3) : null,
    ageDays: fs?.ageDays ?? null, ageIsMinimum: !!fs?.capped, txCount: fs?.txCount ?? null,
    currentPct: pct,
    soldNote: pct === 0 ? 'The creator holds 0% of this token now — they sold or moved everything they had.' : pct === null ? 'Current creator holding could not be read.' : `The creator still holds ${pct}%.`,
    otherLaunches: null, otherLaunchesNote: 'Other tokens this creator launched: data not available from free sources.'
  };
}
