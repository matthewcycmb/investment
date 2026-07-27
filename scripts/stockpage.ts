// Per-stock detail pages -> public/s/<TICKER>.html
// Only real data: price, ranges, candlesticks, moving averages, RSI, the council's
// verdict on this stock, and its actual SEC Form 4 filings. Nothing is estimated.
// Usage: node scripts/stockpage.ts
import { readJSON, ROOT, lsJSON } from './lib.ts';
import { writeFileSync, mkdirSync } from 'node:fs';

const TZ = 'Asia/Hong_Kong';
const REPO = (process.env.REPO_URL ?? 'https://github.com/matthewcycmb/investment').replace(/\/$/, '');

const quotes: any[] = readJSON<any>(`${ROOT}data/quotes.json`, { quotes: [] }).quotes ?? [];
const eventLog: any[] = readJSON<any>(`${ROOT}data/events.json`, { events: [] }).events ?? [];
const positions: any[] = readJSON<any>(`${ROOT}data/outcomes.json`, { positions: [] }).positions ?? [];

const liveFile = lsJSON(`${ROOT}data/live`).pop();
const studyFile = lsJSON(`${ROOT}data/picks`).pop();
const deliberation: any = liveFile
  ? readJSON<any>(`${ROOT}data/live/${liveFile}`, null)
  : (studyFile ? readJSON<any>(`${ROOT}data/picks/${studyFile}`, null) : null);

const esc = (s: unknown) => String(s ?? '')
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const hkt = (iso: string) => {
  const d = new Date(iso);
  return isNaN(+d) ? '·' : d.toLocaleString('en-GB', { timeZone: TZ, hour12: false, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const num = (x: any, dp = 2) => (x == null || isNaN(x) ? '·' : Number(x).toFixed(dp));
const sign = (x: any, dp = 2) => (x == null || isNaN(x) ? '·' : `${x >= 0 ? '+' : ''}${Number(x).toFixed(dp)}%`);
const dir = (x: any) => (x == null || isNaN(x) ? 'flat' : x > 0 ? 'up' : x < 0 ? 'down' : 'flat');
const vol = (v: number) => (v == null ? '·' : v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(v));
const shortModel = (m: string) => String(m ?? '').split('/').pop() ?? '';

// ---------- candlestick + volume chart ----------

function candles(bars: any[], ma: any): string {
  if (!bars || bars.length < 2) return '<div class="nil">No chart data</div>';
  const W = 900, PH = 250, VH = 60, GAP = 14, H = PH + GAP + VH;
  const hi = Math.max(...bars.map((b) => b.h)), lo = Math.min(...bars.map((b) => b.l));
  const pad = (hi - lo) * 0.06 || 1;
  const top = hi + pad, bot = lo - pad;
  const y = (v: number) => ((top - v) / (top - bot)) * PH;
  const step = W / bars.length, bw = Math.max(2, step * 0.62);
  const maxV = Math.max(...bars.map((b) => b.v || 0)) || 1;

  const sticks = bars.map((b, i) => {
    const x = i * step + step / 2;
    const up = b.c >= b.o;
    const yO = y(b.o), yC = y(b.c);
    const bh = Math.max(1, Math.abs(yC - yO));
    return `<line class="wk ${up ? 'u' : 'd'}" x1="${x.toFixed(1)}" y1="${y(b.h).toFixed(1)}" x2="${x.toFixed(1)}" y2="${y(b.l).toFixed(1)}"/>` +
      `<rect class="bd ${up ? 'u' : 'd'}" x="${(x - bw / 2).toFixed(1)}" y="${Math.min(yO, yC).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}"/>`;
  }).join('');

  const vols = bars.map((b, i) => {
    const x = i * step + step / 2, h = ((b.v || 0) / maxV) * VH;
    return `<rect class="vb ${b.c >= b.o ? 'u' : 'd'}" x="${(x - bw / 2).toFixed(1)}" y="${(PH + GAP + VH - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}"/>`;
  }).join('');

  const line = (series: (number | null)[], cls: string) => {
    const pts = series.map((v, i) => (v == null ? null : `${(i * step + step / 2).toFixed(1)},${y(v).toFixed(1)}`))
      .filter(Boolean).join(' ');
    return pts ? `<polyline class="ma ${cls}" points="${pts}"/>` : '';
  };

  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = top - (top - bot) * f;
    return `<line class="gl" x1="0" y1="${(f * PH).toFixed(1)}" x2="${W}" y2="${(f * PH).toFixed(1)}"/>` +
      `<text class="gt" x="4" y="${(f * PH + 10).toFixed(1)}">${v.toFixed(1)}</text>`;
  }).join('');

  return `<svg class="ck" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Candlestick chart">
${grid}${sticks}${line(ma?.ma5 ?? [], 'm5')}${line(ma?.ma10 ?? [], 'm10')}${line(ma?.ma20 ?? [], 'm20')}${vols}</svg>`;
}

// ---------- page ----------

function page(q: any): string {
  const d = dir(q.changePct);
  const chg = q.last != null && q.prevClose != null ? q.last - q.prevClose : null;

  const stat = (k: string, v: string, cls = '') => `<div class="s"><span>${k}</span><b class="${cls}">${v}</b></div>`;

  const stats = [
    stat('Open', num(q.open)),
    stat('Prev close', num(q.prevClose)),
    stat('Day high', num(q.dayHigh), 'up'),
    stat('Day low', num(q.dayLow), 'down'),
    stat('Volume', vol(q.volume)),
    stat('Day range', sign(q.amplitude)),
    stat('52w high', num(q.w52High)),
    stat('52w low', num(q.w52Low)),
    stat('1 month', sign(q.ret1m), dir(q.ret1m)),
    stat('3 months', sign(q.ret3m), dir(q.ret3m)),
    stat('1 year', sign(q.ret1y), dir(q.ret1y)),
    stat('RSI 14', num(q.rsi14, 1), q.rsi14 > 70 ? 'down' : q.rsi14 < 30 ? 'up' : ''),
  ].join('');

  // Where the price sits inside its 52-week range.
  const pos = q.rangePos == null ? '' : `<div class="rng">
    <div class="rng__b"><i style="left:${Math.max(0, Math.min(100, q.rangePos)).toFixed(1)}%"></i></div>
    <div class="rng__l"><span>${num(q.w52Low)}</span><b>${q.rangePos.toFixed(0)}% of 52w range</b><span>${num(q.w52High)}</span></div>
  </div>`;

  // Council verdict on this specific stock.
  const arms: any[] = deliberation?.arms ?? [];
  const cand = (deliberation?.councilAll ?? deliberation?.council ?? []).find((p: any) => p.ticker === q.ticker);
  const bought = new Set((deliberation?.council ?? []).map((p: any) => p.ticker)).has(q.ticker);
  const councilBlock = !deliberation
    ? `<div class="nil">The council has not met yet.</div>`
    : !cand
      ? `<div class="nil">No model selected ${esc(q.ticker)} in the last session.</div>`
      : `<div class="vd vd--${bought ? 'up' : 'flat'}">
          <span class="vd__v">${cand.votes}/${arms.filter((a) => a.ok).length || arms.length} models agree</span>
          <span class="vd__c">confidence ${cand.meanConfidence}</span>
          <span class="pl pl--${bought ? 'up' : 'flat'}">${bought ? 'BOUGHT' : 'PASSED'}</span>
        </div>` +
        arms.map((a) => {
          const t = (cand.theses ?? []).find((x: any) => x.arm === a.id);
          return `<div class="op ${t ? '' : 'op--no'}">
            <span class="op__m">${esc(shortModel(a.model))}</span>
            ${t ? `<span class="op__r">rank #${t.rank}</span><span class="op__c">${t.confidence}/10</span><p>${esc(t.thesis)}</p>`
                : `<span class="op__r">·</span><p>${a.ok ? 'Did not select this stock.' : 'Model unavailable.'}</p>`}
          </div>`;
        }).join('');

  // Real SEC Form 4 filings for this issuer.
  const insiders = (q.purchases ?? []).length
    ? `<table class="tb"><thead><tr><th>Insider</th><th>Date</th><th>Shares</th><th>Price</th></tr></thead><tbody>${
      q.purchases.slice(0, 12).map((p: any) => `<tr>
        <td>${esc((p.owners ?? [])[0] ?? '·')}</td><td>${esc(p.date)}</td>
        <td class="n">${Number(p.shares ?? 0).toLocaleString()}</td>
        <td class="n">${p.price ? `$${Number(p.price).toFixed(2)}` : '·'}</td></tr>`).join('')
    }</tbody></table>`
    : '<div class="nil">No officer or director bought on the open market in the last 35 days.</div>';

  const news = eventLog.filter((e) => (e.tickers ?? []).includes(q.ticker)).slice(0, 8);
  const newsBlock = news.length
    ? news.map((e) => `<div class="e"><span class="tg tg--${esc(e.source)}">${esc({ policy: 'GOV', filing: 'SEC', headline: 'NEWS', shock: 'MOVE' }[e.source as string] ?? e.source)}</span>
      <div>${e.url ? `<a href="${esc(e.url)}" rel="noopener">${esc(e.title)}</a>` : esc(e.title)}</div>
      <time>${esc(hkt(e.ts))}</time></div>`).join('')
    : '<div class="nil">No signals for this stock yet.</div>';

  const held = positions.filter((p) => p.ticker === q.ticker && p.status !== 'pending');

  return `<title>${esc(q.ticker)} · ${esc(q.name)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0a0b0d;--pn:#121419;--pn2:#171a21;--ln:#1f2430;--fg:#eaecef;--mu:#767f8c;--dm:#4d5561;
--up:#0ecb81;--dn:#f6465d;--am:#f0b90b;--ac:#4a8cff;
--mo:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
--sa:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 var(--sa);-webkit-font-smoothing:antialiased}
main{max-width:1020px;margin:0 auto;padding:0 12px 56px}
a{color:inherit;text-decoration:none}
.up{color:var(--up)}.down{color:var(--dn)}.flat{color:var(--mu)}

.bar{position:sticky;top:0;z-index:9;display:flex;align-items:center;gap:10px;padding:13px 2px;
background:rgba(10,11,13,.9);backdrop-filter:blur(12px);border-bottom:1px solid var(--ln)}
.bk{font:12px var(--mo);color:var(--mu);padding:3px 8px;border:1px solid var(--ln);border-radius:5px}
.bk:hover{color:var(--fg)}
.bar b{font-size:14px;letter-spacing:.02em}
.bar span{color:var(--mu);font-size:12px}
.bar time{margin-left:auto;font:11px var(--mo);color:var(--dm)}

.hero{padding:18px 2px 14px;border-bottom:1px solid var(--ln)}
.hero .p{font:700 38px var(--mo);letter-spacing:-.03em;font-variant-numeric:tabular-nums;line-height:1}
.hero .c{font:600 15px var(--mo);margin-top:6px;font-variant-numeric:tabular-nums}
.hero .as{font:11px var(--mo);color:var(--dm);margin-top:5px}

.rng{margin:14px 0 0}
.rng__b{position:relative;height:4px;border-radius:99px;background:linear-gradient(90deg,var(--dn),var(--am),var(--up));opacity:.55}
.rng__b i{position:absolute;top:-3px;width:2px;height:10px;background:var(--fg);border-radius:1px}
.rng__l{display:flex;justify-content:space-between;margin-top:5px;font:10.5px var(--mo);color:var(--dm)}
.rng__l b{color:var(--mu);font-weight:400}

.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--ln);
border-top:1px solid var(--ln);border-bottom:1px solid var(--ln);margin:0 -12px}
.s{background:var(--bg);padding:11px 12px}
.s span{display:block;font-size:10px;color:var(--dm);text-transform:uppercase;letter-spacing:.05em}
.s b{display:block;font:15px var(--mo);font-weight:500;font-variant-numeric:tabular-nums;margin-top:2px}

h2{font-size:14px;font-weight:680;margin:26px 0 4px;letter-spacing:.01em}
.hint{font-size:11.5px;color:var(--dm);margin:0 0 10px}

.ck{width:100%;height:auto;display:block;background:var(--pn);border:1px solid var(--ln);border-radius:10px}
.gl{stroke:var(--ln);stroke-width:1;vector-effect:non-scaling-stroke}
.gt{fill:var(--dm);font:10px var(--mo)}
.wk{stroke-width:1;vector-effect:non-scaling-stroke}
.wk.u,.bd.u{stroke:var(--up)}.wk.d,.bd.d{stroke:var(--dn)}
.bd.u{fill:var(--up)}.bd.d{fill:var(--dn)}
.vb.u{fill:var(--up);opacity:.4}.vb.d{fill:var(--dn);opacity:.4}
.ma{fill:none;stroke-width:1.4;vector-effect:non-scaling-stroke}
.m5{stroke:#f0b90b}.m10{stroke:#4a8cff}.m20{stroke:#c084fc}
.lg{display:flex;gap:14px;font:10.5px var(--mo);color:var(--mu);margin-top:7px;flex-wrap:wrap}
.lg i{display:inline-block;width:9px;height:2px;vertical-align:middle;margin-right:4px}

.vd{display:flex;align-items:center;gap:12px;padding:12px;background:var(--pn);
border:1px solid var(--ln);border-radius:10px;margin-bottom:1px}
.vd--up{border-color:rgba(14,203,129,.35)}
.vd__v{font:600 14px var(--mo)}.vd__c{font:12px var(--mo);color:var(--mu)}
.pl{margin-left:auto;font:600 11px var(--mo);padding:5px 10px;border-radius:5px;color:#fff}
.pl--up{background:var(--up)}.pl--flat{background:#333a46}
.op{background:var(--pn);border:1px solid var(--ln);border-top:0;padding:11px 12px}
.op--no{opacity:.4}
.op__m{font:600 10.5px var(--mo);color:var(--ac);letter-spacing:.03em}
.op__r{font:10.5px var(--mo);color:var(--mu);margin-left:8px}
.op__c{font:10.5px var(--mo);color:var(--am);margin-left:6px}
.op p{margin:5px 0 0;font-size:12.5px;line-height:1.5;color:var(--mu)}

.tb{width:100%;border-collapse:collapse;background:var(--pn);border:1px solid var(--ln);border-radius:10px;overflow:hidden}
.tb th{text-align:left;font-size:10px;color:var(--dm);text-transform:uppercase;letter-spacing:.05em;padding:8px 12px;border-bottom:1px solid var(--ln)}
.tb td{padding:9px 12px;font-size:12.5px;border-bottom:1px solid var(--ln)}
.tb tr:last-child td{border-bottom:0}
.tb .n{font-family:var(--mo);text-align:right;font-variant-numeric:tabular-nums}

.e{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:baseline;padding:10px 12px;
background:var(--pn);border:1px solid var(--ln);border-top:0;font-size:12.5px}
.e:first-of-type{border-top:1px solid var(--ln);border-radius:10px 10px 0 0}
.e time{font:10.5px var(--mo);color:var(--dm);white-space:nowrap}
.tg{font:700 9px var(--mo);letter-spacing:.06em;padding:3px 5px;border-radius:3px;color:#fff}
.tg--policy{background:#8b5cf6}.tg--filing{background:#3b82f6}
.tg--headline{background:#0ecb81}.tg--shock{background:#f6465d}
.nil{padding:22px 14px;text-align:center;color:var(--dm);font-size:12px;
background:var(--pn);border:1px solid var(--ln);border-radius:10px}
footer{margin-top:28px;padding-top:14px;border-top:1px solid var(--ln);color:var(--dm);font-size:10.5px;line-height:1.6}
@media(max-width:700px){.grid{grid-template-columns:repeat(2,1fr)}.hero .p{font-size:31px}}
</style>

<main>
<div class="bar"><a class="bk" href="../index.html">&lsaquo; Back</a>
<b>${esc(q.ticker)}</b><span>${esc(q.name)}</span>
<time>${esc(q.asOf ?? '')}</time></div>

<div class="hero">
  <div class="p ${d}">${num(q.last)}</div>
  <div class="c ${d}">${chg == null ? '·' : `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}`} &nbsp; ${sign(q.changePct)}</div>
  <div class="as">${esc(q.sector)} · close ${esc(q.asOf ?? '')} · USD</div>
  ${pos}
</div>

<div class="grid">${stats}</div>

<h2>Price history</h2>
<p class="hint">Daily candles, last ${(q.bars ?? []).length} sessions. Green = closed up, red = closed down. Volume below.</p>
${candles(q.bars, q.maSeries)}
<div class="lg"><span><i style="background:#f0b90b"></i>MA5 ${num(q.ma5)}</span>
<span><i style="background:#4a8cff"></i>MA10 ${num(q.ma10)}</span>
<span><i style="background:#c084fc"></i>MA20 ${num(q.ma20)}</span></div>

<h2>AI council verdict</h2>
<p class="hint">What each model said about this stock in the most recent session.</p>
${councilBlock}

<h2>Insider buying</h2>
<p class="hint">SEC Form 4 open-market purchases by officers and directors, last 35 days. Filed with the regulator, not estimated.</p>
${insiders}

<h2>Signals</h2>
<p class="hint">Events this system detected that involve ${esc(q.ticker)}.</p>
${newsBlock}

${held.length ? `<h2>Simulated position</h2>${held.map((p) => `<div class="vd">
  <span class="vd__v">${esc(p.entryDate ?? p.pickDate)}${p.exitDate ? ` to ${esc(p.exitDate)}` : ' · open'}</span>
  <span class="vd__c">entry ${num(p.entryPrice)}</span>
  <span class="pl pl--${dir(p.excess ?? p.markExcess)}">${sign((p.excess ?? p.markExcess) * 100)} vs S&amp;P</span>
</div>`).join('')}` : ''}

<footer>
Simulated positions only. No real money, no orders, no brokerage account. Not investment advice.
Prices from public market data, delayed. Insider filings from SEC EDGAR.
P/E, market cap, order-book depth and money-flow breakdowns are deliberately absent: they need paid
data feeds, and this project does not estimate numbers it cannot source.
<a href="${REPO}" rel="noopener" style="border-bottom:1px solid var(--ln)">Source</a> · times HKT.
</footer>
</main>
`;
}

mkdirSync(`${ROOT}public/s`, { recursive: true });
let count = 0;
for (const q of quotes) {
  if (q.last == null) continue;
  writeFileSync(`${ROOT}public/s/${q.ticker}.html`, page(q));
  count++;
}
console.log(`rendered ${count} stock pages -> public/s/`);
