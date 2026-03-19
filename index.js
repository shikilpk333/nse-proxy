const express = require('express');
const axios   = require('axios');
const app     = express();
const PORT    = process.env.PORT || 3000;

// ── Cache ─────────────────────────────────────────────────────
let cache = { data: null, fetchedAt: 0, error: null };
const CACHE_TTL_MS = 55_000;

// ── CORS ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Health check ──────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status  : 'ok',
    service : 'NSE Option Chain Proxy v3',
    ready   : cache.data != null,
    cached  : cache.data != null,
    age     : cache.fetchedAt > 0
        ? `${Math.round((Date.now() - cache.fetchedAt) / 1000)}s ago`
        : 'not fetched yet',
    lastError: cache.error,
  });
});

// ── Main endpoint ─────────────────────────────────────────────
app.get('/nifty-option-chain', async (req, res) => {
  try {
    // Fresh cache
    if (cache.data && (Date.now() - cache.fetchedAt) < CACHE_TTL_MS) {
      const age = Math.round((Date.now() - cache.fetchedAt) / 1000);
      console.log(`[CACHE] Serving cached data (${age}s old)`);
      return res.json({ ...cache.data, cached: true, cacheAge: age });
    }

    console.log('[FETCH] Getting fresh NSE data...');
    const data = await fetchFromNSE();

    // Validate
    if (!data?.records?.data?.length) {
      throw new Error('NSE response missing records.data');
    }
    if (!data?.records?.expiryDates?.length) {
      throw new Error('NSE response missing records.expiryDates');
    }
    if (!data?.records?.underlyingValue) {
      throw new Error('NSE response missing records.underlyingValue');
    }

    cache = { data, fetchedAt: Date.now(), error: null };
    const count = data.records.data.length;
    const spot  = data.records.underlyingValue;
    console.log(`[OK] ${count} strikes | spot=${spot} | expiry=${data.records.expiryDates[0]}`);

    return res.json({ ...data, cached: false });

  } catch (err) {
    console.error('[ERROR]', err.message);
    cache.error = err.message;

    // Stale cache fallback
    if (cache.data) {
      const age = Math.round((Date.now() - cache.fetchedAt) / 1000);
      console.log(`[STALE] Serving stale cache (${age}s old)`);
      return res.json({ ...cache.data, cached: true, stale: true, cacheAge: age });
    }

    return res.status(502).json({
      error : 'Failed to fetch NSE data',
      detail: err.message,
    });
  }
});

// ── NSE 3-step session fetch ──────────────────────────────────
async function fetchFromNSE() {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
           + 'AppleWebKit/537.36 (KHTML, like Gecko) '
           + 'Chrome/122.0.0.0 Safari/537.36';

  const baseHeaders = {
    'User-Agent'     : UA,
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection'     : 'keep-alive',
  };

  // Step 1: Homepage — establish session & collect cookies
  console.log('[NSE] Step 1: Homepage...');
  const r1 = await axios.get('https://www.nseindia.com/', {
    headers: { ...baseHeaders, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    timeout: 15000,
    maxRedirects: 5,
  });

  const cookies = parseCookies(r1.headers['set-cookie'] || []);
  if (!cookies) throw new Error('NSE homepage returned no cookies — may be rate-limited');
  console.log('[NSE] Cookies obtained:', cookies.length, 'chars');

  // Step 2: Option chain page — activate the trading session
  console.log('[NSE] Step 2: Activating session...');
  await axios.get('https://www.nseindia.com/option-chain', {
    headers: {
      ...baseHeaders,
      Accept  : 'text/html,application/xhtml+xml,*/*;q=0.8',
      Referer : 'https://www.nseindia.com/',
      Cookie  : cookies,
    },
    timeout: 12000,
  });

  // Delay — NSE throttles rapid requests
  await sleep(1000);

  // Step 3: API call with active session
  console.log('[NSE] Step 3: Fetching option chain API...');
  const r3 = await axios.get(
    'https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY',
    {
      headers: {
        ...baseHeaders,
        Accept            : 'application/json, text/plain, */*',
        Referer           : 'https://www.nseindia.com/option-chain',
        Cookie            : cookies,
        'X-Requested-With': 'XMLHttpRequest',
        'sec-ch-ua'       : '"Chromium";v="122", "Not(A:Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-fetch-dest'  : 'empty',
        'sec-fetch-mode'  : 'cors',
        'sec-fetch-site'  : 'same-origin',
        'Cache-Control'   : 'no-cache',
        'Pragma'          : 'no-cache',
      },
      timeout: 20000,
    }
  );

  if (!r3.data) throw new Error('Empty body from NSE API');
  console.log('[NSE] API response received, size:', JSON.stringify(r3.data).length, 'bytes');
  return r3.data;
}

// ── Helpers ───────────────────────────────────────────────────
function parseCookies(setCookieArr) {
  if (!Array.isArray(setCookieArr) || !setCookieArr.length) return '';
  return setCookieArr
    .map(c => c.split(';')[0].trim())
    .filter(c => c.includes('='))
    .join('; ');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Auto-fetch on startup ─────────────────────────────────────
// Pre-warm the cache so first app user gets instant data.
async function warmUp() {
  console.log('[STARTUP] Pre-warming cache...');
  try {
    const data = await fetchFromNSE();
    if (data?.records?.data?.length) {
      cache = { data, fetchedAt: Date.now(), error: null };
      console.log(`[STARTUP] Cache warmed: ${data.records.data.length} strikes, spot=${data.records.underlyingValue}`);
    }
  } catch (e) {
    console.error('[STARTUP] Warm-up failed:', e.message);
    cache.error = e.message;
  }
}

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`NSE proxy v3 running on port ${PORT}`);
  // Fetch immediately on startup, don't block server start
  warmUp();
  // Auto-refresh every 55 seconds to keep cache fresh
  setInterval(async () => {
    if (Date.now() - cache.fetchedAt > CACHE_TTL_MS) {
      console.log('[AUTO-REFRESH] Cache expired, fetching...');
      try {
        const data = await fetchFromNSE();
        if (data?.records?.data?.length) {
          cache = { data, fetchedAt: Date.now(), error: null };
          console.log('[AUTO-REFRESH] OK');
        }
      } catch (e) {
        console.error('[AUTO-REFRESH] Failed:', e.message);
        cache.error = e.message;
      }
    }
  }, 60_000);
});
