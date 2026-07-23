#!/usr/bin/env node
// Free GitHub Actions watcher: near cooldown unlock, wait for readyAt then poll
// for the next burn and record wall-clock latency (ms). Only writes when we see
// a NEW tx appear after polling starts — never invents numbers for missed burns.
//
// Secrets: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
// Optional: RPC_URL (HTTP). Public Base RPCs used as fallback.

const CONTRACT = "0x536453350F2EeE2EB8bFeE1866bAF4fCa494A092";
const TOPIC_INCINERATED = "0x4031bacf83d7fecf501f3155733de67666127c4b8539af98c2a1ddda6e4595f3";
const COOLDOWN = 28800;
const CACHE_KEY = "incinerator:events:v1";
const LIVE_KEY = "incinerator:live-latency:v1";

// Wake early enough that a late GitHub cron can still wait for unlock.
const PRE_MIN = 22;      // enter window this many minutes before unlock
const POST_MIN = 20;     // give up this many minutes after unlock
const MAX_WATCH_MS = 18 * 60 * 1000; // hard cap after unlock (Actions minutes)
const POLL_MS = 500;

const PUBLIC_RPCS = [
  process.env.RPC_URL,
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://base.drpc.org",
  "https://1rpc.io/base",
].filter(Boolean);

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.error("Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN");
  process.exit(1);
}

async function redis(command, ...args) {
  const res = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([command, ...args]),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `upstash http ${res.status}`);
  return data.result;
}

async function redisGetJson(key) {
  const raw = await redis("GET", key);
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

async function redisSetJson(key, value, exSeconds) {
  const payload = JSON.stringify(value);
  if (exSeconds) await redis("SET", key, payload, "EX", String(exSeconds));
  else await redis("SET", key, payload);
}

let rpcIndex = 0;
async function rpc(method, params) {
  let lastErr;
  for (let i = 0; i < PUBLIC_RPCS.length * 2; i++) {
    const url = PUBLIC_RPCS[rpcIndex % PUBLIC_RPCS.length];
    rpcIndex++;
    if (/alchemy\.com/i.test(url || "") && method === "eth_getLogs") continue;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error?.message || `http ${res.status}`);
      return data.result;
    } catch (e) {
      lastErr = e.message || String(e);
    }
  }
  throw new Error(lastErr || "all RPCs failed");
}

function decode(log) {
  if (!log?.topics?.[1]) return null;
  return {
    caller: ("0x" + log.topics[1].slice(26)).toLowerCase(),
    timestamp: Number(BigInt("0x" + log.data.slice(2).slice(128, 192))),
    block: parseInt(log.blockNumber, 16),
    tx: String(log.transactionHash).toLowerCase(),
  };
}

async function logsFrom(fromBlock) {
  const latest = parseInt(await rpc("eth_blockNumber", []), 16);
  const from = Math.max(0, fromBlock);
  if (from > latest) return [];
  const logs = await rpc("eth_getLogs", [{
    address: CONTRACT,
    topics: [TOPIC_INCINERATED],
    fromBlock: "0x" + from.toString(16),
    toBlock: "0x" + latest.toString(16),
  }]);
  return (logs || []).map(decode).filter(Boolean);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sleepUntil(targetMs, label) {
  const ms = targetMs - Date.now();
  if (ms <= 0) return;
  console.log(`${label}: sleeping ${Math.round(ms / 1000)}s until ${new Date(targetMs).toISOString()}`);
  // Chunk sleep so logs show we're alive and we don't oversleep weirdly.
  const chunk = 30_000;
  let left = ms;
  while (left > 0) {
    const step = Math.min(chunk, left);
    await sleep(step);
    left -= step;
    if (left > 0) console.log(`… ${Math.round(left / 1000)}s left`);
  }
}

async function main() {
  const cached = await redisGetJson(CACHE_KEY);
  const events = cached?.events || [];
  if (!events.length) {
    console.log("no cached events yet — nothing to watch");
    return;
  }

  const last = [...events].sort((a, b) => a.timestamp - b.timestamp || a.block - b.block).at(-1);
  const readyAt = last.timestamp + COOLDOWN;
  const readyAtMs = readyAt * 1000;
  const now = Date.now() / 1000;
  const windowStart = readyAt - PRE_MIN * 60;
  const windowEnd = readyAt + POST_MIN * 60;

  console.log(JSON.stringify({
    lastTx: last.tx,
    lastTs: last.timestamp,
    readyAt,
    readyAtIso: new Date(readyAtMs).toISOString(),
    now: Math.floor(now),
    inWindow: now >= windowStart && now <= windowEnd,
  }));

  if (now < windowStart || now > windowEnd) {
    console.log("outside watch window — exit");
    return;
  }

  // Arrive early → wait for unlock, then poll. That's how we catch snappy snipes.
  if (Date.now() < readyAtMs) {
    await sleepUntil(readyAtMs, "pre-unlock");
  }

  const live = (await redisGetJson(LIVE_KEY)) || {};
  const known = new Set(events.map((e) => String(e.tx).toLowerCase()));
  for (const tx of Object.keys(live)) known.add(tx.toLowerCase());

  const fromBlock = Math.max(0, (last.block || 0) - 5);
  const atStart = await logsFrom(fromBlock);
  for (const e of atStart) known.add(e.tx);

  // If a brand-new burn is already on chain before we start polling, we missed
  // the moment — do not write a late inflated latency.
  const alreadyMissed = atStart.filter((e) => !events.some((x) => String(x.tx).toLowerCase() === e.tx));
  if (alreadyMissed.length) {
    console.log("burn already on chain before watch start — skip live write:", alreadyMissed.map((e) => e.tx));
    return;
  }

  const deadline = Math.min(Date.now() + MAX_WATCH_MS, windowEnd * 1000);
  console.log(`watching until ${new Date(deadline).toISOString()} (poll ${POLL_MS}ms)`);

  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    let found;
    try {
      found = await logsFrom(fromBlock);
    } catch (e) {
      console.warn("poll failed:", e.message || e);
      continue;
    }
    for (const e of found) {
      if (known.has(e.tx)) continue;
      const latencyMs = Math.round(Date.now() - readyAtMs);
      live[e.tx] = {
        latencyMs,
        readyAtMs,
        seenAtMs: Date.now(),
        caller: e.caller,
        block: e.block,
        timestamp: e.timestamp,
      };
      await redisSetJson(LIVE_KEY, live, 60 * 60 * 24 * 180);
      console.log("caught live snipe", { tx: e.tx, latencyMs, latencySec: (latencyMs / 1000).toFixed(1) });
      return;
    }
  }

  console.log("watch window ended — no new burn observed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
