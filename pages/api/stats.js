// pages/api/stats.js
//
// Strategy: keep the full event list + the last-scanned block number in
// Upstash. Every request checks how far behind the cache is and only scans
// NEW blocks (usually zero, since burns happen every 8h) — so almost every
// request is a cache hit with a near-instant response, and only the rare
// request right after a new burn pays for a tiny incremental scan instead of
// the full historical one.

import { Redis } from "@upstash/redis";
import { CONTRACT, DEPLOY_BLOCK, rpc, scanRange, analyze } from "../../lib/incinerator";

const redis = Redis.fromEnv();
const CACHE_KEY = "incinerator:events:v1";
const LOCK_KEY = "incinerator:scanlock:v1";
const LOCK_TTL_SECONDS = 90; // tip catch-up can exceed 30s on public RPCs
// Cap work per request so serverless doesn't time out while still making progress.
const MAX_BLOCKS_PER_REQUEST = 80000;

export default async function handler(req, res) {
  try {
    const latest = parseInt(await rpc("eth_blockNumber", []), 16);

    let cached = await redis.get(CACHE_KEY);
    let events = cached?.events || [];
    let scannedTo = cached?.scannedTo || DEPLOY_BLOCK - 1;

    if (scannedTo < latest) {
      // Only one request should do the incremental scan at a time; others serve stale-but-close cache.
      const gotLock = await redis.set(LOCK_KEY, "1", { nx: true, ex: LOCK_TTL_SECONDS });
      if (gotLock) {
        try {
          const target = Math.min(latest, scannedTo + MAX_BLOCKS_PER_REQUEST);
          // scanRange throws if a window hard-fails — do NOT advance scannedTo past it.
          const newEvents = await scanRange(scannedTo + 1, target);
          const byTx = new Map(events.map((e) => [String(e.tx).toLowerCase(), e]));
          for (const e of newEvents) byTx.set(String(e.tx).toLowerCase(), e);
          events = [...byTx.values()].sort((a, b) => a.timestamp - b.timestamp || a.block - b.block);
          scannedTo = target;
          await redis.set(CACHE_KEY, { events, scannedTo, cachedAt: Date.now() }, { ex: 60 * 60 * 24 * 30 });
        } catch (scanErr) {
          console.warn("incremental scan failed; serving cache without advancing scannedTo:", scanErr.message || scanErr);
        } finally {
          await redis.del(LOCK_KEY);
        }
      }
      // If another request holds the lock, we just serve what we have — it'll be
      // fresh again on the next request once that scan finishes.
    }

    const result = analyze(events);
    result.scannedTo = scannedTo;
    result.latestBlock = latest;
    result.contract = CONTRACT;
    result.cacheAgeMs = cached?.cachedAt ? Date.now() - cached.cachedAt : 0;

    // Persist a cachedAt marker alongside without re-scanning (cheap metadata update)
    if (!cached || cached.scannedTo !== scannedTo) {
      await redis.set(CACHE_KEY, { events, scannedTo, cachedAt: Date.now() }, { ex: 60 * 60 * 24 * 30 });
    }

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=300");
    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
