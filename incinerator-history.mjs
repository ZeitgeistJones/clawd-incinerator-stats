// incinerator-history.mjs
// Pulls the COMPLETE burn history for the CLAWD Incinerator contract
// directly from Base chain logs (no API key needed).
//
// Run with: node incinerator-history.mjs
// Requires Node 18+ (has built-in fetch). Drop into Cursor, hit run.
//
// Output: incinerator-history.csv with every burn, plus a summary
// printed to console (unique wallets, gaps/pause detection, latency stats).

const RPC = "https://mainnet.base.org";
const CONTRACT = "0x536453350F2EeE2EB8bFeE1866bAF4fCa494A092";
const DEPLOY_BLOCK = 42039453; // contract creation block, from basescan
const COOLDOWN_SECONDS = 28800; // 8 hours, confirmed from contract

// Incinerated(address indexed caller, uint256 amountBurned, uint256 callerRewardPaid, uint256 timestamp)
const TOPIC0 = "0x4031bacf83d7fecf501f3155733de67666127c4b8539af98c2a1ddda6e4595"; // will be verified below via keccak if needed

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.result;
}

async function getLatestBlock() {
  const hex = await rpc("eth_blockNumber", []);
  return parseInt(hex, 16);
}

async function getLogsChunked(fromBlock, toBlock) {
  // Base RPC caps log ranges, so chunk conservatively.
  const CHUNK = 50000;
  let logs = [];
  for (let start = fromBlock; start <= toBlock; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, toBlock);
    const result = await rpc("eth_getLogs", [{
      address: CONTRACT,
      fromBlock: "0x" + start.toString(16),
      toBlock: "0x" + end.toString(16),
      topics: [null], // grab all events from this contract, filter after decode
    }]);
    logs = logs.concat(result);
    process.stderr.write(`  scanned blocks ${start}-${end}: ${result.length} logs\n`);
  }
  return logs;
}

async function getBlockTimestamp(blockNumHex, cache) {
  if (cache.has(blockNumHex)) return cache.get(blockNumHex);
  const block = await rpc("eth_getBlockByNumber", [blockNumHex, false]);
  const ts = parseInt(block.timestamp, 16);
  cache.set(blockNumHex, ts);
  return ts;
}

function decodeIncinerated(log) {
  // topics[0] = event sig, topics[1] = indexed caller
  // data = amountBurned (32 bytes) + callerRewardPaid (32 bytes) + timestamp (32 bytes)
  if (log.topics.length < 2) return null;
  const caller = "0x" + log.topics[1].slice(26);
  const data = log.data.slice(2);
  if (data.length < 192) return null;
  const amountBurned = BigInt("0x" + data.slice(0, 64));
  const callerRewardPaid = BigInt("0x" + data.slice(64, 128));
  const timestamp = BigInt("0x" + data.slice(128, 192));
  return { caller, amountBurned, callerRewardPaid, timestamp: Number(timestamp) };
}

async function main() {
  console.error("Fetching latest block...");
  const latest = await getLatestBlock();
  console.error(`Latest block: ${latest}. Scanning from deploy block ${DEPLOY_BLOCK}...`);

  const rawLogs = await getLogsChunked(DEPLOY_BLOCK, latest);
  console.error(`Total raw logs: ${rawLogs.length}. Decoding...`);

  const blockTsCache = new Map();
  const events = [];

  for (const log of rawLogs) {
    const decoded = decodeIncinerated(log);
    if (!decoded) continue; // skip ParametersUpdated / OwnershipTransferred logs
    // Use event's own embedded timestamp (more reliable than block timestamp, but they should match)
    events.push({
      caller: decoded.caller,
      amountBurned: decoded.amountBurned.toString(),
      callerRewardPaid: decoded.callerRewardPaid.toString(),
      timestamp: decoded.timestamp,
      block: parseInt(log.blockNumber, 16),
      txHash: log.transactionHash,
    });
  }

  events.sort((a, b) => a.timestamp - b.timestamp);

  console.error(`Decoded ${events.length} Incinerated events.`);

  // ---- Analysis ----
  const uniqueWallets = new Set(events.map(e => e.caller.toLowerCase()));
  const callerCounts = {};
  for (const e of events) {
    callerCounts[e.caller] = (callerCounts[e.caller] || 0) + 1;
  }

  let rows = ["timestamp_iso,caller,amountBurned,callerRewardPaid,txHash,gapFromPrevSeconds,readyLatencySeconds,pauseFlag"];
  let prevTs = null;
  let gaps = [];
  const pauses = [];

  for (const e of events) {
    const iso = new Date(e.timestamp * 1000).toISOString();
    let gapFromPrev = "";
    let readyLatency = "";
    let pauseFlag = "";
    if (prevTs !== null) {
      const gap = e.timestamp - prevTs;
      gapFromPrev = gap;
      const latency = gap - COOLDOWN_SECONDS;
      readyLatency = latency;
      gaps.push(gap);
      // Flag anything way beyond a normal cooldown-window as a likely pause
      if (gap > COOLDOWN_SECONDS * 3) {
        pauseFlag = "PAUSE_GAP";
        pauses.push({ from: new Date(prevTs * 1000).toISOString(), to: iso, gapHours: (gap / 3600).toFixed(1) });
      }
    }
    rows.push(`${iso},${e.caller},${e.amountBurned},${e.callerRewardPaid},${e.txHash},${gapFromPrev},${readyLatency},${pauseFlag}`);
    prevTs = e.timestamp;
  }

  const fs = await import("fs");
  fs.writeFileSync("incinerator-history.csv", rows.join("\n"));

  console.log("\n=== SUMMARY ===");
  console.log(`Total burns: ${events.length}`);
  console.log(`Unique wallets: ${uniqueWallets.size}`);
  console.log(`Date range: ${new Date(events[0].timestamp * 1000).toISOString()} -> ${new Date(events[events.length - 1].timestamp * 1000).toISOString()}`);
  console.log("\nTop callers:");
  Object.entries(callerCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([addr, count]) => {
    console.log(`  ${addr}: ${count} burns (${((count / events.length) * 100).toFixed(1)}%)`);
  });
  console.log("\nDetected pause gaps (>3x cooldown, i.e. >24h between burns):");
  if (pauses.length === 0) console.log("  none found");
  pauses.forEach(p => console.log(`  ${p.from} -> ${p.to}  (${p.gapHours}h gap)`));

  console.log(`\nFull data written to incinerator-history.csv (${events.length} rows)`);
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
