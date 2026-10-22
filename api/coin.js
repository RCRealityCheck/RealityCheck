export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ success: false, message: 'Missing coin id' });
  res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate');
  try {
    const tickerRes = await fetch(`https://api.coinpaprika.com/v1/tickers/${id}`);
    if (!tickerRes.ok) {
      return res.status(200).json({ success: false, message: 'This coin is not available for a full report right now. Try another or use the contract form below.' });
    }
    const ticker = await tickerRes.json();
    let detail = {};
    try {
      const detailRes = await fetch(`https://api.coinpaprika.com/v1/coins/${id}`);
      if (detailRes.ok) detail = await detailRes.json();
    } catch (e) {}
    const usd = ticker.quotes?.USD || {};

    const sources = [
      { name: 'CoinPaprika', url: `https://coinpaprika.com/coin/${id}` }
    ];
    if (detail.links?.website?.[0]) {
      sources.push({ name: 'Official Website', url: detail.links.website[0] });
    }
    if (detail.links?.explorer?.[0]) {
      sources.push({ name: 'Explorer', url: detail.links.explorer[0] });
    }
    if (detail.links?.twitter?.[0]) {
      sources.push({ name: 'Twitter', url: detail.links.twitter[0] });
    }
    const searchName = encodeURIComponent(ticker.name || '');
    sources.push({ name: 'Search on CoinGecko', url: `https://www.coingecko.com/en/search?query=${searchName}` });
    sources.push({ name: 'Search on CoinMarketCap', url: `https://coinmarketcap.com/search/?q=${searchName}` });

    const circ = ticker.circulating_supply || detail.circulating_supply || null;
    const total = ticker.total_supply || detail.total_supply || null;
    const max = (ticker.max_supply && ticker.max_supply > 0) ? ticker.max_supply : (detail.max_supply && detail.max_supply > 0 ? detail.max_supply : null);

    // Contract addresses (the asked feature — nobody shows these in quick view)
    const contracts = (detail.contracts || [])
      .map(c => ({ address: c.contract || '', platform: c.platform || '', type: c.type || '' }))
      .filter(c => c.address);

    // The one simple unique detail: ATH reality line
    let athReality = null;
    if (usd.ath_price && usd.ath_date && usd.percent_from_price_ath != null) {
      const daysAgo = Math.max(0, Math.floor((Date.now() - new Date(usd.ath_date).getTime()) / 86400000));
      const below = Math.abs(Number(usd.percent_from_price_ath));
      if (below < 5) athReality = `Sitting right at its all-time high — the hype is alive right now.`;
      else if (below < 50) athReality = `${below.toFixed(0)}% below its all-time high (set ${daysAgo.toLocaleString()} days ago) — close, but not there yet.`;
      else athReality = `${below.toFixed(0)}% below its all-time high — that peak was ${daysAgo.toLocaleString()} days ago and it never came back.`;
    }

    res.status(200).json({
      success: true,
      id,
      name: ticker.name,
      symbol: ticker.symbol,
      rank: ticker.rank,
      price: usd.price,
      market_cap: usd.market_cap,
      volume_24h: usd.volume_24h,
      change_24h: usd.percent_change_24h,
      change_7d: usd.percent_change_7d,
      change_30d: usd.percent_change_30d,
      circulating: circ,
      total: total,
      max: max,
      description: (detail.description || '').slice(0, 700),
      tags: (detail.tags || []).map(t => t.name).slice(0, 8),
      ath: usd.ath_price,
      ath_date: usd.ath_date,
      percent_from_ath: usd.percent_from_price_ath,
      athReality,
      contracts,
      sources
    });
  } catch (e) {
    res.status(200).json({ success: false, message: 'Could not load this coin right now. Please try again or use the contract form.' });
  }
}
