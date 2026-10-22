export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Use POST' });
  const { contract, chain } = req.body || {};
  if (!contract || !chain) return res.status(400).json({ success: false, message: 'Contract and chain required' });

  let clean = (contract || '').trim();
  if (!clean.startsWith('0x')) clean = '0x' + clean;
  const hex = clean.slice(2);
  if (chain !== 'solana-mainnet' && (hex.length !== 40 || !/^[a-fA-F0-9]+$/.test(hex))) {
    return res.status(200).json({ success: false, message: 'Invalid contract address. Must be 42 characters (0x + 40 hex).' });
  }

  const key = process.env.COVALENT_KEY || '';
  const chainMap = {
    'eth-mainnet': 'eth-mainnet',
    'bsc-mainnet': 'bsc-mainnet',
    'avalanche-mainnet': 'avalanche-mainnet',
    'base-mainnet': 'base-mainnet',
    'polygon-mainnet': 'matic-mainnet',
    'arbitrum-mainnet': 'arbitrum-mainnet'
  };
  const cChain = chainMap[chain] || chain;
  const explorers = {
    'eth-mainnet': `https://etherscan.io/token/${clean}`,
    'bsc-mainnet': `https://bscscan.com/token/${clean}`,
    'avalanche-mainnet': `https://snowtrace.io/token/${clean}`,
    'base-mainnet': `https://basescan.org/token/${clean}`,
    'polygon-mainnet': `https://polygonscan.com/token/${clean}`,
    'arbitrum-mainnet': `https://arbiscan.io/token/${clean}`
  };

  try {
    const url = `https://api.covalenthq.com/v1/${cChain}/tokens/${clean}/token_holders_v2/`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    const j = await r.json();
    if (!j.data || !j.data.items || j.data.items.length === 0) {
      return res.status(200).json({
        success: false,
        message: 'No holder data found for this contract on the selected chain. Check the address and chain, or open the explorer.',
        explorer: explorers[chain] || '#'
      });
    }
    const items = j.data.items;
    const first = items[0];
    const total = BigInt(first.total_supply || '0');
    const decimals = first.contract_decimals || 18;
    const name = first.contract_name || 'Token';
    const symbol = first.contract_ticker_symbol || '';

    const holders = items.slice(0, 10).map(h => {
      const bal = BigInt(h.balance || '0');
      const pct = total > 0n ? (Number(bal * 10000n / total) / 100).toFixed(2) : '0';
      return { address: h.address, percentage: pct + '%' };
    });
    const top1 = holders[0]?.percentage || '—';
    const top3 = holders.slice(0, 3).reduce((s, h) => s + parseFloat(h.percentage), 0).toFixed(2) + '%';
    const top10 = holders.reduce((s, h) => s + parseFloat(h.percentage), 0).toFixed(2) + '%';

    let verdict = 'Moderate';
    if (parseFloat(top10) > 70) verdict = 'High concentration';
    else if (parseFloat(top10) > 40) verdict = 'Elevated concentration';
    else verdict = 'Relatively distributed';

    res.status(200).json({
      success: true,
      name,
      symbol,
      verdict,
      concentration: top10,
      top1,
      top3,
      type: 'ERC-20',
      totalSupply: (Number(total) / 10 ** decimals).toLocaleString(undefined, { maximumFractionDigits: 0 }),
      retailImpact: parseFloat(top10) > 50
        ? 'A small number of wallets control a large share of the supply. If they sell, the price can drop sharply for everyone who bought later.'
        : 'Supply is more spread out among holders. Still check if the biggest wallets can sell immediately.',
      watch: 'Ignore known exchange and liquidity pool wallets when judging real risk. Look for team or deployer wallets that are unlocked.',
      riskNote: 'This is public on-chain data only. Always verify yourself. Not financial advice.',
      topHolders: holders.slice(0, 5),
      note: 'Data from Covalent. Free forever.',
      explorer: explorers[chain] || '#'
    });
  } catch (e) {
    res.status(200).json({
      success: false,
      message: 'Could not load holder data right now. Try again or open the explorer.',
      explorer: explorers[chain] || '#'
    });
  }
}
