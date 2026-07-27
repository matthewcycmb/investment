// Renders the public page from data/. Self-contained HTML, no external assets.
// Usage: node scripts/render.ts
import { readJSON, writeJSON, ROOT, tTestNaive, tTestClustered } from './lib.ts';
import { writeFileSync, mkdirSync } from 'node:fs';

const N_TARGET = 100;
// Public repo URL, used for the audit-trail links. Set REPO_URL in CI/Vercel env.
const REPO = (process.env.REPO_URL ?? '').replace(/\/$/, '');
const outcomes = readJSON<any>(`${ROOT}data/outcomes.json`, { positions: [], counts: { closed: 0, open: 0, pending: 0 } });
const positions: any[] = outcomes.positions ?? [];

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const pctStr = (x: number | null | undefined) =>
  x == null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;
const cls = (x: number | null | undefined) => (x == null ? '' : x >= 0 ? 'pos' : 'neg');

const closedOf = (arm: string) =>
  positions.filter((p) => p.arm === arm && p.status === 'closed')
    .sort((a, b) => a.exitDate.localeCompare(b.exitDate) || a.ticker.localeCompare(b.ticker));

const council = closedOf('council');
const n = council.length;
const evaluated = n >= N_TARGET;

// The primary test is computed on exactly the first N_TARGET closed council picks,
// so it cannot drift as more data arrives after the evaluation point.
const testSet = council.slice(0, N_TARGET);
const xs = testSet.map((p) => p.excess);
const wk = testSet.map((p) => p.weekKey);
const naive = xs.length > 1 ? tTestNaive(xs) : null;
const clustered = xs.length > 1 && new Set(wk).size > 1 ? tTestClustered(xs, wk) : null;

// ---------- running-mean chart ----------

function chart(series: number[]): string {
  if (series.length < 2) return '<p class="muted">Chart appears once at least two picks have closed.</p>';
  const W = 720, H = 220, PAD = 34;
  const running: number[] = [];
  let sum = 0;
  series.forEach((v, i) => { sum += v; running.push(sum / (i + 1)); });
  const lo = Math.min(0, ...running), hi = Math.max(0, ...running);
  const span = hi - lo || 0.01;
  const x = (i: number) => PAD + (i / Math.max(1, running.length - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - lo) / span) * (H - PAD * 2);
  const pts = running.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const zero = y(0).toFixed(1);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Running mean excess return versus SPY">
  <line x1="${PAD}" y1="${zero}" x2="${W - PAD}" y2="${zero}" class="axis"/>
  <text x="${PAD - 6}" y="${zero}" class="tick" text-anchor="end" dominant-baseline="middle">0</text>
  <text x="${PAD - 6}" y="${y(hi)}" class="tick" text-anchor="end" dominant-baseline="middle">${(hi * 100).toFixed(1)}%</text>
  <text x="${PAD - 6}" y="${y(lo)}" class="tick" text-anchor="end" dominant-baseline="middle">${(lo * 100).toFixed(1)}%</text>
  <polyline points="${pts}" class="line"/>
  <text x="${W / 2}" y="${H - 6}" class="tick" text-anchor="middle">closed picks (1 → ${running.length})</text>
</svg>`;
}

// ---------- tables ----------

const positionRows = (rows: any[]) => rows.length === 0
  ? '<tr><td colspan="7" class="muted">No positions yet.</td></tr>'
  : rows.map((p) => `<tr>
      <td>${esc(p.pickDate)}</td>
      <td class="tk">${esc(p.ticker)}</td>
      <td>${esc(p.entryDate ?? '—')}</td>
      <td>${p.entryPrice ? p.entryPrice.toFixed(2) : '—'}</td>
      <td>${p.exitPrice ? p.exitPrice.toFixed(2) : '—'}</td>
      <td class="${cls(p.ret)}">${pctStr(p.ret)}</td>
      <td class="${cls(p.excess ?? p.markExcess)}"><strong>${pctStr(p.excess ?? p.markExcess)}</strong>${p.status !== 'closed' ? ' <span class="muted">(open)</span>' : ''}</td>
    </tr>`).join('');

const armSummary = ['A', 'B', 'C'].map((arm) => {
  const rows = closedOf(arm);
  const t = rows.length > 1 ? tTestNaive(rows.map((r) => r.excess)) : null;
  const hits = rows.filter((r) => r.excess > 0).length;
  return { arm, n: rows.length, mean: t?.mean ?? null, hit: rows.length ? hits / rows.length : null };
});
const councilSummary = { arm: 'Council', n, mean: naive?.mean ?? null, hit: n ? council.filter((r) => r.excess > 0).length / n : null };

const allCouncil = positions
  .filter((p) => p.arm === 'council' && p.status !== 'pending')
  .sort((a, b) => b.pickDate.localeCompare(a.pickDate) || a.rank - b.rank);

const html = `<title>AI Stock Council — Pre-Registered Forward Test</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#16181d; --mut:#6b7280; --line:#e5e7eb; --card:#f7f8fa; --pos:#0a7f4f; --neg:#c0392b; --accent:#2563eb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --fg:#e6e8ec; --mut:#9aa1ab; --line:#262a33; --card:#171a21; --pos:#3ddc91; --neg:#ff6b5e; --accent:#7aa2ff; } }
  :root[data-theme="dark"] { --bg:#0f1115; --fg:#e6e8ec; --mut:#9aa1ab; --line:#262a33; --card:#171a21; --pos:#3ddc91; --neg:#ff6b5e; --accent:#7aa2ff; }
  :root[data-theme="light"] { --bg:#fff; --fg:#16181d; --mut:#6b7280; --line:#e5e7eb; --card:#f7f8fa; --pos:#0a7f4f; --neg:#c0392b; --accent:#2563eb; }
  body { background:var(--bg); color:var(--fg); font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; margin:0; padding:2rem 1.25rem 4rem; }
  main { max-width:940px; margin:0 auto; }
  h1 { font-size:1.75rem; line-height:1.25; margin:0 0 .35rem; letter-spacing:-.02em; }
  h2 { font-size:1.15rem; margin:2.5rem 0 .75rem; letter-spacing:-.01em; }
  .sub { color:var(--mut); margin:0 0 2rem; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:1.1rem 1.25rem; margin:1rem 0; }
  .verdict { font-size:1.05rem; font-weight:600; }
  .muted { color:var(--mut); }
  .pos { color:var(--pos); } .neg { color:var(--neg); }
  .scroll { overflow-x:auto; -webkit-overflow-scrolling:touch; }
  table { border-collapse:collapse; width:100%; font-size:.9rem; min-width:620px; }
  th,td { text-align:left; padding:.5rem .6rem; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { font-weight:600; color:var(--mut); font-size:.8rem; text-transform:uppercase; letter-spacing:.04em; }
  .tk { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-weight:600; }
  svg { width:100%; height:auto; display:block; }
  .line { fill:none; stroke:var(--accent); stroke-width:2; }
  .axis { stroke:var(--mut); stroke-dasharray:3 3; stroke-width:1; }
  .tick { fill:var(--mut); font-size:11px; }
  .bar { height:8px; background:var(--line); border-radius:99px; overflow:hidden; margin-top:.6rem; }
  .bar > i { display:block; height:100%; background:var(--accent); }
  a { color:var(--accent); }
  footer { margin-top:3rem; padding-top:1.25rem; border-top:1px solid var(--line); color:var(--mut); font-size:.85rem; }
</style>

<main>
<h1>Can an LLM council beat the S&amp;P 500?</h1>
<p class="sub">A pre-registered, forward-only experiment. Every pick is timestamped in public git before its outcome exists.
Positions are simulated. <strong>Losing picks are shown alongside winning ones.</strong></p>

<div class="card">
  <div class="verdict">${evaluated
    ? `Primary test: mean excess return ${pctStr(clustered?.mean ?? naive?.mean)} vs SPY — ${
        (clustered?.p ?? 1) < 0.05
          ? 'H₀ REJECTED at α=0.05 (week-clustered).'
          : 'FAILED to reject H₀. No demonstrated edge.'}`
    : `Primary test: NOT YET EVALUATED — evaluates once at ${N_TARGET} closed council picks.`}</div>
  <div class="bar"><i style="width:${Math.min(100, (n / N_TARGET) * 100).toFixed(1)}%"></i></div>
  <p class="muted" style="margin:.5rem 0 0">${n} / ${N_TARGET} closed council picks
    · ${outcomes.counts?.open ?? 0} open · updated ${esc((outcomes.updated ?? '').slice(0, 10) || '—')}</p>
  ${n > 1 ? `<p class="muted" style="margin:.5rem 0 0">Interim only, not a result:
    mean ${pctStr(naive?.mean)} · naive p=${naive?.p?.toFixed(4) ?? '—'} · week-clustered p=${clustered?.p?.toFixed(4) ?? '—'}
    ${!evaluated ? '<strong>These are not evidence until n=100.</strong>' : ''}</p>` : ''}
</div>

<h2>Running mean excess return vs SPY</h2>
${chart(council.map((p) => p.excess))}

<h2>Council picks</h2>
<div class="scroll"><table>
<thead><tr><th>Picked</th><th>Ticker</th><th>Entry</th><th>Entry $</th><th>Exit $</th><th>Return</th><th>vs SPY</th></tr></thead>
<tbody>${positionRows(allCouncil)}</tbody>
</table></div>

<h2>Exploratory <span class="muted" style="font-weight:400;font-size:.85rem">— cannot be used to claim success</span></h2>
<div class="card">
<p class="muted" style="margin-top:0">These measures were declared exploratory before any data existed. Whatever they show,
only the primary test above can support a claim. Arm A is the pre-declared single-model control.</p>
<div class="scroll"><table>
<thead><tr><th>Arm</th><th>Closed</th><th>Mean excess</th><th>Hit rate</th></tr></thead>
<tbody>
${[councilSummary, ...armSummary].map((s) => `<tr>
  <td class="tk">${esc(s.arm)}${s.arm === 'A' ? ' <span class="muted">(control)</span>' : ''}</td>
  <td>${s.n}</td>
  <td class="${cls(s.mean)}">${pctStr(s.mean)}</td>
  <td>${s.hit == null ? '—' : (s.hit * 100).toFixed(0) + '%'}</td>
</tr>`).join('')}
</tbody></table></div>
</div>

<footer>
<p><strong>Simulated positions only.</strong> No money is invested, no orders are placed, no brokerage account is
involved, and no funds are accepted from anyone. Nothing here is investment advice.</p>
<p>Method, hypothesis, and failure commitment are fixed in ${REPO
  ? `<a href="${esc(REPO)}/blob/main/PREREGISTRATION.md">PREREGISTRATION.md</a>`
  : '<code>PREREGISTRATION.md</code>'}, committed before any pick-generating code existed.
${REPO ? `The <a href="${esc(REPO)}/commits/main/data/picks">commit history of every pick</a> is the audit trail.`
       : 'The git history is the audit trail.'}</p>
</footer>
</main>
`;

mkdirSync(`${ROOT}public`, { recursive: true });
writeFileSync(`${ROOT}public/index.html`, html);

// Machine-readable mirror of the headline numbers.
writeJSON(`${ROOT}data/summary.json`, {
  updated: new Date().toISOString(),
  nClosedCouncil: n, nTarget: N_TARGET, evaluated,
  primary: evaluated ? { naive, clustered } : null,
  interim: evaluated ? null : { naive, clustered, note: 'NOT a result; the test evaluates once at n=100' },
});

console.log(`rendered public/index.html — ${n}/${N_TARGET} closed council picks${evaluated ? ' (EVALUATED)' : ''}`);
