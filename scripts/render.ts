// Renders the public dashboard from data/. Self-contained HTML, no external assets.
// Data-first: minimal prose, dense rows, Hong Kong time throughout.
// Usage: node scripts/render.ts
import { readJSON, writeJSON, ROOT, lsJSON, tTestNaive, tTestClustered } from './lib.ts';
import { writeFileSync, mkdirSync } from 'node:fs';

const N_TARGET = 100;
const TZ = 'Asia/Hong_Kong';
const REPO = (process.env.REPO_URL ?? 'https://github.com/matthewcycmb/investment').replace(/\/$/, '');

const outcomes = readJSON<any>(`${ROOT}data/outcomes.json`, { positions: [] });
const positions: any[] = outcomes.positions ?? [];
const eventLog: any[] = readJSON<any>(`${ROOT}data/events.json`, { events: [] }).events ?? [];
const watchState = readJSON<any>(`${ROOT}data/watch-state.json`, { councilRuns: {} });
const quotes: any[] = readJSON<any>(`${ROOT}data/quotes.json`, { quotes: [] }).quotes ?? [];

// Most recent council deliberation: live event-driven run if there is one, else the weekly study run.
const liveFile = lsJSON(`${ROOT}data/live`).pop();
const studyFile = lsJSON(`${ROOT}data/picks`).pop();
const deliberation: any = liveFile
  ? readJSON<any>(`${ROOT}data/live/${liveFile}`, null)
  : (studyFile ? readJSON<any>(`${ROOT}data/picks/${studyFile}`, null) : null);

const esc = (s: unknown) => String(s ?? '')
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const fmt = (iso: string, o: Intl.DateTimeFormatOptions) => {
  const d = new Date(iso);
  return isNaN(+d) ? '\u00b7' : d.toLocaleString('en-GB', { timeZone: TZ, hour12: false, ...o });
};
const hktStamp = (iso: string) => fmt(iso, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const hktFull = (iso: string) => fmt(iso, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const hktDateKey = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: TZ });

const sign = (x: number | null | undefined, dp = 2) =>
  x == null || isNaN(x) ? '\u00b7' : `${x >= 0 ? '+' : ''}${x.toFixed(dp)}%`;
const dir = (x: number | null | undefined) => (x == null || isNaN(x) ? 'flat' : x > 0 ? 'up' : x < 0 ? 'down' : 'flat');

const todayHK = hktDateKey(new Date());

// ---------- data ----------

const closedStudy = positions
  .filter((p) => p.study !== false && p.arm === 'council' && p.status === 'closed')
  .sort((a, b) => a.exitDate.localeCompare(b.exitDate) || a.ticker.localeCompare(b.ticker));
const n = closedStudy.length;
const evaluated = n >= N_TARGET;
const testSet = closedStudy.slice(0, N_TARGET);
const naive = testSet.length > 1 ? tTestNaive(testSet.map((p) => p.excess)) : null;
const clustered = testSet.length > 1 && new Set(testSet.map((p) => p.weekKey)).size > 1
  ? tTestClustered(testSet.map((p) => p.excess), testSet.map((p) => p.weekKey)) : null;

const trades = positions
  .filter((p) => p.status !== 'pending' && (p.study === false || p.arm === 'council'))
  .sort((a, b) => String(b.pickDate).localeCompare(String(a.pickDate)));

const eventsToday = eventLog.filter((e) => hktDateKey(new Date(e.ts)) === todayHK).length;
const runsToday = watchState.councilRuns?.[todayHK] ?? 0;

// ---------- components ----------

function spark(series: number[] | undefined, trend: string): string {
  if (!series || series.length < 2) return '<span class="sp sp--none"></span>';
  const W = 92, H = 28, lo = Math.min(...series), hi = Math.max(...series), sp = hi - lo || 1;
  const pts = series.map((v, i) =>
    `${((i / (series.length - 1)) * W).toFixed(1)},${(H - 2 - ((v - lo) / sp) * (H - 4)).toFixed(1)}`);
  return `<svg class="sp sp--${trend}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
<polygon points="0,${H} ${pts.join(' ')} ${W},${H}"/><polyline points="${pts.join(' ')}"/></svg>`;
}

/** Watchlist row: ticker, sector, sparkline, price, day change. */
const quoteRow = (q: any, i: number) => {
  const d = dir(q.changePct);
  return `<div class="r" style="--i:${Math.min(i, 14)}">
  <div class="r__n"><span class="tk">${esc(q.ticker)}${q.buyers > 0 ? '<i class="ins" title="insider buying"></i>' : ''}</span>
  <span class="sb">${esc(q.name)}</span></div>
  ${spark(q.spark, d)}
  <div class="r__p"><span class="px">${q.last != null ? q.last.toFixed(2) : '\u00b7'}</span></div>
  <span class="pl pl--${d}">${sign(q.changePct)}</span>
</div>`;
};

/** Trade row: ticker, holding dates, sparkline, price, performance vs S&P 500. */
const tradeRow = (p: any, i: number) => {
  const change = p.status === 'closed' ? p.excess : p.markExcess;
  const d = dir(change);
  const price = p.status === 'closed' ? p.exitPrice : (p.markPrice ?? p.entryPrice);
  return `<div class="r" style="--i:${Math.min(i, 14)}">
  <div class="r__n"><span class="tk">${esc(p.ticker)}${p.study === false ? '<i class="auto" title="opened automatically">AUTO</i>' : ''}</span>
  <span class="sb">${esc(p.entryDate ?? p.pickDate)}${p.exitDate ? ` → ${esc(p.exitDate)}` : ' \u00b7 open'}</span></div>
  ${spark(p.spark, d)}
  <div class="r__p"><span class="px">${price ? Number(price).toFixed(2) : '\u00b7'}</span></div>
  <span class="pl pl--${d}">${change == null ? '\u00b7' : sign(change * 100)}</span>
</div>`;
};

const TAG: Record<string, string> = { policy: 'GOV', filing: 'SEC', headline: 'NEWS', shock: 'MOVE' };

const eventRow = (e: any, i: number) => `<div class="e" style="--i:${Math.min(i, 14)}">
  <span class="tg tg--${esc(e.source)}">${esc(TAG[e.source] ?? e.source)}</span>
  <div class="e__t">${e.url ? `<a href="${esc(e.url)}" rel="noopener">${esc(e.title)}</a>` : esc(e.title)}</div>
  <time>${esc(hktStamp(e.ts))}</time>
</div>`;

const none = (m: string) => `<div class="nil">${m}</div>`;

const shortModel = (m: string) => String(m ?? '').split('/').pop() ?? '';

/**
 * The council's actual deliberation: every model's individual verdict on each stock
 * it considered, the vote tally, and whether it cleared the auto-invest gate.
 */
function councilView(d: any): string {
  if (!d) return none('No council session yet. Runs automatically when a signal qualifies.');
  const arms: any[] = d.arms ?? [];
  const considered: any[] = (d.councilAll ?? d.council ?? []);
  if (!considered.length) return none('Council met but named no stock. Doing nothing is a valid outcome.');

  const bought = new Set((d.council ?? []).map((p: any) => p.ticker));
  const gate = d.gate ?? { minVotes: 2, minConfidence: 7 };
  const liveArms = arms.filter((a) => a.ok).length || arms.length;

  const session = `<div class="ses">
    <span class="ses__t">${esc(hktStamp(d.ts ?? d.date))}</span>
    <span class="ses__m">${arms.map((a) => `<i class="${a.ok ? 'on' : 'off'}">${esc(shortModel(a.model))}</i>`).join('')}</span>
    <span class="ses__g">needs ${gate.minVotes}+ votes &amp; conf ${gate.minConfidence}+</span>
  </div>`;

  const cards = considered.map((p: any, i: number) => {
    const passed = bought.has(p.ticker);
    const byArm = new Map((p.theses ?? []).map((t: any) => [t.arm, t]));
    const opinions = arms.map((a) => {
      const t: any = byArm.get(a.id);
      return `<div class="op ${t ? 'op--yes' : 'op--no'}">
        <span class="op__m">${esc(shortModel(a.model))}</span>
        ${t ? `<span class="op__r">#${t.rank}</span><span class="op__c">${t.confidence}/10</span>
        <p class="op__x">${esc(t.thesis)}</p>`
            : `<span class="op__r">·</span><span class="op__c">·</span>
        <p class="op__x">${a.ok ? 'Did not select this stock.' : `Unavailable: ${esc(String(a.error ?? '').slice(0, 70))}`}</p>`}
      </div>`;
    }).join('');

    return `<details class="dl" style="--i:${Math.min(i, 14)}"${i === 0 ? ' open' : ''}>
      <summary class="dl__h">
        <span class="tk">${esc(p.ticker)}</span>
        <span class="dl__v">${p.votes}/${liveArms} agree</span>
        <span class="dl__c">conf ${p.meanConfidence}</span>
        <span class="pl pl--${passed ? 'up' : 'flat'}">${passed ? 'BOUGHT' : 'PASSED'}</span>
      </summary>
      <div class="ops">${opinions}</div>
    </details>`;
  }).join('');

  return session + cards;
}

const verdictText = evaluated
  ? ((clustered?.p ?? 1) < 0.05 ? 'BEAT MARKET' : 'NO EDGE')
  : `${n}/${N_TARGET}`;
const verdictTone = evaluated ? ((clustered?.p ?? 1) < 0.05 ? 'up' : 'down') : 'wait';

// ---------- page ----------

const html = `<title>AI Stock Council</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60">
<style>
:root{--bg:#0a0b0d;--pn:#121419;--pn2:#171a21;--ln:#1f2430;--fg:#eaecef;--mu:#767f8c;--dm:#4d5561;
--up:#0ecb81;--dn:#f6465d;--ft:#767f8c;--am:#f0b90b;--ac:#4a8cff;
--mo:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
--sa:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 var(--sa);-webkit-font-smoothing:antialiased}
main{max-width:760px;margin:0 auto;padding:0 12px 56px}
a{color:inherit;text-decoration:none}

.bar{position:sticky;top:0;z-index:9;display:flex;align-items:center;gap:9px;padding:13px 2px;
background:rgba(10,11,13,.9);backdrop-filter:blur(12px);border-bottom:1px solid var(--ln)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--up);animation:pl 2s infinite}
@keyframes pl{0%,100%{box-shadow:0 0 0 0 rgba(14,203,129,.5)}50%{box-shadow:0 0 0 5px rgba(14,203,129,0)}}
.bar b{font-size:13.5px;font-weight:680;letter-spacing:.04em}
.bar time{margin-left:auto;font:11.5px var(--mo);color:var(--mu);font-variant-numeric:tabular-nums}

.kpi{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--ln);
border-bottom:1px solid var(--ln);margin:0 -12px 0}
.kpi>div{background:var(--bg);padding:13px 8px;text-align:center}
.kpi b{display:block;font:600 20px var(--mo);font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.kpi span{font-size:10px;color:var(--mu);letter-spacing:.04em;text-transform:uppercase;margin-top:2px;display:block}
.kpi .wait b{color:var(--am)} .kpi .up b{color:var(--up)} .kpi .down b{color:var(--dn)}

input[name=tab]{position:absolute;opacity:0;pointer-events:none}
.tabs{display:flex;gap:2px;padding:12px 0 10px;border-bottom:1px solid var(--ln);overflow-x:auto}
.tabs label{flex:none;padding:6px 13px;border-radius:7px;font-size:13px;font-weight:600;
color:var(--mu);cursor:pointer;white-space:nowrap;user-select:none}
.tabs label:hover{color:var(--fg)}
.tabs label i{font-style:normal;font:10.5px var(--mo);color:var(--dm);margin-left:5px}
.pane{display:none;animation:fi .3s}
@keyframes fi{from{opacity:0}to{opacity:1}}
#t1:checked~.tabs label[for=t1],#t2:checked~.tabs label[for=t2],#t3:checked~.tabs label[for=t3],#t4:checked~.tabs label[for=t4]
{background:var(--pn2);color:var(--fg)}
#t1:checked~.panes .p1,#t2:checked~.panes .p2,#t3:checked~.panes .p3,#t4:checked~.panes .p4{display:block}

.hd{display:grid;grid-template-columns:1fr 92px auto 78px;gap:10px;padding:9px 12px;
font-size:10px;color:var(--dm);letter-spacing:.06em;text-transform:uppercase}
.hd span:nth-child(3),.hd span:nth-child(4){text-align:right}
.r{display:grid;grid-template-columns:1fr 92px auto 78px;gap:10px;align-items:center;
padding:11px 12px;border-top:1px solid var(--ln);animation:up .4s both;animation-delay:calc(var(--i)*35ms)}
.r:hover{background:var(--pn)}
@keyframes up{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
.tk{font-weight:700;font-size:15px;letter-spacing:-.01em;display:flex;align-items:center;gap:5px}
.sb{color:var(--mu);font-size:11.5px;display:block;margin-top:1px;overflow:hidden;
text-overflow:ellipsis;white-space:nowrap;max-width:24ch}
.ins{width:5px;height:5px;border-radius:50%;background:var(--am);display:inline-block}
.auto{font:9px var(--mo);font-style:normal;background:var(--ac);color:#fff;padding:1px 4px;border-radius:3px;letter-spacing:.04em}
.r__p{text-align:right}
.px{font:15px var(--mo);font-variant-numeric:tabular-nums}
.pl{font:600 13px var(--mo);text-align:center;padding:6px 0;border-radius:5px;color:#fff;font-variant-numeric:tabular-nums}
.pl--up{background:var(--up)}.pl--down{background:var(--dn)}.pl--flat{background:#333a46}
.sp{width:92px;height:28px}
.sp--none{display:block;background:repeating-linear-gradient(90deg,var(--ln) 0 1px,transparent 1px 5px);opacity:.35;border-radius:2px}
.sp polyline{fill:none;stroke-width:1.5;vector-effect:non-scaling-stroke}
.sp polygon{opacity:.13}
.sp--up polyline{stroke:var(--up)}.sp--up polygon{fill:var(--up)}
.sp--down polyline{stroke:var(--dn)}.sp--down polygon{fill:var(--dn)}
.sp--flat polyline{stroke:var(--ft)}.sp--flat polygon{fill:var(--ft)}

.e{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:baseline;padding:11px 12px;
border-top:1px solid var(--ln);animation:up .4s both;animation-delay:calc(var(--i)*30ms)}
.e:hover{background:var(--pn)}
.e__t{font-size:13px;line-height:1.4;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.e time{font:10.5px var(--mo);color:var(--dm);white-space:nowrap;font-variant-numeric:tabular-nums}
.tg{font:700 9px var(--mo);letter-spacing:.06em;padding:3px 5px;border-radius:3px;color:#fff}
.tg--policy{background:#8b5cf6}.tg--filing{background:#3b82f6}
.tg--headline{background:#0ecb81}.tg--shock{background:#f6465d}

.ses{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:11px 12px;border-top:1px solid var(--ln);
background:var(--pn);font:11px var(--mo);color:var(--mu)}
.ses__m{display:flex;gap:4px;flex-wrap:wrap}
.ses__m i{font-style:normal;padding:2px 6px;border-radius:3px;background:var(--pn2);border:1px solid var(--ln)}
.ses__m i.on{color:var(--up);border-color:rgba(14,203,129,.3)}
.ses__m i.off{color:var(--dm);text-decoration:line-through}
.ses__g{margin-left:auto;color:var(--dm)}
.dl{border-top:1px solid var(--ln);animation:up .4s both;animation-delay:calc(var(--i)*35ms)}
.dl__h{display:grid;grid-template-columns:1fr auto auto 78px;gap:10px;align-items:center;
padding:11px 12px;cursor:pointer;list-style:none}
.dl__h::-webkit-details-marker{display:none}
.dl__h:hover{background:var(--pn)}
.dl__v{font:600 12px var(--mo);color:var(--fg)}
.dl__c{font:11px var(--mo);color:var(--mu)}
.dl[open] .dl__h{background:var(--pn)}
.ops{display:grid;grid-template-columns:repeat(2,1fr);gap:1px;background:var(--ln);border-top:1px solid var(--ln)}
.op{background:var(--bg);padding:10px 12px}
.op--no{opacity:.42}
.op__m{font:600 10.5px var(--mo);color:var(--ac);letter-spacing:.03em}
.op__r{font:10.5px var(--mo);color:var(--mu);margin-left:7px}
.op__c{font:10.5px var(--mo);color:var(--am);margin-left:5px}
.op__x{margin:5px 0 0;font-size:12px;line-height:1.45;color:var(--mu)}
.op--yes .op__x{color:var(--fg)}
@media(max-width:600px){.ops{grid-template-columns:1fr}.dl__h{grid-template-columns:1fr auto 70px}.dl__c{display:none}}
.nil{padding:44px 16px;text-align:center;color:var(--dm);font-size:12.5px;border-top:1px solid var(--ln)}
footer{margin-top:26px;padding-top:14px;border-top:1px solid var(--ln);color:var(--dm);font-size:10.5px;line-height:1.6}
footer a{border-bottom:1px solid var(--ln)}
@media(max-width:600px){
.hd,.r{grid-template-columns:1fr auto 74px}
.sp,.hd span:nth-child(2){display:none}
.kpi b{font-size:17px}
}
</style>

<main>
<div class="bar"><span class="dot"></span><b>AI STOCK COUNCIL</b>
<time>${esc(hktFull(new Date().toISOString()))} HKT</time></div>

<div class="kpi">
  <div><b>${quotes.length}</b><span>watching</span></div>
  <div><b>${eventsToday}</b><span>events today</span></div>
  <div><b>${runsToday}</b><span>AI votes</span></div>
  <div class="${verdictTone}"><b>${verdictText}</b><span>verdict</span></div>
</div>

<input type="radio" name="tab" id="t1" checked><input type="radio" name="tab" id="t2"><input type="radio" name="tab" id="t3"><input type="radio" name="tab" id="t4">
<nav class="tabs">
  <label for="t1">Watchlist<i>${quotes.length}</i></label>
  <label for="t4">Council<i>${(deliberation?.councilAll ?? deliberation?.council ?? []).length}</i></label>
  <label for="t2">AI Trades<i>${trades.length}</i></label>
  <label for="t3">Signals<i>${eventLog.length}</i></label>
</nav>

<div class="panes">
  <div class="pane p1">
    <div class="hd"><span>Symbol</span><span>30d</span><span>Price</span><span>Today</span></div>
    ${quotes.length ? quotes.map(quoteRow).join('') : none('Run npm&nbsp;run&nbsp;screen')}
  </div>

  <div class="pane p2">
    <div class="hd"><span>Symbol</span><span>Trend</span><span>Price</span><span>vs S&amp;P</span></div>
    ${trades.length ? trades.map(tradeRow).join('')
      : none('No trades yet. The AIs only buy when 2 of 4 agree.')}
  </div>

  <div class="pane p3">
    ${eventLog.length ? eventLog.slice(0, 30).map(eventRow).join('') : none('No signals detected yet')}
  </div>

  <div class="pane p4">${councilView(deliberation)}</div>
</div>

<footer>
Simulated positions only. No real money, no orders, no brokerage account. Not investment advice.
Method fixed in <a href="${REPO}/blob/main/PREREGISTRATION.md" rel="noopener">PREREGISTRATION.md</a>
before any trade existed · <a href="${REPO}/commits/main/data" rel="noopener">audit trail</a> · all times HKT (UTC+8)
</footer>
</main>
`;

mkdirSync(`${ROOT}public`, { recursive: true });
writeFileSync(`${ROOT}public/index.html`, html);

writeJSON(`${ROOT}data/summary.json`, {
  updated: new Date().toISOString(), timezone: TZ,
  nClosedStudy: n, nTarget: N_TARGET, evaluated,
  watching: quotes.length, trades: trades.length, eventsSeen: eventLog.length,
  primary: evaluated ? { naive, clustered } : null,
  interim: evaluated ? null : { naive, clustered, note: 'NOT a result; read once at n=100' },
});

console.log(`rendered public/index.html · ${quotes.length} watched · ${trades.length} trades · ${eventLog.length} signals · ${n}/${N_TARGET}`);
