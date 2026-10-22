export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
  try {
    const url = 'https://api.coinpaprika.com/v1/tickers?quotes=USD';
    const response = await fetch(url);
    if (!response.ok) throw new Error('API error');
    const data = await response.json();
    const coins = data
      .filter(c => c.rank && c.rank <= 1000 && c.id)
      .sort((a, b) => a.rank - b.rank)
      .map(c => ({
        rank: c.rank,
        id: c.id,
        name: c.name,
        symbol: c.symbol,
        price: c.quotes?.USD?.price,
        market_cap: c.quotes?.USD?.market_cap,
        change_24h: c.quotes?.USD?.percent_change_24h
      }));
    res.status(200).json({ success: true, coins });
  } catch (err) {
    res.status(200).json({ success: false, message: 'Could not load top coins right now. Please refresh in a minute.' });
  }
}
