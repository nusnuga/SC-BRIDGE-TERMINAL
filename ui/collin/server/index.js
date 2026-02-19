import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 8787);

function isServeMode() {
  return process.argv.includes("--serve");
}

function withTimeout(ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { controller, id };
}

async function fetchJson(url, opts = {}) {
  const { controller, id } = withTimeout(12_000);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(opts.headers || {}),
      },
    });

    const text = await res.text().catch(() => "");
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: data || text.slice(0, 700) || res.statusText,
      };
    }

    return { ok: true, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message || e) };
  } finally {
    clearTimeout(id);
  }
}

/**
 * Simple in-memory cache:
 * - ttlMs: serve as "fresh"
 * - staleMs: if upstream fails, serve "stale" within window
 */
const CACHE = new Map();
function getFreshOrStale(key) {
  const hit = CACHE.get(key);
  if (!hit) return { kind: "miss", value: null };
  const age = Date.now() - hit.ts;
  if (age <= hit.ttlMs) return { kind: "fresh", value: hit.value };
  if (age <= hit.staleMs) return { kind: "stale", value: hit.value };
  return { kind: "expired", value: null };
}
function setCache(key, value, ttlMs, staleMs) {
  CACHE.set(key, { value, ts: Date.now(), ttlMs, staleMs });
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, ts: Date.now(), cacheKeys: CACHE.size });
});

/**
 * CoinGecko Simple Price (cached)
 * /api/coingecko/simple_price?ids=bitcoin,ethereum,solana,trac-network&vs=usd
 */
app.get("/api/coingecko/simple_price", async (req, res) => {
  const ids = String(req.query.ids || "").trim();
  const vs = String(req.query.vs || "usd").trim();
  if (!ids) return res.status(400).json({ ok: false, error: "Missing ids" });

  const key = `cg:simple:${vs}:${ids}`;
  const hit = getFreshOrStale(key);

  // fresh 20s, stale 10min
  if (hit.kind === "fresh") return res.json({ ok: true, data: hit.value, cached: "fresh" });

  const url =
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}` +
    `&vs_currencies=${encodeURIComponent(vs)}&include_24hr_change=true`;

  const out = await fetchJson(url);
  if (!out.ok) {
    if (hit.kind === "stale") return res.json({ ok: true, data: hit.value, cached: "stale", upstreamError: out.error });
    return res.status(502).json({ ok: false, source: "coingecko", error: out.error, status: out.status });
  }

  setCache(key, out.data, 20_000, 10 * 60_000);
  res.json({ ok: true, data: out.data, cached: "miss" });
});

/**
 * CoinGecko Market Chart (cached)
 * /api/coingecko/market_chart?id=bitcoin&vs=usd&days=7
 */
app.get("/api/coingecko/market_chart", async (req, res) => {
  const id = String(req.query.id || "").trim();
  const vs = String(req.query.vs || "usd").trim();
  const days = String(req.query.days || "7").trim();
  if (!id) return res.status(400).json({ ok: false, error: "Missing id" });

  const key = `cg:chart:${id}:${vs}:${days}`;
  const hit = getFreshOrStale(key);

  // fresh 90s, stale 30min
  if (hit.kind === "fresh") return res.json({ ok: true, data: hit.value, cached: "fresh" });

  const url =
    `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}` +
    `/market_chart?vs_currency=${encodeURIComponent(vs)}&days=${encodeURIComponent(days)}`;

  const out = await fetchJson(url);
  if (!out.ok) {
    if (hit.kind === "stale") return res.json({ ok: true, data: hit.value, cached: "stale", upstreamError: out.error });
    return res.status(502).json({ ok: false, source: "coingecko", error: out.error, status: out.status });
  }

  setCache(key, out.data, 90_000, 30 * 60_000);
  res.json({ ok: true, data: out.data, cached: "miss" });
});

/**
 * DexScreener Token Pairs (cached lightly)
 * /api/dex/token_pairs?chain=solana&address=<mint_or_ca>
 */
app.get("/api/dex/token_pairs", async (req, res) => {
  const chain = String(req.query.chain || "").trim();
  const address = String(req.query.address || "").trim();
  if (!chain) return res.status(400).json({ ok: false, error: "Missing chain" });
  if (!address) return res.status(400).json({ ok: false, error: "Missing address" });

  const key = `dex:tokenPairs:${chain}:${address}`;
  const hit = getFreshOrStale(key);

  // fresh 15s, stale 5min
  if (hit.kind === "fresh") return res.json({ ok: true, data: hit.value, cached: "fresh" });

  const url = `https://api.dexscreener.com/token-pairs/v1/${encodeURIComponent(chain)}/${encodeURIComponent(address)}`;
  const out = await fetchJson(url);
  if (!out.ok) {
    if (hit.kind === "stale") return res.json({ ok: true, data: hit.value, cached: "stale", upstreamError: out.error });
    return res.status(502).json({ ok: false, source: "dexscreener", error: out.error, status: out.status });
  }

  setCache(key, out.data, 15_000, 5 * 60_000);
  res.json({ ok: true, data: out.data, cached: "miss" });
});

/**
 * DexScreener Pair Snapshot (cached lightly)
 * /api/dex/pair?chain=solana&pair=<pairAddress>
 */
app.get("/api/dex/pair", async (req, res) => {
  const chain = String(req.query.chain || "").trim();
  const pair = String(req.query.pair || "").trim();
  if (!chain) return res.status(400).json({ ok: false, error: "Missing chain" });
  if (!pair) return res.status(400).json({ ok: false, error: "Missing pair" });

  const key = `dex:pair:${chain}:${pair}`;
  const hit = getFreshOrStale(key);

  // fresh 3s, stale 60s
  if (hit.kind === "fresh") return res.json({ ok: true, data: hit.value, cached: "fresh" });

  const url = `https://api.dexscreener.com/latest/dex/pairs/${encodeURIComponent(chain)}/${encodeURIComponent(pair)}`;
  const out = await fetchJson(url);
  if (!out.ok) {
    if (hit.kind === "stale") return res.json({ ok: true, data: hit.value, cached: "stale", upstreamError: out.error });
    return res.status(502).json({ ok: false, source: "dexscreener", error: out.error, status: out.status });
  }

  setCache(key, out.data, 3_000, 60_000);
  res.json({ ok: true, data: out.data, cached: "miss" });
});

if (isServeMode()) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const dist = path.join(__dirname, "..", "dist");
  app.use(express.static(dist));
  app.get("*", (req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[SC-BRIDGE] API listening on http://127.0.0.1:${PORT}`);
  if (isServeMode()) console.log(`[SC-BRIDGE] Serving UI from /dist`);
});
