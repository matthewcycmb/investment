// Per-stock detail pages -> public/s/<TICKER>.html
// Only real data: price, ranges, candlesticks, moving averages, RSI, the council's
// verdict on this stock, and its actual SEC Form 4 filings. Nothing is estimated.
// Usage: node scripts/stockpage.ts
import { readJSON, ROOT, lsJSON } from './lib.ts';
import { writeFileSync, mkdirSync } from 'node:fs';

const TZ = 'Asia/Hong_Kong';
const REPO = (process.env.REPO_URL ?? 'https://github.com/matthewcycmb/investment').replace(/\/$/, '');

const quotes: any[] = readJSON<any>(`${ROOT}data/quotes.json`, { quotes: [] }).quotes ?? [];
const chartFile = readJSON<any>(`${ROOT}data/charts.json`, { charts: {}, timeframes: [] });
const eventLog: any[] = readJSON<any>(`${ROOT}data/events.json`, { events: [] }).events ?? [];
const positions: any[] = readJSON<any>(`${ROOT}data/outcomes.json`, { positions: [] }).positions ?? [];

// Newest session that actually reached a verdict. A run where every specialist
// failed must not blank the Council tab and hide the last good deliberation.
const withVerdicts = (dir: string, files: string[]) => {
  for (const f of [...files].reverse()) {
    const d = readJSON<any>(`${ROOT}${dir}/${f}`, null);
    if ((d?.verdicts ?? []).length) return d;
  }
  return null;
};
const deliberation: any =
  withVerdicts('data/live', lsJSON(`${ROOT}data/live`))
  ?? withVerdicts('data/picks', lsJSON(`${ROOT}data/picks`));

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

/** Generic SVG polyline over a value series, skipping nulls. */
function line(vals: (number | null)[], W: number, H: number, lo: number, hi: number, cls: string): string {
  const span = (hi - lo) || 1;
  const pts = vals.map((v, i) => (v == null ? null
    : `${((i / Math.max(1, vals.length - 1)) * W).toFixed(1)},${(H - ((v - lo) / span) * H).toFixed(1)}`))
    .filter(Boolean).join(' ');
  return pts ? `<polyline class="${cls}" points="${pts}"/>` : '';
}

/** Price candles with moving averages, plus a volume strip underneath. */
function priceChart(tf: any): string {
  const b = tf.bars;
  if (!b || b.length < 2) return '<div class="nil">No data for this timeframe</div>';
  const W = 900, PH = 260, VH = 54, GAP = 10, H = PH + GAP + VH;
  const hi = Math.max(...b.map((x: any) => x.h)), lo = Math.min(...b.map((x: any) => x.l));
  const pad = (hi - lo) * 0.06 || 1, top = hi + pad, bot = lo - pad;
  const y = (v: number) => ((top - v) / (top - bot)) * PH;
  const step = W / b.length, bw = Math.max(1.5, step * 0.6);
  const maxV = Math.max(...b.map((x: any) => x.v || 0)) || 1;

  const sticks = b.map((x: any, i: number) => {
    const cx = i * step + step / 2, up = x.c >= x.o;
    const yO = y(x.o), yC = y(x.c);
    return `<line class="wk ${up ? 'u' : 'd'}" x1="${cx.toFixed(1)}" y1="${y(x.h).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y(x.l).toFixed(1)}"/>`
      + `<rect class="bd ${up ? 'u' : 'd'}" x="${(cx - bw / 2).toFixed(1)}" y="${Math.min(yO, yC).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(yC - yO)).toFixed(1)}"/>`;
  }).join('');

  const vols = b.map((x: any, i: number) => {
    const cx = i * step + step / 2, h = ((x.v || 0) / maxV) * VH;
    return `<rect class="vb ${x.c >= x.o ? 'u' : 'd'}" x="${(cx - bw / 2).toFixed(1)}" y="${(PH + GAP + VH - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}"/>`;
  }).join('');

  const ma = (vals: (number | null)[], cls: string) => {
    const pts = vals.map((v, i) => (v == null ? null
      : `${(i * step + step / 2).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean).join(' ');
    return pts ? `<polyline class="ma ${cls}" points="${pts}"/>` : '';
  };

  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) =>
    `<line class="gl" x1="0" y1="${(f * PH).toFixed(1)}" x2="${W}" y2="${(f * PH).toFixed(1)}"/>`
    + `<text class="gt" x="3" y="${(f * PH + 10).toFixed(1)}">${(top - (top - bot) * f).toFixed(2)}</text>`).join('');

  return `<svg class="ck" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Price chart">
${grid}${sticks}${ma(tf.ma.ma5, 'm5')}${ma(tf.ma.ma10, 'm10')}${ma(tf.ma.ma20, 'm20')}${ma(tf.ma.ma50, 'm50')}${vols}</svg>`;
}

/** MACD: histogram plus line and signal. */
function macdChart(tf: any): string {
  const { line: l, signal: sg, hist } = tf.macd;
  const all = [...l, ...sg, ...hist].filter((v: any) => v != null) as number[];
  if (!all.length) return '';
  const W = 900, H = 90;
  const hi = Math.max(...all, 0), lo = Math.min(...all, 0), span = (hi - lo) || 1;
  const zero = H - ((0 - lo) / span) * H;
  const step = W / hist.length, bw = Math.max(1, step * 0.6);
  const bars = hist.map((v: number | null, i: number) => {
    if (v == null) return '';
    const yv = H - ((v - lo) / span) * H;
    return `<rect class="mh ${v >= 0 ? 'u' : 'd'}" x="${(i * step + step / 2 - bw / 2).toFixed(1)}" y="${Math.min(yv, zero).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, Math.abs(zero - yv)).toFixed(1)}"/>`;
  }).join('');
  return `<svg class="ind" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="MACD">
<line class="gl" x1="0" y1="${zero.toFixed(1)}" x2="${W}" y2="${zero.toFixed(1)}"/>
${bars}${line(l, W, H, lo, hi, 'ma m5')}${line(sg, W, H, lo, hi, 'ma m10')}</svg>`;
}

/** KDJ: three lines, 20/80 reference bands. */
function kdjChart(tf: any): string {
  const { k, d, j } = tf.kdj;
  const all = [...k, ...d, ...j].filter((v: any) => v != null) as number[];
  if (!all.length) return '';
  const W = 900, H = 90, lo = Math.min(0, ...all), hi = Math.max(100, ...all);
  const band = (v: number) => `<line class="gl" x1="0" y1="${(H - ((v - lo) / (hi - lo)) * H).toFixed(1)}" x2="${W}" y2="${(H - ((v - lo) / (hi - lo)) * H).toFixed(1)}"/>`;
  return `<svg class="ind" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="KDJ">
${band(20)}${band(80)}${line(k, W, H, lo, hi, 'ma m5')}${line(d, W, H, lo, hi, 'ma m10')}${line(j, W, H, lo, hi, 'ma m20')}</svg>`;
}

/** RSI with 30/70 bands. */
function rsiChart(tf: any): string {
  const v = tf.rsi;
  if (!v?.some((x: any) => x != null)) return '';
  const W = 900, H = 70;
  const band = (n: number) => `<line class="gl" x1="0" y1="${(H - (n / 100) * H).toFixed(1)}" x2="${W}" y2="${(H - (n / 100) * H).toFixed(1)}"/>`;
  return `<svg class="ind" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="RSI">
${band(30)}${band(70)}${line(v, W, H, 0, 100, 'ma m20')}</svg>`;
}

/** Full chart block for one stock: 4 timeframes, CSS-switched, no JavaScript. */
export function chartBlock(ticker: string, charts: any, tfs: any[], priceOnly = false): string {
  if (!charts) return '<div class="nil">No chart data</div>';
  const avail = tfs.filter((t) => charts[t.id]?.bars?.length);
  if (!avail.length) return '<div class="nil">No chart data</div>';
  const nm = `tf_${ticker.replace(/\W/g, '')}`;

  const radios = avail.map((t, i) =>
    `<input type="radio" name="${nm}" id="${nm}_${t.id}"${i === (avail[1] ? 1 : 0) ? ' checked' : ''}>`).join('');
  const tabs = avail.map((t) => `<label for="${nm}_${t.id}">${t.label}</label>`).join('');
  const rules = avail.map((t) => `#${nm}_${t.id}:checked~.tfp .p_${t.id}{display:block}`
    + `#${nm}_${t.id}:checked~.tfb label[for=${nm}_${t.id}]{background:var(--pn2);color:var(--fg)}`).join('');

  const panes = avail.map((t) => {
    const tf = charts[t.id];
    const last = (a: (number | null)[]) => { const v = [...a].reverse().find((x) => x != null); return v == null ? '·' : v; };
    return `<div class="pane_tf p_${t.id}">
      <div class="lg"><span><i style="background:#f0b90b"></i>MA5 ${last(tf.ma.ma5)}</span>
      <span><i style="background:#4a8cff"></i>MA10 ${last(tf.ma.ma10)}</span>
      <span><i style="background:#c084fc"></i>MA20 ${last(tf.ma.ma20)}</span>
      <span><i style="background:#7d8794"></i>MA50 ${last(tf.ma.ma50)}</span></div>
      ${priceChart(tf)}
      ${priceOnly ? '' : `
      <div class="ilab">MACD (12,26,9) &nbsp; <b>${last(tf.macd.line)}</b> signal <b>${last(tf.macd.signal)}</b></div>
      ${macdChart(tf)}
      <div class="ilab">KDJ (9,3,3) &nbsp; K <b>${last(tf.kdj.k)}</b> D <b>${last(tf.kdj.d)}</b> J <b>${last(tf.kdj.j)}</b></div>
      ${kdjChart(tf)}
      <div class="ilab">RSI (14) &nbsp; <b>${last(tf.rsi)}</b> &nbsp;<span class="mut">above 70 overbought, below 30 oversold</span></div>
      ${rsiChart(tf)}`}
    </div>`;
  }).join('');

  return `<style>${rules}</style>${radios}${avail.length > 1 ? `<nav class="tfb">${tabs}</nav>` : ''}<div class="tfp">${panes}</div>`;
}

// ---------- shared detail fragment ----------

/** Price header, stats, chart, council verdict and insider filings for one stock. */
export function detailPanel(q: any, compact = false): string {
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

  // Council verdict on this specific stock, with the rubric shown.
  const vd = (deliberation?.verdicts ?? []).find((v: any) => v.ticker === q.ticker);
  const VC: Record<string, string> = { BUY: 'up', SELL: 'down', HOLD: 'flat' };
  const councilBlock = !deliberation
    ? '<div class="nil">The council has not met yet.</div>'
    : !vd
      ? `<div class="nil">No specialist formed a view on ${esc(q.ticker)} in the last session.</div>`
      : `<div class="vd vd--${vd.invest ? 'up' : 'flat'}">
          <span class="vd__v">${esc(vd.action)} · ${(vd.agreement * 100).toFixed(0)}% agreement</span>
          <span class="vd__c">${vd.votes} of ${(vd.opinions ?? []).length} · confidence ${vd.meanConfidence}${vd.debated ? ' · debated' : ''}</span>
          <span class="pl pl--${vd.invest ? 'up' : 'flat'}">${vd.invest ? 'BOUGHT' : 'NO TRADE'}</span>
        </div>` +
        (vd.opinions ?? []).map((o: any) => `<div class="op">
          <span class="op__m">${esc(o.name)}</span>
          <span class="op__r">${o.roleTitle ? `${esc(o.roleTitle)} · ` : ''}${esc(o.specialty)}</span>
          <span class="op__c">${esc(o.verdict)}, ${o.confidence}/10 sure · weight ${o.weight}</span>
          <p>${esc(o.reasoning)}</p>
          ${o.risk ? `<p style="opacity:.7">Counter-case: ${esc(o.risk)}</p>` : ''}
        </div>`).join('');

  // Real SEC Form 4 filings for this issuer.
  const insiders = (q.purchases ?? []).length
    ? `<table class="tb"><thead><tr><th>Insider</th><th>Date</th><th>Shares</th><th>Price</th></tr></thead><tbody>${
      q.purchases.slice(0, 12).map((p: any) => `<tr>
        <td>${esc((p.owners ?? [])[0] ?? '·')}</td><td>${esc(p.date)}</td>
        <td class="n">${Number(p.shares ?? 0).toLocaleString()}</td>
        <td class="n">${p.price ? `$${Number(p.price).toFixed(2)}` : '·'}</td></tr>`).join('')
    }</tbody></table>`
    : '<div class="nil">No officer or director bought on the open market in the last 35 days.</div>';

  const news = eventLog.filter((e) => (e.tickers ?? []).includes(q.ticker))
    .sort((a: any, b: any) => String(b.ts).localeCompare(String(a.ts))).slice(0, 8);
  const newsBlock = news.length
    ? news.map((e) => `<div class="e"><span class="tg tg--${esc(e.source)}">${esc({ policy: 'GOV', filing: 'SEC', headline: 'NEWS', shock: 'MOVE', insider: 'INSIDER' }[e.source as string] ?? e.source)}</span>
      <div>${e.url ? `<a href="${esc(e.url)}" rel="noopener">${esc(e.title)}</a>` : esc(e.title)}</div>
      <time>${esc(hkt(e.ts))}</time></div>`).join('')
    : '<div class="nil">No signals for this stock yet.</div>';

  const held = positions.filter((p) => p.ticker === q.ticker && p.status !== 'pending');

  return `
<div class="hero">
  <div class="p ${d}">${num(q.last)}</div>
  <div class="c ${d}">${chg == null ? '·' : `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}`} &nbsp; ${sign(q.changePct)}</div>
  <div class="as">${q.regime ? `<b class="rg rg--${esc(q.regime)}">${esc(q.regime)} TREND</b> · ` : ''}${esc(q.name)} · ${esc(q.sector)} · close ${esc(q.asOf ?? '')} · ${q.market === 'HK' ? 'HKD' : 'USD'}</div>
  ${pos}
</div>

<div class="grid">${stats}</div>

<h2>Price history</h2>
${compact
  ? `<p class="hint">Daily candles with moving averages and volume.</p>
     ${chartBlock(q.ticker, chartFile.charts?.[q.ticker], (chartFile.timeframes ?? []).filter((t: any) => t.id === '1d'), true)}
     <a class="more" href="s/${esc(q.ticker)}.html">Full chart: 1&nbsp;min · daily · weekly · monthly, with MACD, KDJ and RSI &rsaquo;</a>`
  : `<p class="hint">Candles with moving averages, volume, MACD, KDJ and RSI. Switch timeframe below.</p>
     ${chartBlock(q.ticker, chartFile.charts?.[q.ticker], chartFile.timeframes ?? [])}`}

<h2>AI council verdict</h2>
<p class="hint">What each model said about this stock in the most recent session.</p>
${councilBlock}

<h2>Insider buying</h2>
<p class="hint">${q.market === 'HK'
  ? 'Not available for HK-listed stocks. HKEX does not publish director dealings as structured data, so this signal is US-only.'
  : 'SEC Form 4 open-market purchases by officers and directors, last 35 days. Filed with the regulator, not estimated.'}</p>
${q.market === 'HK' ? '' : insiders}

<h2>Signals</h2>
<p class="hint">Events this system detected that involve ${esc(q.ticker)}.</p>
${newsBlock}

${held.length ? `<h2>Simulated position</h2>${held.map((p) => `<div class="vd">
  <span class="vd__v">${esc(p.entryDate ?? p.pickDate)}${p.exitDate ? ` to ${esc(p.exitDate)}` : ' · open'}</span>
  <span class="vd__c">entry ${num(p.entryPrice)}</span>
  <span class="pl pl--${dir(p.excess ?? p.markExcess)}">${sign((p.excess ?? p.markExcess) * 100)} vs S&amp;P</span>
</div>`).join('')}` : ''}`;
}

export const DETAIL_CSS = `
.dt .up{color:var(--up)}.dt .down{color:var(--dn)}.dt .flat{color:var(--mu)}
.dt .hero{padding:16px 0 12px;border-bottom:1px solid var(--ln)}
.dt .hero .p{font:700 34px var(--mo);letter-spacing:-.03em;font-variant-numeric:tabular-nums;line-height:1}
.dt .hero .c{font:600 14px var(--mo);margin-top:6px;font-variant-numeric:tabular-nums}
.dt .hero .as{font:11px var(--mo);color:var(--dm);margin-top:5px}
.dt .rg{font-weight:700;padding:1px 5px;border-radius:3px}
.dt .rg--BULL{background:rgba(14,203,129,.15);color:var(--up)}
.dt .rg--BEAR{background:rgba(246,70,93,.15);color:var(--dn)}
.dt .rg--RANGE{background:var(--ln);color:var(--mu)}
.dt .rng{margin:13px 0 0}
.dt .rng__b{position:relative;height:4px;border-radius:99px;background:linear-gradient(90deg,var(--dn),var(--am),var(--up));opacity:.55}
.dt .rng__b i{position:absolute;top:-3px;width:2px;height:10px;background:var(--fg);border-radius:1px}
.dt .rng__l{display:flex;justify-content:space-between;margin-top:5px;font:10.5px var(--mo);color:var(--dm)}
.dt .rng__l b{color:var(--mu);font-weight:400}
.dt .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--ln);
border-top:1px solid var(--ln);border-bottom:1px solid var(--ln);margin-top:14px}
.dt .s{background:var(--bg);padding:10px 11px}
.dt .s span{display:block;font-size:9.5px;color:var(--dm);text-transform:uppercase;letter-spacing:.05em}
.dt .s b{display:block;font:14px var(--mo);font-weight:500;font-variant-numeric:tabular-nums;margin-top:2px}
.dt h2{font-size:13.5px;font-weight:680;margin:22px 0 3px;letter-spacing:.01em}
.dt .hint{font-size:11px;color:var(--dm);margin:0 0 9px}
.dt .ck{width:100%;height:auto;display:block;background:var(--pn);border:1px solid var(--ln);border-radius:10px}
.dt .gl{stroke:var(--ln);stroke-width:1;vector-effect:non-scaling-stroke}
.dt .gt{fill:var(--dm);font:10px var(--mo)}
.dt .wk{stroke-width:1;vector-effect:non-scaling-stroke}
.dt .wk.u,.dt .bd.u{stroke:var(--up)}.dt .wk.d,.dt .bd.d{stroke:var(--dn)}
.dt .bd.u{fill:var(--up)}.dt .bd.d{fill:var(--dn)}
.dt .vb.u{fill:var(--up);opacity:.4}.dt .vb.d{fill:var(--dn);opacity:.4}
.dt .ma{fill:none;stroke-width:1.4;vector-effect:non-scaling-stroke}
.dt .m5{stroke:#f0b90b}.dt .m10{stroke:#4a8cff}.dt .m20{stroke:#c084fc}
.dt .tfb{display:flex;gap:2px;margin:0 0 8px;overflow-x:auto}
.dt .tfb label{flex:none;padding:5px 12px;border-radius:6px;font-size:12px;font-weight:600;
color:var(--mu);cursor:pointer;white-space:nowrap;user-select:none;border:1px solid var(--ln)}
.dt .tfb label:hover{color:var(--fg)}
.dt input[name^=tf_]{position:absolute;width:0;height:0;opacity:0;pointer-events:none}
.dt .pane_tf{display:none}
.dt .ind{width:100%;height:auto;display:block;background:var(--pn);
border:1px solid var(--ln);border-top:0;border-radius:0 0 8px 8px}
.dt .ilab{font:10.5px var(--mo);color:var(--mu);background:var(--pn);border:1px solid var(--ln);
border-bottom:0;border-radius:8px 8px 0 0;padding:6px 10px;margin-top:10px}
.dt .ilab b{color:var(--fg)} .dt .ilab .mut{color:var(--dm)}
.dt .mh.u{fill:var(--up)}.dt .mh.d{fill:var(--dn)}
.dt .m50{stroke:#7d8794}
.dt .more{display:block;margin-top:10px;padding:10px 12px;text-align:center;font-size:12.5px;
font-weight:600;color:var(--ac);background:var(--pn);border:1px solid var(--ln);border-radius:8px}
.dt .more:hover{background:var(--pn2)}
.dt .lg{display:flex;gap:14px;font:10.5px var(--mo);color:var(--mu);margin-top:7px;flex-wrap:wrap}
.dt .lg i{display:inline-block;width:9px;height:2px;vertical-align:middle;margin-right:4px}
.dt .vd{display:flex;align-items:center;gap:12px;padding:11px 12px;background:var(--pn);
border:1px solid var(--ln);border-radius:9px;margin-bottom:1px;flex-wrap:wrap}
.dt .vd--up{border-color:rgba(14,203,129,.35)}
.dt .vd__v{font:600 13px var(--mo)}.dt .vd__c{font:11.5px var(--mo);color:var(--mu)}
.dt .pl{margin-left:auto;font:600 10.5px var(--mo);padding:5px 9px;border-radius:5px;color:#fff}
.dt .pl--up{background:var(--up)}.dt .pl--down{background:var(--dn)}.dt .pl--flat{background:#333a46}
.dt .op{background:var(--pn);border:1px solid var(--ln);border-top:0;padding:10px 12px}
.dt .op--no{opacity:.4}
.dt .op__m{font:600 10.5px var(--mo);color:var(--ac);letter-spacing:.03em}
.dt .op__r{font:10.5px var(--mo);color:var(--mu);margin-left:8px}
.dt .op__c{font:10.5px var(--mo);color:var(--am);margin-left:6px}
.dt .op p{margin:5px 0 0;font-size:12px;line-height:1.5;color:var(--mu)}
.dt .tb{width:100%;border-collapse:collapse;background:var(--pn);border:1px solid var(--ln);border-radius:9px;overflow:hidden}
.dt .tb th{text-align:left;font-size:9.5px;color:var(--dm);text-transform:uppercase;letter-spacing:.05em;padding:8px 11px;border-bottom:1px solid var(--ln)}
.dt .tb td{padding:8px 11px;font-size:12px;border-bottom:1px solid var(--ln)}
.dt .tb tr:last-child td{border-bottom:0}
.dt .tb .n{font-family:var(--mo);text-align:right;font-variant-numeric:tabular-nums}
.dt .e{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:baseline;padding:9px 11px;
background:var(--pn);border:1px solid var(--ln);border-top:0;font-size:12px}
.dt .e:first-of-type{border-top:1px solid var(--ln);border-radius:9px 9px 0 0}
.dt .e time{font:10px var(--mo);color:var(--dm);white-space:nowrap}
.dt .tg{font:700 9px var(--mo);letter-spacing:.06em;padding:3px 5px;border-radius:3px;color:#fff}
.dt .tg--policy{background:#8b5cf6}.dt .tg--filing{background:#3b82f6}
.dt .tg--headline{background:#0ecb81}.dt .tg--shock{background:#f6465d}
.dt .tg--insider{background:#f0b90b;color:#000}
.dt .nil{padding:20px 14px;text-align:center;color:var(--dm);font-size:12px;
background:var(--pn);border:1px solid var(--ln);border-radius:9px}
@media(max-width:760px){.dt .grid{grid-template-columns:repeat(2,1fr)}.dt .hero .p{font-size:29px}}
`;

/** Base chrome used only by the standalone stock pages. */
const BASE_CSS = `
:root{--bg:#0a0b0d;--pn:#121419;--pn2:#171a21;--ln:#1f2430;--fg:#eaecef;--mu:#767f8c;--dm:#4d5561;
--up:#0ecb81;--dn:#f6465d;--am:#f0b90b;--ac:#4a8cff;
--mo:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
--sa:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 var(--sa);-webkit-font-smoothing:antialiased}
main{max-width:1020px;margin:0 auto;padding:0 12px 56px}
a{color:inherit;text-decoration:none}
.bar{position:sticky;top:0;z-index:9;display:flex;align-items:center;gap:10px;padding:13px 2px;
background:rgba(10,11,13,.9);backdrop-filter:blur(12px);border-bottom:1px solid var(--ln)}
.bk{font:12px var(--mo);color:var(--mu);padding:3px 8px;border:1px solid var(--ln);border-radius:5px}
.bk:hover{color:var(--fg)}
.bar b{font-size:14px;letter-spacing:.02em}.bar span{color:var(--mu);font-size:12px}
.bar time{margin-left:auto;font:11px var(--mo);color:var(--dm)}
footer{margin-top:26px;padding-top:14px;border-top:1px solid var(--ln);color:var(--dm);font-size:10.5px;line-height:1.6}
`;

/** Standalone page wrapper

/** Standalone page wrapper written to public/s/<TICKER>.html */
function page(q: any): string {
  return `<title>${esc(q.ticker)} · ${esc(q.name)}</title>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${BASE_CSS}${DETAIL_CSS}</style>
<main class="dt">
<div class="bar"><a class="bk" href="../index.html">&lsaquo; Back</a>
<b>${esc(q.ticker)}</b><span>${esc(q.name)}</span><time>${esc(q.asOf ?? '')}</time></div>
${detailPanel(q)}
<footer>
Simulated positions only. No real money, no orders, no brokerage account. Not investment advice.
Prices from public market data, delayed. Insider filings from SEC EDGAR.
P/E, market cap, order-book depth and money-flow breakdowns are deliberately absent: they need paid
data feeds, and this project does not estimate numbers it cannot source.
<a href="${REPO}" rel="noopener" style="border-bottom:1px solid var(--ln)">Source</a> · times HKT.
</footer>
</main>`;
}

// Only write files when run directly; render.ts imports detailPanel from here.
if (import.meta.filename === process.argv[1]) {
  mkdirSync(`${ROOT}public/s`, { recursive: true });
  let count = 0;
  for (const q of quotes) {
    if (q.last == null) continue;
    writeFileSync(`${ROOT}public/s/${q.ticker}.html`, page(q));
    count++;
  }
  console.log(`rendered ${count} stock pages -> public/s/`);
}
