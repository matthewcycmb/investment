// Renders the public dashboard from data/. Self-contained HTML, no external assets.
// All times display in Hong Kong time (Asia/Hong_Kong).
// Usage: node scripts/render.ts
import { readJSON, writeJSON, ROOT, tTestNaive, tTestClustered } from './lib.ts';
import { writeFileSync, mkdirSync } from 'node:fs';

const N_TARGET = 100;
const TZ = 'Asia/Hong_Kong';
const REPO = (process.env.REPO_URL ?? 'https://github.com/matthewcycmb/investment').replace(/\/$/, '');

const outcomes = readJSON<any>(`${ROOT}data/outcomes.json`, { positions: [], counts: {} });
const positions: any[] = outcomes.positions ?? [];
const eventLog: any[] = readJSON<any>(`${ROOT}data/events.json`, { events: [] }).events ?? [];
const watchState = readJSON<any>(`${ROOT}data/watch-state.json`, { councilRuns: {} });

// ---------- helpers ----------

const esc = (s: unknown) => String(s ?? '')
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const fmt = (iso: string, o: Intl.DateTimeFormatOptions) => {
  const d = new Date(iso);
  return isNaN(+d) ? '—' : d.toLocaleString('en-GB', { timeZone: TZ, hour12: false, ...o });
};
const hktStamp = (iso: string) => fmt(iso, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const hktFull = (iso: string) => fmt(iso, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const hktDateKey = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD in HK

const pct = (x: number | null | undefined, dp = 2) =>
  x == null || isNaN(x) ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(dp)}%`;
const dir = (x: number | null | undefined) => (x == null || isNaN(x) ? 'flat' : x > 0 ? 'up' : x < 0 ? 'down' : 'flat');

const todayHK = hktDateKey(new Date());

// ---------- data shaping ----------

// study !== false keeps records written before the live feed existed.
const closedStudy = positions
  .filter((p) => p.study !== false && p.arm === 'council' && p.status === 'closed')
  .sort((a, b) => a.exitDate.localeCompare(b.exitDate) || a.ticker.localeCompare(b.ticker));

const n = closedStudy.length;
const evaluated = n >= N_TARGET;
const testSet = closedStudy.slice(0, N_TARGET);
const xs = testSet.map((p) => p.excess);
const wk = testSet.map((p) => p.weekKey);
const naive = xs.length > 1 ? tTestNaive(xs) : null;
const clustered = xs.length > 1 && new Set(wk).size > 1 ? tTestClustered(xs, wk) : null;

const livePositions = positions
  .filter((p) => p.study === false && p.status !== 'pending')
  .sort((a, b) => String(b.pickDate).localeCompare(String(a.pickDate)));

const studyPositions = positions
  .filter((p) => p.study !== false && p.arm === 'council' && p.status !== 'pending')
  .sort((a, b) => String(b.pickDate).localeCompare(String(a.pickDate)));

const eventsToday = eventLog.filter((e) => hktDateKey(new Date(e.ts)) === todayHK).length;
const runsToday = watchState.councilRuns?.[todayHK] ?? 0;

// ---------- components ----------

function sparkline(series: number[] | undefined, trend: string): string {
  if (!series || series.length < 2) return '<div class="spark spark--empty"></div>';
  const W = 88, H = 30, lo = Math.min(...series), hi = Math.max(...series), span = hi - lo || 1;
  const pts = series.map((v, i) => {
    const x = (i / (series.length - 1)) * W;
    const y = H - 2 - ((v - lo) / span) * (H - 4);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `<svg class="spark spark--${trend}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <polygon points="0,${H} ${pts.join(' ')} ${W},${H}"/>
    <polyline points="${pts.join(' ')}"/>
  </svg>`;
}

/** One dense app-style row: ticker, sparkline, price, percentage pill. */
function row(p: any, i: number): string {
  const change = p.status === 'closed' ? p.excess : p.markExcess;
  const d = dir(change);
  const price = p.status === 'closed' ? p.exitPrice : (p.markPrice ?? p.entryPrice);
  const sub = p.status === 'closed'
    ? `held ${esc(p.entryDate)} → ${esc(p.exitDate)}`
    : `bought ${esc(p.entryDate)} · still open`;
  return `<a class="row" style="--i:${Math.min(i, 12)}" href="${REPO}/commits/main/data" rel="noopener">
    <div class="row__id">
      <span class="tk">${esc(p.ticker)}</span>
      <span class="sub">${sub}</span>
    </div>
    ${sparkline(p.spark, d)}
    <div class="row__px">
      <span class="px">${price ? Number(price).toFixed(2) : '—'}</span>
      <span class="sub">${p.status === 'closed' ? 'sold at' : 'now'}</span>
    </div>
    <span class="pill pill--${d}">${pct(change)}</span>
  </a>`;
}

const SOURCE_LABEL: Record<string, string> = { policy: 'GOV', filing: 'SEC', headline: 'NEWS', shock: 'MOVE' };
const SOURCE_EXPLAIN: Record<string, string> = {
  policy: 'New government rule',
  filing: 'Company reported something major to the regulator',
  headline: 'News story',
  shock: 'Sharp price move',
};

function eventRow(e: any, i: number): string {
  const label = SOURCE_LABEL[e.source] ?? String(e.source).toUpperCase();
  const title = e.url ? `<a href="${esc(e.url)}" rel="noopener">${esc(e.title)}</a>` : esc(e.title);
  return `<li class="ev" style="--i:${Math.min(i, 12)}">
    <span class="tag tag--${esc(e.source)}">${esc(label)}</span>
    <div class="ev__body">
      <div class="ev__title">${title}</div>
      <div class="sub">${esc(SOURCE_EXPLAIN[e.source] ?? '')}${e.detail ? ` · ${esc(e.detail)}` : ''}</div>
    </div>
    <time class="ev__t">${esc(hktStamp(e.ts))}</time>
  </li>`;
}

const emptyState = (msg: string) => `<div class="empty">${msg}</div>`;

// ---------- verdict ----------

const verdict = evaluated
  ? ((clustered?.p ?? 1) < 0.05
      ? { tone: 'up', head: 'Yes — it beat the market', body: `Average ${pct(clustered?.mean ?? naive?.mean)} better than the S&amp;P 500 across ${N_TARGET} finished trades, and the result is statistically significant.` }
      : { tone: 'down', head: 'No — it did not beat the market', body: `Across ${N_TARGET} finished trades the result could not be told apart from luck. We committed in advance to publishing this either way.` })
  : { tone: 'wait', head: 'Not known yet — and that is the honest answer', body: `The verdict is locked to ${N_TARGET} finished trades so it cannot be cherry-picked. ${n} done, ${N_TARGET - n} to go.` };

// ---------- page ----------

const html = `<title>AI Stock Council — live</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<style>
:root{
  --bg:#08090b; --panel:#101216; --panel2:#161920; --line:#20242e;
  --fg:#eaecef; --mut:#7d8794; --dim:#565e6b;
  --up:#0ecb81; --down:#f6465d; --flat:#7d8794; --amber:#f0b90b; --accent:#4a8cff;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans);
  font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased;
  background-image:radial-gradient(900px 500px at 50% -10%,rgba(74,140,255,.07),transparent 70%)}
main{max-width:820px;margin:0 auto;padding:0 14px 72px}
a{color:inherit;text-decoration:none}
.sub{color:var(--mut);font-size:12px;line-height:1.35;display:block}

.bar{position:sticky;top:0;z-index:9;display:flex;align-items:center;gap:10px;
  padding:12px 2px;background:rgba(8,9,11,.86);backdrop-filter:blur(12px);
  border-bottom:1px solid var(--line);margin-bottom:18px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--up);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(14,203,129,.5)}50%{opacity:.55;box-shadow:0 0 0 5px rgba(14,203,129,0)}}
.bar b{font-size:14px;letter-spacing:.02em}
.bar .clock{margin-left:auto;font-family:var(--mono);font-size:12px;color:var(--mut);font-variant-numeric:tabular-nums}

h1{font-size:26px;line-height:1.2;letter-spacing:-.02em;margin:14px 0 8px;font-weight:700}
.lede{color:var(--mut);font-size:14px;margin:0 0 18px;max-width:62ch}
.lede strong{color:var(--fg);font-weight:600}

.flow{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:0 0 22px}
.step{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:11px 10px;
  animation:rise .5s both;animation-delay:calc(var(--i)*70ms)}
.step .n{font-family:var(--mono);font-size:10px;color:var(--accent);letter-spacing:.1em}
.step .t{font-size:13px;font-weight:650;margin-top:3px}
.step .d{font-size:11px;color:var(--mut);margin-top:2px;line-height:1.3}
@keyframes rise{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}

.verdict{border-radius:12px;padding:16px;margin:0 0 18px;border:1px solid var(--line);background:var(--panel)}
.verdict--wait{border-color:rgba(240,185,11,.3);background:linear-gradient(180deg,rgba(240,185,11,.06),transparent)}
.verdict--up{border-color:rgba(14,203,129,.35);background:linear-gradient(180deg,rgba(14,203,129,.08),transparent)}
.verdict--down{border-color:rgba(246,70,93,.35);background:linear-gradient(180deg,rgba(246,70,93,.08),transparent)}
.verdict .q{font-size:12px;color:var(--mut);text-transform:uppercase;letter-spacing:.09em}
.verdict .a{font-size:19px;font-weight:700;margin:5px 0 6px;letter-spacing:-.01em}
.verdict--wait .a{color:var(--amber)} .verdict--up .a{color:var(--up)} .verdict--down .a{color:var(--down)}
.verdict p{margin:0;font-size:13px;color:var(--mut)}
.track{height:5px;border-radius:99px;background:var(--panel2);overflow:hidden;margin-top:12px}
.track i{display:block;height:100%;background:var(--amber);border-radius:99px}

.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:0 0 26px}
.st{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:11px 10px;text-align:center}
.st b{display:block;font-family:var(--mono);font-size:21px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.st span{font-size:10.5px;color:var(--mut);line-height:1.25;display:block;margin-top:3px}

section{margin:0 0 26px}
h2{font-size:16px;font-weight:680;margin:0;letter-spacing:-.01em}
.head{display:flex;align-items:baseline;gap:9px;margin-bottom:3px;flex-wrap:wrap}
.head .badge{font-family:var(--mono);font-size:10px;color:var(--dim);border:1px solid var(--line);
  padding:1px 6px;border-radius:4px;letter-spacing:.05em}
.ask{color:var(--mut);font-size:13px;margin:0 0 11px;max-width:64ch}

.list{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.row{display:grid;grid-template-columns:1fr 88px auto 82px;gap:11px;align-items:center;
  padding:12px 13px;border-bottom:1px solid var(--line);animation:rise .45s both;animation-delay:calc(var(--i)*45ms)}
.row:last-child{border-bottom:0}
.row:hover{background:var(--panel2)}
.tk{font-weight:700;font-size:15.5px;letter-spacing:-.01em;display:block}
.row__px{text-align:right}
.px{font-family:var(--mono);font-size:15px;font-variant-numeric:tabular-nums;display:block}
.pill{font-family:var(--mono);font-size:13.5px;font-weight:600;text-align:center;
  padding:7px 0;border-radius:6px;color:#fff;font-variant-numeric:tabular-nums}
.pill--up{background:var(--up)} .pill--down{background:var(--down)} .pill--flat{background:#39404d}
.spark{width:88px;height:30px}
.spark--empty{background:repeating-linear-gradient(90deg,var(--line) 0 1px,transparent 1px 5px);opacity:.4;border-radius:3px}
.spark polyline{fill:none;stroke-width:1.6;vector-effect:non-scaling-stroke}
.spark polygon{opacity:.15}
.spark--up polyline{stroke:var(--up)} .spark--up polygon{fill:var(--up)}
.spark--down polyline{stroke:var(--down)} .spark--down polygon{fill:var(--down)}
.spark--flat polyline{stroke:var(--flat)} .spark--flat polygon{fill:var(--flat)}

.feed{list-style:none;margin:0;padding:0;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.ev{display:grid;grid-template-columns:auto 1fr auto;gap:11px;align-items:start;
  padding:11px 13px;border-bottom:1px solid var(--line);animation:rise .45s both;animation-delay:calc(var(--i)*35ms)}
.ev:last-child{border-bottom:0}
.ev__title{font-size:13.5px;line-height:1.4}
.ev__title a{border-bottom:1px solid var(--dim)}
.ev__t{font-family:var(--mono);font-size:11px;color:var(--dim);white-space:nowrap;padding-top:2px;font-variant-numeric:tabular-nums}
.tag{font-family:var(--mono);font-size:9.5px;font-weight:700;letter-spacing:.07em;padding:3px 5px;
  border-radius:4px;color:#fff;margin-top:2px}
.tag--policy{background:#8b5cf6} .tag--filing{background:#3b82f6}
.tag--headline{background:#0ecb81} .tag--shock{background:#f6465d}

.empty{background:var(--panel);border:1px dashed var(--line);border-radius:12px;
  padding:26px 16px;text-align:center;color:var(--mut);font-size:13px}
.note{font-size:12px;color:var(--dim);margin:9px 0 0;line-height:1.5}
footer{border-top:1px solid var(--line);padding-top:16px;color:var(--dim);font-size:11.5px;line-height:1.6}
footer strong{color:var(--mut)}
@media(max-width:620px){
  .flow,.stats{grid-template-columns:repeat(2,1fr)}
  .row{grid-template-columns:1fr auto 76px}
  .spark{display:none}
  h1{font-size:22px}
}
</style>

<main>
<div class="bar">
  <span class="dot"></span><b>AI Stock Council</b>
  <span class="clock">${esc(hktFull(new Date().toISOString()))} HKT</span>
</div>

<h1>Four AIs read the news. Then they decide what to buy.</h1>
<p class="lede">Every 5 minutes this system checks government policy, company filings and market news.
When something important happens, four different AI models each give an opinion — and if enough of
them agree, it buys. <strong>The money is simulated.</strong> Every decision is written to a public
record before the outcome is known, so nothing can be edited afterwards.</p>

<div class="flow">
  <div class="step" style="--i:0"><div class="n">STEP 1</div><div class="t">Watch</div><div class="d">Policy, filings, news &amp; price moves, every 5 min</div></div>
  <div class="step" style="--i:1"><div class="n">STEP 2</div><div class="t">Filter</div><div class="d">Ignore the noise — only real events pass</div></div>
  <div class="step" style="--i:2"><div class="n">STEP 3</div><div class="t">Vote</div><div class="d">4 AIs judge it separately, no discussion</div></div>
  <div class="step" style="--i:3"><div class="n">STEP 4</div><div class="t">Buy</div><div class="d">2+ must agree, or nothing happens</div></div>
</div>

<div class="verdict verdict--${verdict.tone}">
  <div class="q">The question this answers</div>
  <div class="a">${verdict.head}</div>
  <p>${verdict.body}</p>
  <div class="track"><i style="width:${Math.min(100, (n / N_TARGET) * 100).toFixed(1)}%"></i></div>
</div>

<div class="stats">
  <div class="st"><b>${eventLog.length}</b><span>events seen</span></div>
  <div class="st"><b>${eventsToday}</b><span>today</span></div>
  <div class="st"><b>${runsToday}</b><span>AI votes today</span></div>
  <div class="st"><b>${livePositions.length}</b><span>bought by AI</span></div>
</div>

<section>
  <div class="head"><h2>What the AI bought by itself</h2><span class="badge">LIVE</span></div>
  <p class="ask">Nobody chose these. The system saw an event, the AIs agreed, and it bought.
  Green means it beat the S&amp;P 500; red means it lost to it.</p>
  ${livePositions.length
    ? `<div class="list">${livePositions.map(row).join('')}</div>`
    : emptyState('Nothing bought yet. The AIs only buy when at least 2 of 4 agree — most events fail that test, which is the point.')}
</section>

<section>
  <div class="head"><h2>What just happened</h2><span class="badge">${eventLog.length} EVENTS</span></div>
  <p class="ask">Live feed of everything the system spotted. Times are Hong Kong.</p>
  ${eventLog.length
    ? `<ul class="feed">${eventLog.slice(0, 20).map(eventRow).join('')}</ul>`
    : emptyState('No events detected yet.')}
  <p class="note"><span style="color:var(--fg)">GOV</span> government rule ·
  <span style="color:var(--fg)">SEC</span> company filing ·
  <span style="color:var(--fg)">NEWS</span> headline ·
  <span style="color:var(--fg)">MOVE</span> sharp price move</p>
</section>

<section>
  <div class="head"><h2>The scored experiment</h2><span class="badge">WEEKLY</span></div>
  <p class="ask">Separate from the live feed: a fixed weekly test running to ${N_TARGET} finished trades.
  This is the one that decides whether the AI is actually any good. Live buys above are deliberately
  excluded so they cannot flatter the result.</p>
  ${studyPositions.length
    ? `<div class="list">${studyPositions.map(row).join('')}</div>`
    : emptyState(`No scored trades yet — ${n} of ${N_TARGET} complete.`)}
  ${n > 1 ? `<p class="note">Interim figures, <strong>not a result</strong>: average ${pct(naive?.mean)} vs the
  S&amp;P 500 · p=${clustered?.p?.toFixed(4) ?? naive?.p?.toFixed(4) ?? '—'}. The verdict is read once, at ${N_TARGET} trades.</p>` : ''}
</section>

<footer>
<p><strong>Simulated money only.</strong> No real money is invested, no orders are placed, no brokerage
account exists and no funds are accepted from anyone. Nothing here is investment advice.</p>
<p>The method and the pass/fail test were fixed in
<a href="${REPO}/blob/main/PREREGISTRATION.md" rel="noopener" style="border-bottom:1px solid var(--dim)">PREREGISTRATION.md</a>
before any trade existed — including a written promise to publish a negative result.
Every trade is timestamped in the
<a href="${REPO}/commits/main/data" rel="noopener" style="border-bottom:1px solid var(--dim)">public commit history</a>,
so an edited record would show as a visible change. All times Hong Kong (UTC+8).</p>
</footer>
</main>
`;

mkdirSync(`${ROOT}public`, { recursive: true });
writeFileSync(`${ROOT}public/index.html`, html);

writeJSON(`${ROOT}data/summary.json`, {
  updated: new Date().toISOString(),
  timezone: TZ,
  nClosedStudy: n, nTarget: N_TARGET, evaluated,
  liveOpen: livePositions.length, eventsSeen: eventLog.length,
  primary: evaluated ? { naive, clustered } : null,
  interim: evaluated ? null : { naive, clustered, note: 'NOT a result; read once at n=100' },
});

console.log(`rendered public/index.html — ${n}/${N_TARGET} scored · ${livePositions.length} live · ${eventLog.length} events · ${TZ}`);
