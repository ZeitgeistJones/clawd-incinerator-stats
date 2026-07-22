// lib/incinerator.js — chain scanning + analysis, shared by the API route.
// Same decode/analyze logic as the original static page, refactored for
// server-side use with incremental caching (never rescans blocks we already have).

const CONTRACT = "0x536453350F2EeE2EB8bFeE1866bAF4fCa494A092";
const DEPLOY_BLOCK = 42039453;
const TOPIC_INCINERATED = "0x4031bacf83d7fecf501f3155733de67666127c4b8539af98c2a1ddda6e4595f3";
const COOLDOWN = 28800;
const PAUSE_THRESHOLD = COOLDOWN * 3;

// Free Alchemy caps eth_getLogs at 10 blocks — never use it for log scans.
const PUBLIC_RPCS = [
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://base.drpc.org",
  "https://1rpc.io/base",
];
const RPCS = [
  process.env.RPC_URL,
  ...PUBLIC_RPCS,
].filter(Boolean);

function isAlchemy(url) {
  return /alchemy\.com/i.test(url || "");
}

let rpcIndex = 0;
async function rpc(method, params, tries = RPCS.length * 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const url = RPCS[rpcIndex % RPCS.length];
    // Skip Alchemy for eth_getLogs (free tier 10-block hard limit).
    if (method === "eth_getLogs" && isAlchemy(url)) {
      rpcIndex++;
      continue;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const data = await res.json().catch(() => ({}));
      if (res.status === 429) {
        lastErr = url + " → http 429";
        rpcIndex++;
        await new Promise((r) => setTimeout(r, 200 + i * 100));
        continue;
      }
      if (!res.ok) throw new Error(url + " → http " + res.status + (data?.error?.message ? " " + data.error.message : ""));
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
    const logs = await rpc("eth_getLogs", [{
      address: CONTRACT, topics: [TOPIC_INCINERATED],
      fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16),
    }], PUBLIC_RPCS.length * 4);
    if (Array.isArray(logs) && logs.length >= 10000 && to > from) {
      const mid = from + Math.floor((to - from) / 2);
      const left = await fetchChunk(from, mid);
      const right = await fetchChunk(mid + 1, to);
      return left.concat(right);
    }
    return logs || [];
  } catch (e) {
    // Range too big / RPC flaky — split and fetch BOTH halves (never drop upper).
    if (to - from < 200) throw e;
    const mid = from + Math.floor((to - from) / 2);
    const left = await fetchChunk(from, mid);
    const right = await fetchChunk(mid + 1, to);
    return left.concat(right);
  }
}

async function scanRange(fromBlock, toBlock) {
  // Sequential adaptive windows — parallel storms rate-limit public RPCs and
  // leave the cache stuck behind tip.
  const out = [];
  let lo = fromBlock;
  let size = Math.min(20000, Math.max(500, toBlock - fromBlock + 1));
  while (lo <= toBlock) {
    let hi = Math.min(lo + size - 1, toBlock);
    let ok = false;
    while (!ok) {
      try {
        const logs = await fetchChunk(lo, hi);
        out.push(...logs);
        ok = true;
        if (logs.length < 20 && size < 20000) size = Math.min(20000, Math.floor(size * 1.5));
      } catch (e) {
        if (hi <= lo) throw e;
        hi = lo + Math.max(0, Math.floor((hi - lo) / 2));
        size = Math.max(500, Math.floor(size / 2));
      }
    }
    lo = hi + 1;
  }
  return out.map(decodeIncinerated).filter(Boolean);
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

  // Same wallet in a row = streak. Cold spell or a different wallet breaks it.
  let longest = { addr: null, count: 0, from: null, to: null };
  let run = null;
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i];
    const broken = i > 0 && (
      e.caller !== evs[i - 1].caller ||
      (e.gap != null && e.gap > PAUSE_THRESHOLD)
    );
    if (!run || broken) {
      if (run && run.count > longest.count) longest = { ...run };
      run = { addr: e.caller, count: 1, from: e.timestamp, to: e.timestamp };
    } else {
      run.count++;
      run.to = e.timestamp;
    }
  }
  if (run && run.count > longest.count) longest = { ...run };
  const streaks = {
    current: run || { addr: null, count: 0, from: null, to: null },
    longest,
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
    streaks,
  };
}

module.exports = {
  CONTRACT, DEPLOY_BLOCK, TOPIC_INCINERATED, COOLDOWN, PAUSE_THRESHOLD,
  rpc, scanRange, analyze, decodeIncinerated,
};
