// Renders the public dashboard from data/. Self-contained HTML, no external assets.
// Data-first: minimal prose, dense rows, Hong Kong time throughout.
// Usage: node scripts/render.ts
import { readJSON, writeJSON, ROOT, lsJSON, tTestNaive, tTestClustered } from './lib.ts';
import { writeFileSync, mkdirSync } from 'node:fs';
import { detailPanel, DETAIL_CSS } from './stockpage.ts';

const N_TARGET = 100;
const TZ = 'Asia/Hong_Kong';
const REPO = (process.env.REPO_URL ?? 'https://github.com/matthewcycmb/investment').replace(/\/$/, '');

const outcomes = readJSON<any>(`${ROOT}data/outcomes.json`, { positions: [] });
const positions: any[] = outcomes.positions ?? [];
const eventLog: any[] = readJSON<any>(`${ROOT}data/events.json`, { events: [] }).events ?? [];
const watchState = readJSON<any>(`${ROOT}data/watch-state.json`, { councilRuns: {} });
const pf = outcomes.portfolio ?? { equity: 100000, totalReturnPct: 0, openPositions: 0, cash: 100000, realized: 0, unrealized: 0 };
const money = (x: number) => `$${Math.round(x).toLocaleString()}`;
const quotesFile = readJSON<any>(`${ROOT}data/quotes.json`, { quotes: [], updated: null });
const quotes: any[] = quotesFile.quotes ?? [];
const pricesLive = quotes.some((q) => q.live);

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
  return `<a class="r" href="s/${esc(q.ticker)}.html" style="--i:${Math.min(i, 14)}">
  <div class="r__n"><span class="tk">${esc(q.ticker)}${q.buyers > 0 ? '<i class="ins" title="insider buying"></i>' : ''}</span>
  <span class="sb">${esc(q.name)}</span></div>
  ${spark(q.spark, d)}
  <div class="r__p"><span class="px">${q.last != null ? q.last.toFixed(2) : '\u00b7'}</span></div>
  <span class="pl pl--${d}">${sign(q.changePct)}</span>
</a>`;
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

/** Compact row in the left-hand watchlist of the split view. */
const sideRow = (q: any, i: number) => {
  const d = dir(q.changePct);
  return `<label class="wr" for="k${i}">
    <span class="wr__l"><span class="tk">${esc(q.ticker)}${q.buyers > 0 ? '<i class="ins" title="insider buying"></i>' : ''}</span>
    <span class="sb">${esc(q.name)}</span></span>
    <span class="wr__r"><span class="px">${q.last != null ? q.last.toFixed(2) : '\u00b7'}</span>
    <span class="pl pl--${d}">${sign(q.changePct)}</span></span>
  </label>`;
};

const TAG: Record<string, string> = { policy: 'GOV', filing: 'SEC', headline: 'NEWS', shock: 'MOVE' };

const eventRow = (e: any, i: number) => `<div class="e" style="--i:${Math.min(i, 14)}">
  <span class="tg tg--${esc(e.source)}">${esc(TAG[e.source] ?? e.source)}</span>
  <div class="e__t">${e.url ? `<a href="${esc(e.url)}" rel="noopener">${esc(e.title)}</a>` : esc(e.title)}</div>
  <time>${esc(hktStamp(e.ts))}</time>
</div>`;

const none = (m: string) => `<div class="nil">${m}</div>`;

const shortModel = (m: string) => String(m ?? '').split('/').pop() ?? '';
const VERDICT_CLS: Record<string, string> = { BUY: 'up', SELL: 'down', HOLD: 'flat' };

/**
 * The council's deliberation, showing the four-step rubric rather than just its output:
 * verified evidence, weighted votes, measured agreement, and any debate it triggered.
 */
function councilView(d: any): string {
  if (!d) return none('No council session yet. Runs automatically when a signal qualifies.');
  const specialists: any[] = d.specialists ?? [];
  const verdicts: any[] = d.verdicts ?? [];
  if (!verdicts.length) return none('Council met and reached no view. Doing nothing is a valid outcome.');

  const gate = d.rubric ?? { actMinAgreement: 0.6, actMinVotes: 2 };
  const session = `<div class="ses">
    <span class="ses__t">${esc(hktStamp(d.ts ?? d.date))}</span>
    <span class="ses__m">${specialists.map((a: any) =>
      `<i class="${a.ok ? 'on' : 'off'}" title="${esc(a.specialty)}">${esc(a.name ?? shortModel(a.model))}</i>`).join('')}</span>
    <span class="ses__g">acts at ${Math.round(gate.actMinAgreement * 100)}% agreement &amp; ${gate.actMinVotes}+ votes</span>
  </div>
`;

  const cards = verdicts.map((v: any, i: number) => {
    const shares = v.weightedShare ?? {};
    const tot = (v.opinions ?? []).reduce((a: number, o: any) => a + o.weight, 0) || 1;
    const bar = ['BUY', 'HOLD', 'SELL'].filter((k) => (shares[k] ?? 0) > 0.001)
      .map((k) => `<i class="sh sh--${VERDICT_CLS[k]}" style="width:${((shares[k] ?? 0) * 100).toFixed(1)}%" title="${k} ${(shares[k] * 100).toFixed(0)}%"></i>`).join('');

    const ops = (v.opinions ?? []).map((o: any) => `<div class="op">
      <div class="op__h">
        <span class="op__m">${esc(o.name)}</span>
        <span class="op__s">${esc(o.specialty)}</span>
        <span class="vb vb--${VERDICT_CLS[o.verdict] ?? 'flat'}">${esc(o.verdict)}</span>
        <span class="op__n">${o.confidence}/10 sure · verified ${(o.verified * 100).toFixed(0)}% · relevance ×${o.relevance} · <b>weight ${o.weight}</b>${o.revised ? ' · <em>revised</em>' : ''}</span>
      </div>
      <p>${esc(o.reasoning)}</p>
      ${(o.evidence ?? []).length ? `<ul class="evd">${o.evidence.map((e: string) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
      ${o.risk ? `<p class="cnt"><b>Counter-case:</b> ${esc(o.risk)}</p>` : ''}
    </div>`).join('');

    return `<details class="dl" style="--i:${Math.min(i, 14)}">
      <summary class="dl__h">
        <span class="tk">${esc(v.ticker)}</span>
        <span class="vb vb--${VERDICT_CLS[v.action] ?? 'flat'}">${esc(v.action)}</span>
        <span class="dl__v">${(v.agreement * 100).toFixed(0)}% agreement · ${v.votes} of ${(v.opinions ?? []).length}</span>
        ${v.panel != null && v.panel < 3 ? `<span class="dbt" style="border-color:rgba(246,70,93,.4);background:rgba(246,70,93,.12);color:var(--dn)">PANEL ${v.panel}/4</span>` : ''}
        ${v.debated ? '<span class="dbt">DEBATED</span>' : ''}
        <span class="pl pl--${v.invest ? 'up' : 'flat'}">${v.invest ? 'BOUGHT' : 'NO TRADE'}</span>
      </summary>
      <div class="shb">${bar}</div>
      <div class="sum">${['BUY', 'HOLD', 'SELL'].filter((k) => (shares[k] ?? 0) > 0.001).map((k) => {
        const w = (v.opinions ?? []).filter((o: any) => o.verdict === k).reduce((a: number, o: any) => a + o.weight, 0);
        return `<span><b class="${VERDICT_CLS[k]}">${k}</b> ${w.toFixed(2)} / ${tot.toFixed(2)} = ${((shares[k] ?? 0) * 100).toFixed(0)}%</span>`;
      }).join('')}<span class="sum__d">step 4: ${(v.agreement * 100).toFixed(0)}% vs 75% bar &rarr; ${v.debated ? 'debated, re-voted' : 'no debate'}</span></div>
      <div class="ops">${ops}</div>
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
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60">
<style>
:root{--bg:#0a0b0d;--pn:#121419;--pn2:#171a21;--ln:#1f2430;--fg:#eaecef;--mu:#767f8c;--dm:#4d5561;
--up:#0ecb81;--dn:#f6465d;--ft:#767f8c;--am:#f0b90b;--ac:#4a8cff;
--mo:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
--sa:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 var(--sa);-webkit-font-smoothing:antialiased}
main{max-width:1020px;margin:0 auto;padding:0 12px 56px}
a{color:inherit;text-decoration:none}

.bar{position:sticky;top:0;z-index:9;display:flex;align-items:center;gap:9px;padding:13px 2px;
background:rgba(10,11,13,.9);backdrop-filter:blur(12px);border-bottom:1px solid var(--ln)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--up);animation:pl 2s infinite}
@keyframes pl{0%,100%{box-shadow:0 0 0 0 rgba(14,203,129,.5)}50%{box-shadow:0 0 0 5px rgba(14,203,129,0)}}
.bar b{font-size:13.5px;font-weight:680;letter-spacing:.04em}
.bar time{margin-left:auto;font:11.5px var(--mo);color:var(--mu);font-variant-numeric:tabular-nums}
.lv{font-style:normal;font-size:9px;font-weight:700;letter-spacing:.08em;color:#fff;
background:var(--up);padding:2px 5px;border-radius:3px;margin-right:5px}

.kpi{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--ln);
border-bottom:1px solid var(--ln);margin:0 -12px 0}
.kpi>div{background:var(--bg);padding:13px 8px;text-align:center}
.kpi b{display:block;font:600 20px var(--mo);font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.kpi span{font-size:10px;color:var(--mu);letter-spacing:.04em;text-transform:uppercase;margin-top:2px;display:block}
.kpi .wait b{color:var(--am)} .kpi .up b{color:var(--up)} .kpi .down b{color:var(--dn)}

input[name=tab],input[name=stk]{position:absolute;width:0;height:0;opacity:0;pointer-events:none}
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

.grid{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--ln);
border-top:1px solid var(--ln);border-bottom:1px solid var(--ln)}
.hd,.r{background:var(--bg);display:grid;grid-template-columns:minmax(84px,33%) minmax(48px,1fr) auto 72px;gap:10px;align-items:center}
.hd{padding:8px 12px;font-size:9.5px;color:var(--dm);letter-spacing:.06em;text-transform:uppercase}
.hd span:nth-child(3),.hd span:nth-child(4){text-align:right}
.r{padding:11px 12px;animation:up .4s both;animation-delay:calc(var(--i)*30ms)}
.r:hover{background:var(--pn)}
@keyframes up{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
.r__n{min-width:0;overflow:hidden}
.tk{font-weight:700;font-size:14.5px;letter-spacing:-.01em;display:flex;align-items:center;gap:5px}
.sb{color:var(--mu);font-size:11px;display:block;margin-top:1px;overflow:hidden;
text-overflow:ellipsis;white-space:nowrap}
.ins{width:5px;height:5px;border-radius:50%;background:var(--am);display:inline-block}
.auto{font:9px var(--mo);font-style:normal;background:var(--ac);color:#fff;padding:1px 4px;border-radius:3px;letter-spacing:.04em}
.r__p{text-align:right}
.px{font:14px var(--mo);font-variant-numeric:tabular-nums}
.pl{font:600 12.5px var(--mo);text-align:center;padding:6px 0;border-radius:5px;color:#fff;font-variant-numeric:tabular-nums}
.pl--up{background:var(--up)}.pl--down{background:var(--dn)}.pl--flat{background:#333a46}
.sp{width:100%;height:26px;display:block}
.sp--none{display:block;height:26px;background:repeating-linear-gradient(90deg,var(--ln) 0 1px,transparent 1px 5px);opacity:.35;border-radius:2px}
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
.dl__h{display:flex;flex-wrap:wrap;gap:9px;align-items:center;
padding:11px 12px;cursor:pointer;list-style:none}
.dl__h .dl__v{margin-left:auto}
.dl__h .pl{flex:none;min-width:74px;text-align:center}
.dl__h::after{content:'+';font:12px var(--mo);color:var(--dm);width:12px;text-align:center}
.dl[open] .dl__h::after{content:'−'}
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
.fml{padding:8px 12px;border-top:1px solid var(--ln);font:10.5px var(--mo);color:var(--dm);
display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center;background:var(--pn)}
.fml b{color:var(--ac);font-weight:700}
.fml code{color:var(--mu);margin-left:auto;font-size:10px}
.sum{display:flex;flex-wrap:wrap;gap:14px;padding:0 12px 9px;font:10.5px var(--mo);color:var(--mu)}
.sum b{font-weight:700}
.sum__d{margin-left:auto;color:var(--dm)}
.vb{font:700 9.5px var(--mo);letter-spacing:.06em;padding:3px 6px;border-radius:4px;color:#fff}
.vb--up{background:var(--up)}.vb--down{background:var(--dn)}.vb--flat{background:#39404d}
.dbt{font:700 9px var(--mo);letter-spacing:.07em;padding:3px 6px;border-radius:4px;
background:rgba(240,185,11,.15);color:var(--am);border:1px solid rgba(240,185,11,.35)}
.shb{display:flex;height:4px;gap:1px;margin:0 12px 8px}
.sh{display:block;border-radius:2px}
.sh--up{background:var(--up)}.sh--down{background:var(--dn)}.sh--flat{background:#39404d}
.op__h{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin-bottom:5px}
.op__s{font-size:10.5px;color:var(--dm)}
.op__n{font:10px var(--mo);color:var(--mu);margin-left:auto}
.op__n b{color:var(--fg)}.op__n em{color:var(--am);font-style:normal}
.evd{margin:6px 0 0;padding-left:15px;font-size:11.5px;color:var(--mu)}
.evd li{margin:2px 0}
.cnt{margin:6px 0 0;font-size:11.5px;color:var(--dm)}
.cnt b{color:var(--mu);font-weight:600}
.nil{padding:44px 16px;text-align:center;color:var(--dm);font-size:12.5px;border-top:1px solid var(--ln)}
footer{margin-top:26px;padding-top:14px;border-top:1px solid var(--ln);color:var(--dm);font-size:10.5px;line-height:1.6}
footer a{border-bottom:1px solid var(--ln)}
.split{display:grid;grid-template-columns:270px 1fr;align-items:start;border-top:1px solid var(--ln)}
.wl{background:var(--bg);border-right:1px solid var(--ln);max-height:calc(100vh - 60px);
overflow-y:auto;overscroll-behavior:contain;position:sticky;top:52px}
.wr{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;padding:9px 10px 9px 8px;
border-bottom:1px solid var(--ln);cursor:pointer;border-left:2px solid transparent}
.wr:hover{background:var(--pn)}
.wr__l{min-width:0;overflow:hidden}
.wr__r{display:grid;gap:3px;justify-items:end}
.wr .px{font-size:12.5px}
.wr .pl{font-size:10.5px;padding:3px 6px;min-width:58px}
.dt{background:var(--bg);padding:0 16px 26px;min-width:0}
.dp{display:none}
${quotes.map((_, i) => `#k${i}:checked~.split .dp${i}{display:block}#k${i}:checked~.split label[for=k${i}]{background:var(--pn2);border-left-color:var(--ac)}`).join('')}
${DETAIL_CSS}
@media(max-width:860px){.split{grid-template-columns:1fr}.wl{max-height:42vh;position:static;border-right:0;border-bottom:1px solid var(--ln)}.dt{padding:0 10px 26px}}
@media(max-width:760px){
.grid{grid-template-columns:1fr}
.hd:nth-of-type(2){display:none}
}
@media(max-width:560px){
.hd,.r{grid-template-columns:1fr auto 70px}
.sp,.hd span:nth-child(2){display:none}
.kpi b{font-size:17px}
}
</style>

<main>
<div class="bar"><span class="dot"></span><b>AI STOCK COUNCIL</b>
<time>${pricesLive ? '<i class="lv">LIVE</i> ' : ''}${esc(hktFull(quotesFile.updated ?? new Date().toISOString()))} HKT</time></div>

<div class="kpi">
  <div><b>${money(pf.equity)}</b><span>portfolio</span></div>
  <div class="${dir(pf.totalReturnPct)}"><b>${sign(pf.totalReturnPct)}</b><span>total return</span></div>
  <div><b>${pf.openPositions}</b><span>open positions</span></div>
  <div class="${verdictTone}"><b>${verdictText}</b><span>verdict</span></div>
</div>

<input type="radio" name="tab" id="t1" checked><input type="radio" name="tab" id="t2"><input type="radio" name="tab" id="t3"><input type="radio" name="tab" id="t4">
<nav class="tabs">
  <label for="t1">Watchlist<i>${quotes.length}</i></label>
  <label for="t4">Council<i>${(deliberation?.verdicts ?? []).length}</i></label>
  <label for="t2">AI Trades<i>${trades.length}</i></label>
  <label for="t3">Signals<i>${eventLog.length}</i></label>
</nav>

<div class="panes">
  <div class="pane p1">
    ${quotes.length ? `${quotes.map((_, i) => `<input type="radio" name="stk" id="k${i}"${i === 0 ? ' checked' : ''}>`).join('')}
    <div class="split">
      <aside class="wl">${quotes.map(sideRow).join('')}</aside>
      <div class="dt">${quotes.map((q, i) => `<div class="dp dp${i}">${detailPanel(q)}</div>`).join('')}</div>
    </div>` : none('Run npm&nbsp;run&nbsp;screen')}
  </div>

  <div class="pane p2">
    ${trades.length ? `<div class="grid">${
      '<div class="hd"><span>Symbol</span><span>Trend</span><span>Price</span><span>vs S&amp;P</span></div>'.repeat(2)
    }${trades.map(tradeRow).join('')}</div>`
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
