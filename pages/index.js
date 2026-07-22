// pages/index.js
import { useEffect, useRef, useState } from "react";

const COOLDOWN = 28800;
const PAUSE_THRESHOLD = COOLDOWN * 3;

function fmtDuration(s) {
  if (s == null) return "—";
  const neg = s < 0; s = Math.abs(Math.round(s));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600),
        m = Math.floor((s % 3600) / 60), sec = s % 60;
  const out = d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
  return (neg ? "-" : "") + out;
}
/** Prefer live wall-clock ms when watcher caught it; else chain-second duration. */
function fmtSnipe(e) {
  if (e?.liveLatencyMs != null && Number.isFinite(e.liveLatencyMs)) {
    const neg = e.liveLatencyMs < 0;
    const sec = Math.abs(e.liveLatencyMs) / 1000;
    if (sec >= 3600) return (neg ? "-" : "") + fmtDuration(sec);
    const out = sec >= 60
      ? `${Math.floor(sec / 60)}m ${(sec % 60).toFixed(1)}s`
      : `${sec.toFixed(1)}s`;
    return (neg ? "-" : "") + out;
  }
  return fmtDuration(e?.latency);
}
function fmtClawd(weiStr) {
  const n = Number(BigInt(weiStr) / 10n ** 18n);
  return n.toLocaleString("en-US");
}
function fmtClawdShort(weiStr) {
  const n = Number(BigInt(weiStr) / 10n ** 18n);
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(0) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "K";
  return String(n);
}
function fmtDate(ts) { return new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16); }
function fmtDay(ts) { return new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }); }
function shortAddr(a) { return a.slice(0, 6) + "…" + a.slice(-4); }

function HeatStrip({ events, deployTs }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = 110;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    const t0 = Math.min(deployTs, events.length ? events[0].timestamp : deployTs);
    const t1 = Date.now() / 1000;
    const span = t1 - t0;
    const x = ts => ((ts - t0) / span) * w;
    ctx.fillStyle = "#1B1611";
    ctx.fillRect(0, h / 2 - 14, w, 28);
    for (const e of events) {
      const px = x(e.timestamp);
      const snipe = e.latency != null && e.latency <= 60;
      ctx.fillStyle = snipe ? "#FF5A1F" : "#FFB347";
      const tickH = snipe ? 44 : 34;
      ctx.fillRect(px - 0.75, h / 2 - tickH / 2, 1.5, tickH);
    }
  }, [events, deployTs]);
  return <canvas ref={canvasRef} style={{ width: "100%", height: 110, display: "block" }} />;
}

export default function Home() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [showAll, setShowAll] = useState(false);

  const load = () => {
    setErr(null);
    fetch("/api/stats")
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setData(d); })
      .catch(e => setErr(e.message || String(e)));
  };
  useEffect(load, []);

  const deployTs = Date.UTC(2026, 1, 12, 3, 50, 53) / 1000;

  return (
    <>
      <style>{`
        :root{ --char:#0F0C09; --soot:#1B1611; --soot-edge:#2A231B; --ash:#E9E1D3; --ember:#FF5A1F; --flame:#FFB347; --cold:#6E655A; }
        *{box-sizing:border-box;margin:0;padding:0}
        html,body{background:var(--char)}
        body{ font-family:'IBM Plex Mono',monospace; color:var(--ash); min-height:100vh; padding:0 clamp(16px,4vw,56px) 80px; }
        a{color:var(--flame);text-decoration:none} a:hover{text-decoration:underline}
        header{ display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between; gap:16px;padding:40px 0 28px;border-bottom:1px solid var(--soot-edge); }
        .eyebrow{ font-size:11px;letter-spacing:.32em;text-transform:uppercase;color:var(--cold); margin-bottom:10px; }
        h1{ font-family:'Anton',sans-serif;font-weight:400; font-size:clamp(40px,7vw,84px);line-height:.95;letter-spacing:.01em; text-transform:uppercase;color:var(--ash); }
        h1 .lit{color:var(--ember)}
        .cachebadge{ font-size:11px;color:var(--cold);letter-spacing:.08em;text-transform:uppercase; }
        #strip-wrap{padding:36px 0 8px}
        .strip-axis{ display:flex;justify-content:space-between;font-size:11px;color:var(--cold); letter-spacing:.08em;text-transform:uppercase;padding-top:8px; }
        .tiles{ display:grid;grid-template-columns:repeat(5,1fr);gap:1px; background:var(--soot-edge);border:1px solid var(--soot-edge);margin-top:28px; }
        @media (max-width:980px){ .tiles{grid-template-columns:repeat(3,1fr)} }
        @media (max-width:760px){ .tiles{grid-template-columns:repeat(2,1fr)} }
        .streak-tiles{ display:grid;grid-template-columns:repeat(2,1fr);gap:1px; background:var(--soot-edge);border:1px solid var(--soot-edge);margin-top:16px; }
        @media (max-width:760px){ .streak-tiles{grid-template-columns:1fr} }
        .tile{background:var(--soot);padding:22px 20px 18px}
        .tile .label{font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:var(--cold);margin-bottom:12px}
        .tile .value{ font-family:'Anton',sans-serif;font-size:clamp(30px,4.5vw,52px); line-height:1;color:var(--ash); }
        .tile .value.hot{color:var(--ember)}
        .tile .sub{font-size:11px;color:var(--cold);margin-top:8px}
        section{margin-top:56px}
        h2{ font-family:'Anton',sans-serif;font-weight:400;font-size:clamp(20px,2.6vw,28px); text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px; }
        .section-note{font-size:12px;color:var(--cold);margin-bottom:20px}
        .pause-row{ display:flex;flex-wrap:wrap;gap:8px 24px;align-items:baseline; padding:14px 0;border-bottom:1px solid var(--soot-edge);font-size:13px;border-top:1px solid var(--soot-edge); }
        .pause-row .dur{ font-family:'Anton',sans-serif;font-size:22px;color:var(--cold);min-width:110px; }
        table{width:100%;border-collapse:collapse;font-size:12.5px}
        th{ text-align:left;font-weight:500;font-size:11px;letter-spacing:.2em; text-transform:uppercase;color:var(--cold);padding:10px 14px 10px 0; border-bottom:1px solid var(--soot-edge); }
        td{padding:11px 14px 11px 0;border-bottom:1px solid var(--soot-edge);vertical-align:baseline;white-space:nowrap}
        td.num,th.num{text-align:right;padding-right:0}
        .snipe{color:var(--ember)} .slow{color:var(--flame)} .pause-flag{color:var(--cold);font-size:11px}
        .table-scroll{overflow-x:auto}
        .bar{display:inline-block;height:8px;background:var(--ember);vertical-align:middle;margin-right:10px;min-width:2px}
        #show-all{ margin-top:18px;font-family:inherit;font-size:12px;letter-spacing:.14em; text-transform:uppercase;background:none;border:1px solid var(--soot-edge); color:var(--cold);padding:10px 22px;cursor:pointer; }
        #show-all:hover{border-color:var(--cold);color:var(--ash)}
        footer{ margin-top:72px;padding-top:24px;border-top:1px solid var(--soot-edge); display:flex;flex-wrap:wrap;gap:8px 32px;font-size:12px;color:var(--cold); }
        .loading,.error{padding:60px 0;text-align:center;color:var(--cold);font-size:13px}
        .error button{ margin-top:16px;font-family:inherit;font-size:13px;letter-spacing:.1em;text-transform:uppercase; background:none;border:1px solid var(--ember);color:var(--ember);padding:12px 28px;cursor:pointer; }
      `}</style>

      <header>
        <div>
          <div className="eyebrow">clawd incinerator · base mainnet</div>
          <h1>Furnace <span className="lit">Log</span></h1>
        </div>
        {data && (
          <div className="cachebadge">
            served from cache · {data.cacheAgeMs != null ? fmtDuration(data.cacheAgeMs / 1000) + " old" : "just refreshed"}
          </div>
        )}
      </header>

      {!data && !err && <div className="loading">reading the furnace…</div>}

      {err && (
        <div className="error">
          couldn't load stats ({err})
          <br />
          <button onClick={load}>retry</button>
        </div>
      )}

      {data && (
        <div>
          <div id="strip-wrap">
            <HeatStrip events={data.events} deployTs={deployTs} />
            <div className="strip-axis">
              <span>{fmtDay(deployTs)} · deploy</span>
              <span>every tick is a burn · dark stretches are cold spells</span>
              <span>now · {fmtDay(Date.now() / 1000)}</span>
            </div>
          </div>

          <div className="tiles">
            <div className="tile">
              <div className="label">Burns</div>
              <div className="value">{data.totalBurns}</div>
            </div>
            <div className="tile">
              <div className="label">Unique wallets</div>
              <div className="value hot">{data.uniqueWallets}</div>
              {data.leaderboard[0] && (
                <div className="sub">{shortAddr(data.leaderboard[0].addr)} holds {Math.round(data.leaderboard[0].count / data.totalBurns * 100)}%</div>
              )}
            </div>
            <div className="tile">
              <div className="label">CLAWD burned</div>
              <div className="value">{fmtClawdShort(data.totalBurned)}</div>
              <div className="sub">{fmtClawd(data.totalBurned)} CLAWD to the dead address</div>
            </div>
            <div className="tile">
              <div className="label">Median snipe</div>
              <div className="value">
                {fmtDuration(data.events.filter(e => e.latency != null && e.gap <= PAUSE_THRESHOLD).map(e => e.latency).sort((a,b)=>a-b)[Math.floor(data.events.filter(e => e.latency != null && e.gap <= PAUSE_THRESHOLD).length / 2)])}
              </div>
              <div className="sub">past cooldown expiry, cold spells excluded</div>
            </div>
            <div className="tile">
              <div className="label">Current streak</div>
              <div className="value hot">{data.streaks?.current?.count || 0}</div>
              <div className="sub">
                {data.streaks?.current?.addr
                  ? <>{shortAddr(data.streaks.current.addr)} · since {fmtDay(data.streaks.current.from)}</>
                  : "no burns yet"}
              </div>
            </div>
          </div>

          <section>
            <h2>Streaks</h2>
            <div className="section-note">Same wallet burning in a row. Broken by another wallet or a cold spell.</div>
            <div className="streak-tiles">
              <div className="tile">
                <div className="label">Current</div>
                <div className="value hot">{data.streaks?.current?.count || 0}</div>
                <div className="sub">
                  {data.streaks?.current?.addr ? (
                    <>
                      <a href={`https://basescan.org/address/${data.streaks.current.addr}`} target="_blank" rel="noopener noreferrer">{shortAddr(data.streaks.current.addr)}</a>
                      {" · "}{data.streaks.current.count === 1 ? "1 burn" : `${data.streaks.current.count} burns`}
                      {" · "}{fmtDay(data.streaks.current.from)} → {fmtDay(data.streaks.current.to)}
                    </>
                  ) : "—"}
                </div>
              </div>
              <div className="tile">
                <div className="label">Longest ever</div>
                <div className="value">{data.streaks?.longest?.count || 0}</div>
                <div className="sub">
                  {data.streaks?.longest?.addr ? (
                    <>
                      <a href={`https://basescan.org/address/${data.streaks.longest.addr}`} target="_blank" rel="noopener noreferrer">{shortAddr(data.streaks.longest.addr)}</a>
                      {" · "}{data.streaks.longest.count === 1 ? "1 burn" : `${data.streaks.longest.count} burns`}
                      {" · "}{fmtDay(data.streaks.longest.from)} → {fmtDay(data.streaks.longest.to)}
                    </>
                  ) : "—"}
                </div>
              </div>
            </div>
          </section>

          <section>
            <h2>Cold spells</h2>
            <div className="section-note">Stretches over 24h with no burn.</div>
            {data.pauses.length === 0
              ? <div style={{ padding: "18px 0", fontSize: 13, color: "var(--cold)" }}>None recorded.</div>
              : data.pauses.map((p, i) => (
                  <div className="pause-row" key={i}>
                    <span className="dur">{fmtDuration(p.seconds)}</span>
                    <span>{fmtDate(p.from)} → {fmtDate(p.to)}</span>
                  </div>
                ))
            }
          </section>

          <section>
            <h2>Stokers</h2>
            <div className="section-note">Every wallet that has ever called incinerate(), by burn count.</div>
            <div className="table-scroll">
              <table>
                <thead><tr><th>Wallet</th><th className="num">Burns</th><th className="num">Share</th><th className="num">CLAWD burned</th><th className="num">First</th><th className="num">Last</th></tr></thead>
                <tbody>
                  {data.leaderboard.map((l, i) => {
                    const max = data.leaderboard[0].count;
                    return (
                      <tr key={i}>
                        <td><a href={`https://basescan.org/address/${l.addr}`} target="_blank" rel="noopener noreferrer">{shortAddr(l.addr)}</a></td>
                        <td className="num"><span className="bar" style={{ width: Math.max(2, l.count / max * 90) }}></span>{l.count}</td>
                        <td className="num">{Math.round(l.count / data.totalBurns * 100)}%</td>
                        <td className="num">{fmtClawd(l.burned)}</td>
                        <td className="num">{fmtDay(l.first)}</td>
                        <td className="num">{fmtDay(l.last)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h2>Burn log</h2>
            <div className="section-note">Latest first.</div>
            <div className="table-scroll">
              <table>
                <thead><tr><th>When (UTC)</th><th>Wallet</th><th className="num">Snipe</th><th></th></tr></thead>
                <tbody>
                  {[...data.events].reverse().slice(0, showAll ? undefined : 25).map((e, i) => (
                    <tr key={i}>
                      <td>{fmtDate(e.timestamp)}</td>
                      <td><a href={`https://basescan.org/address/${e.caller}`} target="_blank" rel="noopener noreferrer">{shortAddr(e.caller)}</a></td>
                      <td className="num">
                        {e.latency == null ? "—"
                          : e.gap > PAUSE_THRESHOLD ? <span className="pause-flag">after cold spell</span>
                          : <span className={(e.liveLatencyMs != null ? e.liveLatencyMs / 1000 : e.latency) <= 60 ? "snipe" : "slow"}>{fmtSnipe(e)}</span>}
                      </td>
                      <td className="num"><a href={`https://basescan.org/tx/${e.tx}`} target="_blank" rel="noopener noreferrer">tx →</a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!showAll && data.events.length > 25 && (
              <button id="show-all" onClick={() => setShowAll(true)}>Show all burns</button>
            )}
          </section>

          <footer>
            <span>contract <a href={`https://basescan.org/address/${data.contract}`} target="_blank" rel="noopener noreferrer">{shortAddr(data.contract)}</a></span>
            <span>cached server-side · scanned through block {data.scannedTo?.toLocaleString()}</span>
          </footer>
        </div>
      )}
    </>
  );
}
