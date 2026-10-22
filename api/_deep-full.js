// Full-truth sections for the paid Deep Report. Every section names its source and
// returns null / 'not available' fields instead of guessing. Shared by EVM and Solana.
const T = 12000;
const getJson = async (url, opts = {}) => {
  try {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(opts.timeout || T) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
};
const GOPLUS_ID = { 'eth-mainnet': '1', 'bsc-mainnet': '56', 'base-mainnet': '8453', 'polygon-mainnet': '137', 'arbitrum-mainnet': '42161', 'avalanche-mainnet': '43114' };
const CG_PLATFORM = { 'eth-mainnet': 'ethereum', 'bsc-mainnet': 'binance-smart-chain', 'base-mainnet': 'base', 'polygon-mainnet': 'polygon-pos', 'arbitrum-mainnet': 'arbitrum-one', 'avalanche-mainnet': 'avalanche', 'solana-mainnet': 'solana' };
const DS_CHAIN = { 'eth-mainnet': 'ethereum', 'bsc-mainnet': 'bsc', 'base-mainnet': 'base', 'polygon-mainnet': 'polygon', 'arbitrum-mainnet': 'arbitrum', 'avalanche-mainnet': 'avalanche', 'solana-mainnet': 'solana' };
const EXPLORER = { 'eth-mainnet': 'https://etherscan.io/address/', 'bsc-mainnet': 'https://bscscan.com/address/', 'base-mainnet': 'https://basescan.org/address/', 'polygon-mainnet': 'https://polygonscan.com/address/', 'arbitrum-mainnet': 'https://arbiscan.io/address/', 'avalanche-mainnet': 'https://snowtrace.io/address/', 'solana-mainnet': 'https://solscan.io/account/' };
// Known LP lockers (EVM) and lock / vesting programs (Solana), matched on GoPlus labels.
const LOCKER_WORDS = /unicrypt|uncx|team\.?finance|pinklock|pinksale|gempad|mudra|deeplock|trustswap|floki|dxlock|streamflow|jupiter lock|bonfida|lock/i;
const BURN = new Set(['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead', '11111111111111111111111111111111']);
const CEX_WORDS = /binance|coinbase|okx|okex|bybit|kraken|kucoin|gate\.?io|bitget|htx|huobi|mexc|crypto\.com|bitfinex|upbit|bithumb|exchange/i;
const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : Number(v);
const flag = v => v === '1' ? true : v === '0' ? false : null;
const daysAgo = d => d ? Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86400000)) : null;

async function goplus(address, chain) {
  if (chain === 'solana-mainnet') {
    const j = await getJson(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${address}`);
    return j?.result ? Object.values(j.result)[0] || null : null;
  }
  const id = GOPLUS_ID[chain];
  if (!id) return null;
  const j = await getJson(`https://api.gopluslabs.io/api/v1/token_security/${id}?contract_addresses=${address}`);
  return j?.result ? (j.result[address.toLowerCase()] || Object.values(j.result)[0] || null) : null;
}

async function githubActivity(repoUrls) {
  const urls = (repoUrls || []).filter(u => /github\.com\//i.test(u)).slice(0, 3);
  const h = { headers: { 'User-Agent': 'RealityCheck', Accept: 'application/vnd.github+json' } };
  for (const u of urls) {
    const m = u.match(/github\.com\/([^/?#]+)(?:\/([^/?#]+))?/i);
    if (!m) continue;
    const owner = m[1]; let repo = m[2];
    if (!repo) {
      const repos = await getJson(`https://api.github.com/users/${owner}/repos?sort=pushed&per_page=1`, h);
      repo = repos?.[0]?.name;
      if (!repo) continue;
    }
    const info = await getJson(`https://api.github.com/repos/${owner}/${repo}`, h);
    if (!info) continue;
    return { repo: `${owner}/${repo}`, url: info.html_url, lastPush: info.pushed_at, lastPushDaysAgo: daysAgo(info.pushed_at), stars: info.stargazers_count, archived: !!info.archived, source: 'GitHub API' };
  }
  return null;
}

async function siteStatus(url) {
  if (!url) return null;
  try {
    const r = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0 RealityCheck' } });
    return { url, up: r.status < 500, status: r.status, note: r.status >= 400 && r.status < 500 ? 'Site responded but blocked our automated check (still online).' : null };
  } catch { return { url, up: false, status: null, note: null }; }
}

export async function buildFull(address, chain, ctx = {}) {
  const [gp, cg, ds] = await Promise.all([
    goplus(address, chain),
    getJson(`https://api.coingecko.com/api/v3/coins/${CG_PLATFORM[chain]}/contract/${address}?localization=false&tickers=false&community_data=false&sparkline=false`),
    getJson(`https://api.dexscreener.com/latest/dex/tokens/${address}`)
  ]);
  const pairs = (ds?.pairs || []).filter(p => p.chainId === DS_CHAIN[chain]);
  const isSol = chain === 'solana-mainnet';

  // 1. Project & team
  const info = pairs.find(p => p.info)?.info || {};
  const links = cg?.links || {};
  const website = (links.homepage || []).find(Boolean) || info.websites?.[0]?.url || null;
  const socials = [];
  if (links.twitter_screen_name) socials.push({ type: 'X / Twitter', url: `https://x.com/${links.twitter_screen_name}` });
  if (links.telegram_channel_identifier) socials.push({ type: 'Telegram', url: /^https?:/.test(links.telegram_channel_identifier) ? links.telegram_channel_identifier : `https://t.me/${links.telegram_channel_identifier}` });
  (info.socials || []).forEach(s => { if (s.url && !socials.some(x => x.url === s.url)) socials.push({ type: s.type || 'social', url: s.url }); });
  (links.chat_url || []).filter(Boolean).forEach(u => socials.push({ type: 'Community', url: u }));
  const project = {
    name: cg?.name || pairs[0]?.baseToken?.name || gp?.token_name || null,
    symbol: (cg?.symbol || pairs[0]?.baseToken?.symbol || gp?.token_symbol || '').toUpperCase() || null,
    website, socials: socials.slice(0, 8),
    description: (cg?.description?.en || '').replace(/<[^>]+>/g, '').slice(0, 400) || null,
    countryOrigin: cg?.country_origin || null,
    genesisDate: cg?.genesis_date || null,
    categories: (cg?.categories || []).filter(Boolean).slice(0, 5),
    team: null,
    teamNote: 'No public data source verifies team identities. Check the official website and socials yourself.',
    sources: [cg ? 'CoinGecko' : null, pairs.length ? 'DexScreener' : null].filter(Boolean)
  };

  // 2. Deployer / owner
  let owner;
  if (isSol) {
    const mintAuth = gp?.mintable ? (gp.mintable.authority?.[0]?.address || (gp.mintable.status === '1' ? 'active' : null)) : undefined;
    const freezeAuth = gp?.freezable ? (gp.freezable.authority?.[0]?.address || (gp.freezable.status === '1' ? 'active' : null)) : undefined;
    owner = {
      owner: null, creator: gp?.creators?.[0]?.address || null,
      mintAuthority: mintAuth === undefined ? null : mintAuth, freezeAuthority: freezeAuth === undefined ? null : freezeAuth,
      renounced: (mintAuth === undefined || freezeAuth === undefined) ? null : (!mintAuth && !freezeAuth),
      metadataMutable: gp?.metadata_mutable ? gp.metadata_mutable.status === '1' : null,
      linkedWallets: ctx.clusters || [], explorer: EXPLORER[chain],
      sources: gp ? ['GoPlus'] : []
    };
  } else {
    const ownerAddr = gp?.owner_address || null;
    owner = {
      owner: ownerAddr, creator: gp?.creator_address || null,
      creatorPercent: num(gp?.creator_percent) !== null ? +(num(gp.creator_percent) * 100).toFixed(2) : null,
      renounced: gp ? (!ownerAddr || BURN.has(ownerAddr.toLowerCase())) : null,
      canTakeBackOwnership: flag(gp?.can_take_back_ownership), hiddenOwner: flag(gp?.hidden_owner),
      sameCreatorHoneypots: gp?.honeypot_with_same_creator !== undefined ? flag(gp.honeypot_with_same_creator) : null,
      linkedWallets: ctx.clusters || [], explorer: EXPLORER[chain],
      sources: gp ? ['GoPlus'] : []
    };
  }

  // 3. Liquidity
  const lp = isSol ? [] : (gp?.lp_holders || []);
  let lockedLp = 0, burnedLp = 0, knownLp = 0;
  lp.forEach(h => {
    const pct = num(h.percent) || 0; knownLp += pct;
    if (BURN.has(String(h.address).toLowerCase())) burnedLp += pct;
    else if (h.is_locked === 1 || h.is_locked === '1' || LOCKER_WORDS.test(h.tag || '')) lockedLp += pct;
  });
  const solBurn = isSol && gp?.dex?.length ? gp.dex.map(d => ({ dex: d.dex_name, pool: d.id, burnPercent: num(d.burn_percent) })) : null;
  const liquidity = {
    totalUsd: pairs.length ? +pairs.reduce((s, p) => s + (p.liquidity?.usd || 0), 0).toFixed(0) : null,
    pools: pairs.slice(0, 12).map(p => ({ dex: p.dexId, pair: `${p.baseToken?.symbol}/${p.quoteToken?.symbol}`, address: p.pairAddress, liquidityUsd: p.liquidity?.usd ?? null, volume24hUsd: p.volume?.h24 ?? null, url: p.url })),
    poolCount: pairs.length,
    lpLockedPct: lp.length ? +(lockedLp * 100).toFixed(2) : null,
    lpBurnedPct: lp.length ? +(burnedLp * 100).toFixed(2) : null,
    lpUnlockedPct: lp.length ? +Math.max(0, (knownLp - lockedLp - burnedLp) * 100).toFixed(2) : null,
    lpHolders: lp.slice(0, 5).map(h => ({ address: h.address, pct: +((num(h.percent) || 0) * 100).toFixed(2), tag: h.tag || null, locked: h.is_locked === 1 || h.is_locked === '1' })),
    solanaPoolBurn: solBurn,
    lpNote: lp.length || solBurn ? null : (isSol ? 'LP burn/lock data not available for this token.' : 'LP lock data not available (concentrated-liquidity pools such as Uniswap v3/v4 have no LP token to lock).'),
    sources: [pairs.length ? 'DexScreener' : null, gp ? 'GoPlus' : null].filter(Boolean)
  };

  // 4. Tokenomics & distribution
  const holders = (gp?.holders || []).map(h => ({ address: h.address || h.account || null, pct: +((num(h.percent) || 0) * 100).toFixed(2), tag: h.tag || null, isContract: h.is_contract === 1, locked: h.is_locked === 1 || h.is_locked === '1' }));
  const sumPct = arr => +arr.reduce((s, h) => s + h.pct, 0).toFixed(2);
  const poolSet = new Set(pairs.map(p => String(p.pairAddress).toLowerCase()));
  const burnedH = holders.filter(h => BURN.has(String(h.address).toLowerCase()));
  const cex = holders.filter(h => h.tag && CEX_WORDS.test(h.tag));
  const lockedH = holders.filter(h => !burnedH.includes(h) && (h.locked || (h.tag && LOCKER_WORDS.test(h.tag))));
  const poolH = holders.filter(h => poolSet.has(String(h.address).toLowerCase()));
  const labelled = new Set([...burnedH, ...cex, ...lockedH, ...poolH]);
  const otherContracts = holders.filter(h => h.isContract && !labelled.has(h));
  const privateH = holders.filter(h => !h.isContract && !labelled.has(h));
  const md = cg?.market_data || {};
  const tokenomics = {
    totalSupply: num(md.total_supply) ?? num(gp?.total_supply),
    circulatingSupply: num(md.circulating_supply) || null,
    maxSupply: num(md.max_supply),
    holderCount: num(gp?.holder_count),
    topHoldersCovered: holders.length,
    top10Pct: holders.length ? sumPct(holders.slice(0, 10)) : null,
    onExchangesPct: holders.length ? sumPct(cex) : null,
    lockedPct: holders.length ? sumPct(lockedH) : null,
    burnedPct: holders.length ? sumPct(burnedH) : null,
    inPoolsPct: holders.length ? sumPct(poolH) : null,
    otherContractsPct: holders.length ? sumPct(otherContracts) : null,
    privateWalletsPct: holders.length ? sumPct(privateH) : null,
    exchangeNote: holders.length && !cex.length ? 'No top holder is labelled as an exchange wallet in the data — the exchange share may be higher than shown.' : null,
    labelNote: isSol ? 'Wallet labels on Solana are limited: some unlabelled wallets may be exchanges or pools.' : null,
    topHolders: holders.slice(0, 10),
    sources: [md.total_supply ? 'CoinGecko' : null, gp ? 'GoPlus' : null].filter(Boolean)
  };

  // 5. Contract risk
  let risk;
  if (isSol) {
    risk = {
      mintable: gp?.mintable ? gp.mintable.status === '1' : null,
      freezable: gp?.freezable ? gp.freezable.status === '1' : null,
      transferFee: gp ? !!(gp.transfer_fee && Object.keys(gp.transfer_fee).length) : null,
      transferHook: gp ? !!(gp.transfer_hook && gp.transfer_hook.length) : null,
      balanceMutable: gp?.balance_mutable_authority ? gp.balance_mutable_authority.status === '1' : null,
      closable: gp?.closable ? gp.closable.status === '1' : null,
      sources: gp ? ['GoPlus'] : []
    };
  } else {
    risk = {
      honeypot: flag(gp?.is_honeypot), cannotSellAll: flag(gp?.cannot_sell_all),
      buyTaxPct: num(gp?.buy_tax) !== null ? +(num(gp.buy_tax) * 100).toFixed(2) : null,
      sellTaxPct: num(gp?.sell_tax) !== null ? +(num(gp.sell_tax) * 100).toFixed(2) : null,
      mintable: flag(gp?.is_mintable), blacklist: flag(gp?.is_blacklisted), proxy: flag(gp?.is_proxy),
      openSource: flag(gp?.is_open_source), transferPausable: flag(gp?.transfer_pausable),
      taxModifiable: flag(gp?.slippage_modifiable), selfDestruct: flag(gp?.selfdestruct),
      sources: gp ? ['GoPlus'] : []
    };
  }

  // 6. Promises vs delivery — factual activity signals only
  const [gh, site] = await Promise.all([githubActivity(links.repos_url?.github), siteStatus(website)]);
  const dev = cg?.developer_data;
  const traded = pairs.length ? pairs.some(p => (p.volume?.h24 || 0) > 0) : null;
  const activity = {
    github: gh,
    githubNote: gh ? null : ((links.repos_url?.github || []).length ? 'GitHub is listed but could not be read right now.' : 'No public GitHub repository listed.'),
    coingeckoDev: dev && dev.commit_count_4_weeks != null ? { commits4w: dev.commit_count_4_weeks } : null,
    website: site,
    tradingActive24h: traded,
    status: null,
    roadmapNote: 'Roadmap promises cannot be verified automatically — compare the project\'s own roadmap with these activity signals yourself.',
    sources: [gh ? 'GitHub API' : null, cg ? 'CoinGecko' : null, site ? 'Website check' : null, pairs.length ? 'DexScreener' : null].filter(Boolean)
  };
  const alive = [gh && gh.lastPushDaysAgo !== null && gh.lastPushDaysAgo <= 90, site?.up, traded].filter(x => x === true).length;
  const dead = [gh && gh.lastPushDaysAgo > 365, site && !site.up, traded === false].filter(Boolean).length;
  activity.status = alive >= 2 ? 'active' : dead >= 2 ? 'looks inactive' : 'unclear';

  // 7. Verdict — only from the facts above
  const red = [], green = [];
  if (risk.honeypot) red.push('GoPlus flags this token as a HONEYPOT — you may not be able to sell.');
  if (risk.cannotSellAll) red.push('You cannot sell your whole balance (GoPlus).');
  if ((risk.sellTaxPct || 0) > 10) red.push(`Sell tax is ${risk.sellTaxPct}%.`);
  if (risk.mintable) red.push(isSol ? 'Mint authority is active — more tokens can be printed.' : 'Contract is mintable — new tokens can be created.');
  if (risk.freezable) red.push('Freeze authority is active — wallets can be frozen.');
  if (risk.blacklist) red.push('Contract has a blacklist function — wallets can be blocked.');
  if (risk.proxy) red.push('Upgradeable proxy contract — the code can be changed later.');
  if (risk.transferPausable) red.push('Transfers can be paused.');
  if (owner.hiddenOwner) red.push('Hidden owner detected (GoPlus).');
  if (owner.sameCreatorHoneypots) red.push('The same creator has deployed honeypot tokens before (GoPlus).');
  if (liquidity.totalUsd !== null && liquidity.totalUsd < 50000) red.push(`Thin liquidity: only $${liquidity.totalUsd.toLocaleString()} across all pools.`);
  if (liquidity.lpUnlockedPct !== null && liquidity.lpUnlockedPct > 50) red.push(`${liquidity.lpUnlockedPct}% of the main pool's LP tokens are not in a known locker or burn address (GoPlus) — that liquidity could be withdrawn.`);
  if ((tokenomics.privateWalletsPct || 0) > 30) red.push(`${tokenomics.privateWalletsPct}% of supply sits in top wallets not labelled as exchange, pool, lock or burn — they may be able to sell anytime.`);
  if (ctx.clusters?.length) red.push(`${ctx.clusters.length} group(s) of top wallets share a funder — possibly one entity.`);
  if (activity.status === 'looks inactive') red.push('Activity signals look inactive (GitHub / website / trading).');
  if (owner.renounced === true) green.push(isSol ? 'Mint and freeze authority are revoked.' : 'Ownership is renounced.');
  if (risk.honeypot === false && (risk.sellTaxPct ?? 0) <= 5) green.push('Not a honeypot, low or no sell tax (GoPlus).');
  if (risk.openSource) green.push('Contract source code is verified.');
  if (liquidity.totalUsd !== null && liquidity.totalUsd >= 500000) green.push(`Deep liquidity: $${liquidity.totalUsd.toLocaleString()} across ${liquidity.poolCount} pools.`);
  if (liquidity.lpLockedPct !== null && liquidity.lpLockedPct + liquidity.lpBurnedPct >= 90) green.push(`${(liquidity.lpLockedPct + liquidity.lpBurnedPct).toFixed(1)}% of the main pool's LP is locked or burned.`);
  if (activity.status === 'active') green.push('Project shows recent activity (GitHub, website or trading).');
  const covered = [gp, cg, pairs.length].filter(Boolean).length;
  const level = red.some(r => /HONEYPOT|cannot sell/i.test(r)) ? 'DANGER' : red.length >= 4 ? 'HIGH RISK' : red.length >= 2 ? 'CAUTION' : covered >= 2 ? 'NO MAJOR RED FLAGS' : 'NOT ENOUGH DATA';
  const verdict = { level, red, green, coverage: `${covered}/3 core data sources answered (GoPlus, CoinGecko, DexScreener)` };

  return { project, owner, liquidity, tokenomics, risk, activity, verdict, generatedAt: new Date().toISOString() };
}
