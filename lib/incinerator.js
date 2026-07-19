// lib/incinerator.js — chain scanning + analysis, shared by the API route.
// Same decode/analyze logic as the original static page, refactored for
// server-side use with incremental caching (never rescans blocks we already have).

const CONTRACT = "0x536453350F2EeE2EB8bFeE1866bAF4fCa494A092";
const DEPLOY_BLOCK = 42039453;
const TOPIC_INCINERATED = "0x4031bacf83d7fecf501f3155733de67666127c4b8539af98c2a1ddda6e4595f3";
const COOLDOWN = 28800;
const PAUSE_THRESHOLD = COOLDOWN * 3;

const RPCS = [
  process.env.RPC_URL, // optional paid endpoint, tried first if set
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://1rpc.io/base",
].filter(Boolean);

let rpcIndex = 0;
async function rpc(method, params, tries = RPCS.length * 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const url = RPCS[rpcIndex % RPCS.length];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(url + " → http " + res.status);
      const data = await res.json();
      if (data.error) throw new Error(url + " → " + (data.error.message || "rpc error"));
      return data.result;
    } catch (e) {
      clearTimeout(timeout);
      lastErr = e.name === "AbortError" ? url + " → timed out" : (e.message || String(e));
      rpcIndex++;
    }
  }
  throw new Error(lastErr || "all RPCs failed");
}

function decodeIncinerated(log) {
  if (!log.topics || log.topics.length < 2) return null;
  const caller = "0x" + log.topics[1].slice(26);
  const d = log.data.slice(2);
  if (d.length < 192) return null;
  return {
    caller: caller.toLowerCase(),
    amountBurned: ("0x" + d.slice(0, 64)),   // stored as hex string (BigInt doesn't survive JSON in the cache)
    rewardPaid: ("0x" + d.slice(64, 128)),
    timestamp: Number(BigInt("0x" + d.slice(128, 192))),
    block: parseInt(log.blockNumber, 16),
    tx: log.transactionHash,
  };
}

async function fetchChunk(from, to) {
  try {
    return await rpc("eth_getLogs", [{
      address: CONTRACT, topics: [TOPIC_INCINERATED],
      fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16),
    }], 2);
  } catch (e) {
    // Range too big / RPC flaky — split and fetch BOTH halves (old code only
    // retried the lower half and silently dropped the upper half's burns).
    if (to - from < 200) throw e;
    const mid = from + Math.floor((to - from) / 2);
    const left = await fetchChunk(from, mid);
    const right = await fetchChunk(mid + 1, to);
    return left.concat(right);
  }
}

async function scanRange(fromBlock, toBlock) {
  const CHUNK_SIZE = 5000;
  const CONCURRENCY = 14;
  const ranges = [];
  for (let f = fromBlock; f <= toBlock; f += CHUNK_SIZE) {
    ranges.push([f, Math.min(f + CHUNK_SIZE - 1, toBlock)]);
  }
  if (!ranges.length) return [];

  const results = new Array(ranges.length);
  let cursor = 0, hardFailures = 0;
  async function worker() {
    while (cursor < ranges.length) {
      const idx = cursor++;
      const [f, t] = ranges[idx];
      try { results[idx] = await fetchChunk(f, t); }
      catch (e) { results[idx] = []; hardFailures++; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ranges.length) }, worker));
  if (hardFailures > ranges.length * 0.05) {
    throw new Error(hardFailures + " of " + ranges.length + " block ranges failed");
  }
  return results.flat().map(decodeIncinerated).filter(Boolean);
}

function analyze(events) {
  const evs = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const byCaller = new Map();
  const gaps = [];
  const pauses = [];
  let totalBurned = 0n;

  for (let i = 0; i < evs.length; i++) {
    const e = evs[i];
    const burned = BigInt(e.amountBurned);
    totalBurned += burned;
    const c = byCaller.get(e.caller) || { count: 0, burned: 0n, first: e.timestamp, last: e.timestamp };
    c.count++; c.burned += burned; c.last = e.timestamp;
    byCaller.set(e.caller, c);
    if (i > 0) {
      const gap = e.timestamp - evs[i - 1].timestamp;
      e.gap = gap;
      e.latency = gap - COOLDOWN;
      gaps.push({ gap, latency: e.latency });
      if (gap > PAUSE_THRESHOLD) pauses.push({ from: evs[i - 1].timestamp, to: e.timestamp, seconds: gap });
    }
  }

  const race = gaps.filter(g => g.gap <= PAUSE_THRESHOLD).map(g => g.latency).sort((a, b) => a - b);
  const latency = {
    median: race.length ? race[Math.floor(race.length / 2)] : null,
    max: race.length ? race[race.length - 1] : null,
    under60: race.filter(l => l <= 60).length,
    samples: race.length,
  };

  const leaderboard = [...byCaller.entries()]
    .map(([addr, c]) => ({ addr, count: c.count, burned: c.burned.toString(), first: c.first, last: c.last }))
    .sort((a, b) => b.count - a.count);

  return {
    events: evs.map(e => ({ ...e, amountBurned: undefined, rewardPaid: undefined })), // trim per-event token amounts, leaderboard already has totals
    totalBurns: evs.length,
    totalBurned: totalBurned.toString(),
    uniqueWallets: byCaller.size,
    leaderboard,
    pauses,
  };
}

module.exports = { CONTRACT, DEPLOY_BLOCK, COOLDOWN, rpc, scanRange, analyze, decodeIncinerated };
