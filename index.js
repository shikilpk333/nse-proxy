const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Cache ─────────────────────────────────────────────────────
let cache = {
  data: null,
  fetchedAt: 0,
  error: null,
};

const CACHE_TTL_MS = 120000; // 2 minutes

// ── Browser-like axios client ─────────────────────────────────
const client = axios.create({
  timeout: 20000,
  maxRedirects: 5,
  validateStatus: (status) => status >= 200 && status < 300,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
  },
});

// ── CORS ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ── Health check ──────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'NSE Option Chain Proxy v4',
    ready: cache.data != null,
    cached: cache.data != null,
    age:
      cache.fetchedAt > 0
        ? `${Math.round((Date.now() - cache.fetchedAt) / 1000)}s ago`
        : 'not fetched yet',
    lastError: cache.error,
  });
});

// ── Main endpoint ─────────────────────────────────────────────
app.get('/nifty-option-chain', async (req, res) => {
  try {
    const ageMs = Date.now() - cache.fetchedAt;

    if (cache.data && ageMs < CACHE_TTL_MS) {
      const age = Math.round(ageMs / 1000);
      console.log(`[CACHE] Serving cached data (${age}s old)`);
      return res.json({
        ...cache.data,
        cached: true,
        cacheAge: age,
      });
    }

    console.log('[FETCH] Getting fresh NSE data...');
    const data = await fetchFromNSE();

    if (!data?.records?.data?.length) {
      throw new Error('NSE response missing records.data');
    }

    if (!data?.records?.expiryDates?.length) {
      throw new Error('NSE response missing records.expiryDates');
    }

    if (!data?.records?.underlyingValue) {
      throw new Error('NSE response missing records.underlyingValue');
    }

    cache = {
      data,
      fetchedAt: Date.now(),
      error: null,
    };

    const count = data.records.data.length;
    const spot = data.records.underlyingValue;
    const expiry = data.records.expiryDates[0];

    console.log(`[OK] ${count} strikes | spot=${spot} | expiry=${expiry}`);

    return res.json({
      ...data,
      cached: false,
    });
  } catch (err) {
    const status = err.response?.status;
    const responseData = err.response?.data;

    console.error('[ERROR]', status || '', err.message);

    if (responseData) {
      console.error(
        '[ERROR DATA]',
        typeof responseData === 'string'
          ? responseData
          : JSON.stringify(responseData)
      );
    }

    cache.error = status
      ? `Request failed with status code ${status}`
      : err.message;

    if (cache.data) {
      const age = Math.round((Date.now() - cache.fetchedAt) / 1000);
      console.log(`[STALE] Serving stale cache (${age}s old)`);

      return res.json({
        ...cache.data,
        cached: true,
        stale: true,
        cacheAge: age,
      });
    }

    return res.status(502).json({
      error: 'Failed to fetch NSE data',
      detail: cache.error,
    });
  }
});

// ── NSE 3-step session fetch ──────────────────────────────────
async function fetchFromNSE() {
  const homeUrl = 'https://www.nseindia.com/';
  const optionChainPageUrl = 'https://www.nseindia.com/option-chain';
  const apiUrl =
    'https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY';

  console.log('[NSE] Step 1: Homepage...');
  const r1 = await client.get(homeUrl, {
    headers: {
      'Accept':
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    },
  });

  let cookies = mergeCookies(r1.headers['set-cookie']);

  if (!cookies) {
    throw new Error('NSE homepage returned no cookies');
  }

  console.log('[NSE] Step 1 cookies length:', cookies.length);

  console.log('[NSE] Step 2: Option chain page...');
  const r2 = await client.get(optionChainPageUrl, {
    headers: {
      'Accept':
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Referer': homeUrl,
      'Cookie': cookies,
    },
  });

  cookies = mergeCookies(r1.headers['set-cookie'], r2.headers['set-cookie']);

  if (!cookies) {
    throw new Error('Failed to build NSE session cookies');
  }

  console.log('[NSE] Step 2 merged cookies length:', cookies.length);

  await sleep(1500);

  console.log('[NSE] Step 3: API...');
  const r3 = await client.get(apiUrl, {
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Referer': optionChainPageUrl,
      'Cookie': cookies,
      'X-Requested-With': 'XMLHttpRequest',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
    },
  });

  if (!r3.data) {
    throw new Error('Empty body from NSE API');
  }

  console.log(
    '[NSE] API response size:',
    JSON.stringify(r3.data).length,
    'bytes'
  );

  return r3.data;
}

// ── Helpers ───────────────────────────────────────────────────
function mergeCookies(...cookieArrays) {
  const map = new Map();

  for (const arr of cookieArrays) {
    if (!Array.isArray(arr)) continue;

    for (const raw of arr) {
      const firstPart = raw.split(';')[0].trim();
      const eqIndex = firstPart.indexOf('=');

      if (eqIndex > 0) {
        const key = firstPart.slice(0, eqIndex).trim();
        map.set(key, firstPart);
      }
    }
  }

  return Array.from(map.values()).join('; ');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`NSE proxy v4 running on port ${PORT}`);
});
