const express  = require('express');
const axios    = require('axios');
const app      = express();
const PORT     = process.env.PORT || 3000;

// ─── In-memory cache ────────────────────────────────────────
// NSE allows ~1 req/min before rate-limiting.
// Cache for 60 seconds so multiple app users share one fetch.
let cache = { data: null, fetchedAt: 0 };
const CACHE_TTL_MS = 60_000; // 60 seconds

// ─── CORS — allow your Flutter app from any origin ──────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── Health check ────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status : 'ok',
    service: 'NSE Option Chain Proxy',
    cache  : cache.fetchedAt > 0
        ? `last fetched ${Math.round((Date.now() - cache.fetchedAt) / 1000)}s ago`
        : 'not yet fetched',
  });
});

// ─── Main endpoint ───────────────────────────────────────────
// GET /nifty-option-chain
app.get('/nifty-option-chain', async (req, res) => {
  try {
    // Serve from cache if fresh
    if (cache.data && (Date.now() - cache.fetchedAt) < CACHE_TTL_MS) {
      console.log('Serving from cache');
      return res.json({ ...cache.data, cached: true });
    }

    console.log('Fetching fresh data from NSE…');
    const data = await fetchFromNSE();

    cache = { data, fetchedAt: Date.now() };
    return res.json({ ...data, cached: false });

  } catch (err) {
    console.error('Error:', err.message);

    // If we have stale cache, serve it with a warning
    if (cache.data) {
      return res.json({ ...cache.data, cached: true, stale: true });
    }

    return res.status(502).json({ error: 'Failed to fetch NSE data', detail: err.message });
  }
});

// ─── NSE fetch logic ─────────────────────────────────────────
async function fetchFromNSE() {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
           + 'AppleWebKit/537.36 (KHTML, like Gecko) '
           + 'Chrome/122.0.0.0 Safari/537.36';

  const baseHeaders = {
    'User-Agent'     : UA,
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
  };

  // Step 1: get session cookies from homepage
  const r1 = await axios.get('https://www.nseindia.com/', {
    headers: { ...baseHeaders, Accept: 'text/html,application/xhtml+xml,*/*' },
    timeout: 15000,
    maxRedirects: 5,
  });

  const rawCookies = r1.headers['set-cookie'] || [];
  const cookies    = parseCookies(rawCookies);

  // Step 2: warm up session on option-chain page
  await axios.get('https://www.nseindia.com/option-chain', {
    headers: {
      ...baseHeaders,
      Accept  : 'text/html,application/xhtml+xml,*/*',
      Referer : 'https://www.nseindia.com/',
      Cookie  : cookies,
    },
    timeout: 10000,
  });

  // Brief pause — NSE rate-limits rapid requests
  await sleep(700);

  // Step 3: fetch option chain API
  const r3 = await axios.get(
    'https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY',
    {
      headers: {
        ...baseHeaders,
        Accept           : 'application/json, */*',
        Referer          : 'https://www.nseindia.com/option-chain',
        Cookie           : cookies,
        'X-Requested-With': 'XMLHttpRequest',
        'sec-fetch-dest' : 'empty',
        'sec-fetch-mode' : 'cors',
        'sec-fetch-site' : 'same-origin',
      },
      timeout: 20000,
    }
  );

  if (!r3.data || !r3.data.records) {
    throw new Error('Invalid NSE response structure');
  }

  console.log(`Fetched successfully. Strikes: ${r3.data.records.data?.length ?? 0}`);
  return r3.data;
}

// ─── Helpers ─────────────────────────────────────────────────
function parseCookies(setCookieArray) {
  return setCookieArray
    .map(c => c.split(';')[0].trim())
    .filter(c => c.includes('='))
    .join('; ');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Start server ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`NSE proxy running on port ${PORT}`);
});
